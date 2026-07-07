// 数据库封装模块（双模式：JSON 文件存储 + SQLite）
// 本地开发（NODE_ENV !== 'production'）：JSON 文件存储，避免 better-sqlite3 原生编译依赖
// Docker 生产（NODE_ENV === 'production'）：better-sqlite3，高性能 SQLite 存储
// 两种模式对外接口完全一致
//
// Phase I: 批次级增量结果持久化
//   - 新增 task_results 表（SQLite）/ JSONL 文件（JSON 模式）
//   - 新增 appendTaskResults / getTaskResults 方法
//   - IO 异常隔离：写入失败仅记日志，不崩溃
//   - 容错读取：JSON.parse 失败跳过坏行，继续读后续行
//
// ⚠️ Phase 2-C 降级说明（任务主链路 PG 单写收敛）
//   本模块自 Phase 2-C 起从任务主链路降级为 legacy / fallback / 非主数据源：
//   - 任务创建：routes.ts 以 pgDb.insertTask 为 PRIMARY（失败→500），
//     db.createTask 仅作为 legacy mirror（best-effort try/catch）。
//   - 任务状态/计数：AssignmentEngine 以 pgDb.updateTaskStatus 为 PRIMARY（await），
//     db.updateTask 仅作为 legacy mirror。
//   - 任务日志：Engine 通过 pgDb.insertTaskLogs 为 PRIMARY，
//     taskLogManager.addLog 仅作为 legacy mirror。
//   - 运单结果：Engine 通过 pgDb.insertWaybillResults / upsertWaybillPool 为 PRIMARY，
//     db.appendTaskResults 仅作为 legacy mirror。
//   - 任务中心读取：统一走 PgDatabase（getTaskList / getTaskStats / getTaskLogs / getTaskWaybills），
//     不回退读取 JSON/SQLite。
//   本模块仍保留用于：窗口缓存（WindowInfo）、设置中心兼容、离线开发降级。
//   任务主链路不得依赖本模块写入成功；JSON/SQLite 写入失败不得掩盖 PG 写入失败。
import path from 'path';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';

// ── 类型定义 ──────────────────────────────────────────

// 窗口角色类型
export type WindowRole = 'admin' | 'staff';

// 网点标识
export type Site = 'tiannanda' | 'heyuan';

// 任务类型
export type TaskType = 'arrive' | 'dispatch' | 'sign' | 'integrated' | 'init_window';

// 任务状态
// Phase G-3: 新增 cancelled 状态，支持 Engine 层的超时取消机制
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

// 窗口信息接口
export interface WindowInfo {
  id: string;              // EasyBR browerid
  name: string;            // 窗口名称（如"天南大公司"/"天南大-张三"）
  cdp_port: number;        // CDP 调试端口
  role: WindowRole;        // admin / staff
  site: Site;              // tiannanda / heyuan
  staff_name: string | null; // 员工姓名（仅员工窗口）
  is_connected: number;    // 1=已连接 0=断线
  updated_at: string;      // 最后更新时间
}

/**
 * 任务接口（Step2 规格定义）
 *
 * Phase I: result_data 字段保留定义以保持向后兼容，
 * 但不再被 Engine 写入（结果改为增量追加到 task_results 表 / JSONL 文件）。
 */
export interface Task {
  id: string;
  type: string;
  site: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  total_count: number;
  done_count: number;
  fail_count: number;
  input_data?: string;
  result_data?: string;
  created_at: string;
  finished_at?: string;
}

// 向后兼容：TaskRecord = Task（旧代码使用 TaskRecord）
export type TaskRecord = Task;

// 单条操作结果（定义在 BaseOperation.ts 中，这里 re-export 保持兼容）
export type { OperationResult } from '../operations/BaseOperation';

// ── 环境判断 ──────────────────────────────────────────

// 生产环境使用 SQLite，开发环境使用 JSON 文件存储
const USE_SQLITE = process.env.NODE_ENV === 'production';

// ── JSON 存储结构 ─────────────────────────────────────

interface JsonStore {
  windows: WindowInfo[];
  tasks: Task[];
}

// ── Database 类（双模式实现） ────────────────────────

/**
 * 数据库管理类
 * 单例模式，全局共享一个实例
 * 本地开发用 JSON 文件存储，Docker 生产用 SQLite
 */
export class Database {
  private static instance: Database | null = null;

  // JSON 模式专用
  private store: JsonStore = { windows: [], tasks: [] };
  private dbPath: string;

  // SQLite 模式专用（any 类型，因为本地无 better-sqlite3 类型声明）
  private sqliteDb: any = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'db.json');
  }

  /** 获取单例实例 */
  static getInstance(dbPath?: string): Database {
    if (!Database.instance) {
      Database.instance = new Database(dbPath);
    }
    return Database.instance;
  }

  /**
   * 初始化数据库
   * JSON 模式：加载/创建 JSON 文件
   * SQLite 模式：打开数据库连接，建表
   */
  init(): void {
    if (USE_SQLITE) {
      this.initSqlite();
    } else {
      this.initJson();
    }
  }

  // ── JSON 模式初始化 ──

  private initJson(): void {
    // 确保目录存在
    fs.ensureDirSync(path.dirname(this.dbPath));
    // 加载已有数据
    this.loadJson();
  }

  /** 从 JSON 文件加载数据 */
  private loadJson(): void {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath, 'utf8');
        const parsed = JSON.parse(data);
        this.store = {
          windows: parsed.windows || [],
          tasks: parsed.tasks || [],
        };
      } else {
        // 文件不存在，创建初始结构
        this.store = { windows: [], tasks: [] };
        this.saveJson();
      }
    } catch (err) {
      // ★ 交付前安全加固：JSON 解析失败时绝不覆盖原文件
      // 旧实现：this.store = { windows: [], tasks: [] }; this.saveJson();
      //   → 会用空数据覆盖损坏的原文件，导致数据永久丢失
      // 新实现：备份原文件 + 抛出错误，让上层决定是否继续启动
      const errMsg = (err as Error).message;
      const backupPath = `${this.dbPath}.corrupt-${Date.now()}.bak`;
      try {
        fs.copyFileSync(this.dbPath, backupPath);
        console.error(`[DB] 本地数据文件解析失败，已保留原文件并创建备份:`);
        console.error(`[DB]   原文件: ${this.dbPath}`);
        console.error(`[DB]   备份文件: ${backupPath}`);
        console.error(`[DB]   错误: ${errMsg}`);
      } catch (backupErr) {
        console.error(`[DB] 本地数据文件解析失败，且备份创建失败:`);
        console.error(`[DB]   原文件: ${this.dbPath}`);
        console.error(`[DB]   解析错误: ${errMsg}`);
        console.error(`[DB]   备份错误: ${(backupErr as Error).message}`);
      }
      // 使用空存储作为内存状态，但绝不 saveJson 覆盖原文件
      this.store = { windows: [], tasks: [] };
      throw new Error(
        `本地数据文件解析失败，已保留原文件并创建备份，请检查 data 文件。错误: ${errMsg}`
      );
    }
  }

  /** 保存数据到 JSON 文件 */
  private saveJson(): void {
    fs.writeFileSync(this.dbPath, JSON.stringify(this.store, null, 2), 'utf8');
  }

  // ── SQLite 模式初始化 ──

  private initSqlite(): void {
    // 动态 require better-sqlite3（生产环境才有此依赖）
    // 用 eval 避免 TypeScript 编译时尝试解析模块
    const sqlitePath = path.join(process.cwd(), 'data', 'bnsy.db');
    fs.ensureDirSync(path.dirname(sqlitePath));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    this.sqliteDb = new Database(sqlitePath);

    // 建表
    this.sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS windows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cdp_port INTEGER,
        role TEXT NOT NULL,
        site TEXT NOT NULL,
        staff_name TEXT,
        is_connected INTEGER DEFAULT 0,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        site TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        total_count INTEGER DEFAULT 0,
        done_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        input_data TEXT,
        result_data TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS task_results (
        task_id TEXT NOT NULL,
        batch_seq INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (task_id, batch_seq)
      );
    `);
  }

  // ── windows 表操作 ──────────────────────────────────

  /** 插入或更新窗口信息 */
  upsertWindow(w: WindowInfo): void {
    if (USE_SQLITE) {
      this.sqliteDb.prepare(`
        INSERT INTO windows (id, name, cdp_port, role, site, staff_name, is_connected, updated_at)
        VALUES (@id, @name, @cdp_port, @role, @site, @staff_name, @is_connected, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          name=@name, cdp_port=@cdp_port, role=@role, site=@site,
          staff_name=@staff_name, is_connected=@is_connected, updated_at=@updated_at
      `).run(w);
    } else {
      const idx = this.store.windows.findIndex(x => x.id === w.id);
      if (idx >= 0) {
        this.store.windows[idx] = w;
      } else {
        this.store.windows.push(w);
      }
      this.saveJson();
    }
  }

  /** 获取所有窗口 */
  listWindows(): WindowInfo[] {
    if (USE_SQLITE) {
      return this.sqliteDb.prepare('SELECT * FROM windows ORDER BY role DESC, site, name').all();
    }
    return [...this.store.windows].sort((a, b) => {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      if (a.site !== b.site) return a.site.localeCompare(b.site);
      return a.name.localeCompare(b.name);
    });
  }

  // 向后兼容方法
  getWindows(): WindowInfo[] {
    return this.listWindows();
  }

  /** 按员工姓名获取员工窗口 */
  getStaffWindow(staffName: string): WindowInfo | undefined {
    return this.listWindows().find(w => w.role === 'staff' && w.staff_name === staffName);
  }

  /** 按网点获取所有员工窗口 */
  getStaffWindowsBySite(site: Site): WindowInfo[] {
    return this.listWindows().filter(w => w.role === 'staff' && w.site === site);
  }

  /** 更新窗口连接状态 */
  updateWindowConnection(id: string, isConnected: boolean): void {
    const w = this.listWindows().find(x => x.id === id);
    if (w) {
      w.is_connected = isConnected ? 1 : 0;
      w.updated_at = new Date().toISOString();
      this.upsertWindow(w);
    }
  }

  // ── tasks 表操作 ────────────────────────────────────

  /**
   * 创建新任务（Step2 规格方法）
   * Phase 2-C: 允许传入预生成的 id（用于 PG 主写 + JSON mirror 共用同一 taskId）
   * @param t 任务数据（id 可选，created_at 自动生成）
   * @returns 任务 ID
   */
  createTask(t: Omit<Task, 'id' | 'created_at'> & { id?: string }): string;
  /**
   * 创建新任务（向后兼容方法）
   * 传入完整 TaskRecord 时直接存储
   */
  createTask(t: Task): string;
  createTask(t: any): string {
    // 生成 id 和 created_at（如果未提供）
    const task: Task = {
      ...t,
      id: t.id || uuidv4(),
      created_at: t.created_at || new Date().toISOString(),
    };

    if (USE_SQLITE) {
      this.sqliteDb.prepare(`
        INSERT INTO tasks (id, type, site, status, total_count, done_count, fail_count, input_data, result_data, created_at, finished_at)
        VALUES (@id, @type, @site, @status, @total_count, @done_count, @fail_count, @input_data, @result_data, @created_at, @finished_at)
      `).run(task);
    } else {
      this.store.tasks.push(task);
      this.saveJson();
    }

    return task.id;
  }

  /**
   * 更新任务（Step2 规格方法）
   * @param taskId 任务 ID
   * @param updates 要更新的字段
   */
  updateTask(taskId: string, updates: Partial<Task>): void {
    if (USE_SQLITE) {
      const fields = Object.keys(updates).map(k => `${k}=@${k}`).join(', ');
      if (fields) {
        this.sqliteDb.prepare(`UPDATE tasks SET ${fields} WHERE id=@id`)
          .run({ ...updates, id: taskId });
      }
    } else {
      const task = this.store.tasks.find(t => t.id === taskId);
      if (task) {
        Object.assign(task, updates);
        this.saveJson();
      }
    }
  }

  /**
   * 获取单个任务（Step2 规格方法）
   * @returns 任务对象或 null
   */
  getTask(taskId: string): Task | null {
    if (USE_SQLITE) {
      return this.sqliteDb.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) || null;
    }
    return this.store.tasks.find(t => t.id === taskId) || null;
  }

  /**
   * 获取历史任务列表（Step2 规格方法）
   * @param limit 返回数量
   * @param type 可选任务类型过滤
   */
  listTasks(limit: number, type?: string): Task[];
  /** 向后兼容：带 offset 的分页查询 */
  listTasks(limit: number, offset: number, type?: TaskType): Task[];
  listTasks(limit: number, offsetOrType?: number | string, type?: string): Task[] {
    // 参数适配：listTasks(limit, type?) 和 listTasks(limit, offset, type?)
    let offset = 0;
    let filterType: string | undefined;
    if (typeof offsetOrType === 'number') {
      offset = offsetOrType;
      filterType = type;
    } else if (typeof offsetOrType === 'string') {
      filterType = offsetOrType;
    }

    if (USE_SQLITE) {
      if (filterType) {
        return this.sqliteDb.prepare('SELECT * FROM tasks WHERE type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
          .all(filterType, limit, offset);
      }
      return this.sqliteDb.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(limit, offset);
    }

    let tasks = [...this.store.tasks];
    if (filterType) {
      tasks = tasks.filter(t => t.type === filterType);
    }
    tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return tasks.slice(offset, offset + limit);
  }

  // 向后兼容方法
  getTasks(limit = 20, offset = 0, type?: TaskType): Task[] {
    return this.listTasks(limit, offset, type);
  }

  /**
   * 按状态查询任务（Phase G-1: 僵尸任务恢复专用）
   * @param status 任务状态（如 'running'）
   * @returns 匹配状态的所有任务列表
   */
  listTasksByStatus(status: TaskStatus): Task[] {
    if (USE_SQLITE) {
      return this.sqliteDb.prepare('SELECT * FROM tasks WHERE status = ?').all(status);
    }
    return this.store.tasks.filter(t => t.status === status);
  }

  /**
   * 更新任务进度（向后兼容方法）
   * 内部调用 updateTask
   */
  updateTaskProgress(id: string, doneCount: number, failCount: number, status: TaskStatus, resultData?: string): void {
    const updates: Partial<Task> = {
      done_count: doneCount,
      fail_count: failCount,
      status,
    };
    if (resultData) updates.result_data = resultData;
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      updates.finished_at = new Date().toISOString();
    }
    this.updateTask(id, updates);
  }

  // ── Phase I: 批次级增量结果持久化 ──────────────────

  /**
   * 追加一个批次的结果数据到独立存储
   *
   * SQLite 模式：写入 task_results 表（batch_seq 自增）
   * JSON 模式：追加一行到 data/results/{taskId}.jsonl
   *
   * 【IO 异常隔离】：写入失败时仅记录错误日志，不抛出异常，
   * 允许该批次结果丢失，但任务必须能继续跑完。
   *
   * @param taskId 任务 ID
   * @param batchResults 本批次的 OperationResult 数组
   */
  appendTaskResults(taskId: string, batchResults: import('../operations/BaseOperation').OperationResult[]): void {
    try {
      if (USE_SQLITE) {
        // SQLite 模式：INSERT 一行，batch_seq 自增
        const row = this.sqliteDb.prepare(
          'SELECT COALESCE(MAX(batch_seq), 0) + 1 AS next_seq FROM task_results WHERE task_id = ?'
        ).get(taskId);
        const batchSeq = (row as any)?.next_seq || 1;

        this.sqliteDb.prepare(
          'INSERT INTO task_results (task_id, batch_seq, result_json) VALUES (?, ?, ?)'
        ).run(taskId, batchSeq, JSON.stringify(batchResults));
      } else {
        // JSON 模式：JSONL 文件追加

        // 【防御性约束 1】检查并确保目录存在
        const resultsDir = path.join(path.dirname(this.dbPath), 'results');
        fs.ensureDirSync(resultsDir);

        const jsonlPath = path.join(resultsDir, `${taskId}.jsonl`);
        const line = JSON.stringify(batchResults) + '\n';
        fs.appendFileSync(jsonlPath, line, 'utf8');
      }
    } catch (err) {
      // 【防御性约束 2】IO 异常隔离：写入失败仅记日志，不崩引擎
      const errMsg = (err as Error).message;
      console.error(`[DB] appendTaskResults 写入失败 (task=${taskId}): ${errMsg}`);

      // 同时写入任务日志（如果有 taskLogManager 可用则使用）
      try {
        // 延迟 require 避免循环依赖（taskLogManager → Database → taskLogManager）
        const { taskLogManager } = require('../utils/TaskLogManager');
        if (taskLogManager) {
          taskLogManager.addLog(taskId, 'error',
            `批次结果写入失败: ${errMsg}（该批次数据可能丢失）`, 'Database');
        }
      } catch {
        // taskLogManager 不可用时，仅 console.error 即可
      }
    }
  }

  /**
   * 按需聚合读取任务的所有结果
   *
   * SQLite 模式：SELECT task_results ORDER BY batch_seq，逐行 JSON.parse
   * JSON 模式：按行读取 JSONL 文件，逐行 JSON.parse
   *
   * 【容错读取】：某一行 JSON 解析失败时，跳过该坏行并打印 warning，
   * 继续读取后续行，不直接抛异常。
   *
   * @param taskId 任务 ID
   * @returns 聚合后的 OperationResult 数组（按批次写入顺序排列）
   */
  getTaskResults(taskId: string): import('../operations/BaseOperation').OperationResult[] {
    const results: import('../operations/BaseOperation').OperationResult[] = [];

    try {
      if (USE_SQLITE) {
        const rows = this.sqliteDb.prepare(
          'SELECT result_json FROM task_results WHERE task_id = ? ORDER BY batch_seq'
        ).all(taskId);

        for (const row of rows as any[]) {
          try {
            const batch = JSON.parse(row.result_json);
            results.push(...batch);
          } catch (parseErr) {
            // 【容错】跳过损坏的批次记录
            console.warn(`[DB] 跳过损坏的批次记录 (task=${taskId}): ${(parseErr as Error).message}`);
          }
        }
      } else {
        // JSON 模式：逐行读取 JSONL 文件
        const jsonlPath = path.join(path.dirname(this.dbPath), 'results', `${taskId}.jsonl`);
        if (!fs.existsSync(jsonlPath)) {
          return [];
        }

        const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const batch = JSON.parse(line);
            results.push(...batch);
          } catch (parseErr) {
            // 【容错】跳过损坏的行（如进程异常退出导致 JSON 不完整）
            console.warn(
              `[DB] 跳过损坏行 (task=${taskId}, 行首=${line.slice(0, 50)}...): ${(parseErr as Error).message}`
            );
          }
        }
      }
    } catch (err) {
      console.error(`[DB] getTaskResults 读取失败 (task=${taskId}): ${(err as Error).message}`);
    }

    return results;
  }

  /**
   * 统计符合条件的任务总数
   *
   * @param type 可选任务类型过滤
   * @returns 任务总数
   */
  countTasks(type?: TaskType): number {
    if (USE_SQLITE) {
      if (type) {
        const row = this.sqliteDb.prepare('SELECT COUNT(*) AS cnt FROM tasks WHERE type = ?').get(type);
        return (row as any)?.cnt || 0;
      }
      const row = this.sqliteDb.prepare('SELECT COUNT(*) AS cnt FROM tasks').get();
      return (row as any)?.cnt || 0;
    }
    if (type) {
      return this.store.tasks.filter(t => t.type === type).length;
    }
    return this.store.tasks.length;
  }

  /** 关闭数据库连接 */
  close(): void {
    if (USE_SQLITE && this.sqliteDb) {
      this.sqliteDb.close();
    } else {
      this.saveJson();
    }
    Database.instance = null;
  }
}

// ── 向后兼容别名 ──────────────────────────────────────
// 旧代码使用 DatabaseManager.getInstance()，新代码使用 Database.getInstance()
// 同时导出值和类型，确保 BrowserPool 中 private db: DatabaseManager 可用
export const DatabaseManager = Database;
export type DatabaseManager = Database;
