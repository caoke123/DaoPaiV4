/**
 * PgDatabase — PostgreSQL 数据库访问层
 *
 * 数据库换代核心模块。使用 pg.Pool 连接池，手写 SQL 保持对查询的绝对掌控。
 * 初期与现有 Database.ts 并存，验证通过后逐步替换，绝不破坏 AssignmentEngine 运行。
 *
 * 核心能力：
 *   1. 幂等初始化 — 读取并执行 init-schema.sql（CREATE IF NOT EXISTS）
 *   2. 批量插入运单结果 — 万单级写入性能（一条 SQL 多行 VALUES）
 *   3. 运单池 UPERT — INSERT ... ON CONFLICT DO UPDATE（对账基石）
 *   4. 参数化查询 — 全部使用 $1, $2 防注入
 *
 * 环境变量（全部可选，有默认值）：
 *   PG_HOST     — 默认 127.0.0.1
 *   PG_PORT     — 默认 5437（DaoPai V4 专属，与 V3 5436 隔离）
 *   PG_USER     — 默认 daopai_v4（与 V3 daopai 隔离）
 *   PG_PASSWORD — 默认 daopai_v4_secret（与 V3 daopai_secret 隔离）
 *   PG_DATABASE — 默认 daopai_v4（与 V3 daopai_v3 隔离）
 *   PG_POOL_MAX — 连接池上限，默认 20
 */

import path from 'path';
import fs from 'fs';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import type { WaybillResult, TaskLogEntry } from '../types/api-contracts';

// ── 多租户常量 ──────────────────────────────────────────
/**
 * 默认租户 ID（Phase 2-B）
 *
 * 当前无 JWT 登录系统，所有数据归属 tenant-default。
 * 后续 Phase 2-C+ 接入认证后，由中间件从 JWT 解析 tenantId 注入。
 *
 * ⚠️ 风险说明（Phase M-3B）：
 *  - 当前 28+ 处查询使用此值作为默认参数。
 *  - DEFAULT 仅在方法签名参数中兜底使用，未在任何业务逻辑中直接引用字符串。
 *  - 仅用于当前单租户开发环境，真实多租户上线前必须：
 *    1. 移除所有 DEFAULT 兜底
 *    2. 由请求上下文（JWT/Agent Token）强制注入 tenantId
 *    3. 不传 tenantId 直接报错（400/403），杜绝静默跨租户数据泄露
 */
export const DEFAULT_TENANT_ID = 'tenant-default';

/**
 * 默认工作站 ID（Phase 2-D）
 *
 * 当前 Agent 未拆分前统一使用此值。
 *
 * ⚠️ 风险说明（Phase M-3B）：
 *  - 仅用于当前开发环境，多工作站上线前必须：
 *    1. 由 Agent 注册信息/Agent Token 中注入 workstationId
 *    2. Agent pull 时必须按 workstationId 拉取
 *    3. 不传 workstationId 直接拒绝
 */
export const DEFAULT_WORKSTATION_ID = 'ws-local-default';

// ── 连接配置 ──────────────────────────────────────────

export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max: number; // 连接池上限
}

function loadConfig(): PgConfig {
  return {
    host: process.env.PG_HOST || '127.0.0.1',
    port: parseInt(process.env.PG_PORT || '5437', 10),
    user: process.env.PG_USER || 'daopai_v4',
    password: process.env.PG_PASSWORD || 'daopai_v4_secret',
    database: process.env.PG_DATABASE || 'daopai_v4',
    max: parseInt(process.env.PG_POOL_MAX || '20', 10),
  };
}

// ── 任务插入参数类型 ──────────────────────────────────

export interface InsertTaskParams {
  id?: string;
  type: string;
  siteId: string;
  status?: string;
  totalCount: number;
  doneCount?: number;
  failCount?: number;
  inputData?: Record<string, unknown>;
  tenantId?: string;       // Phase 2-B: 不传则用 DEFAULT_TENANT_ID
  workstationId?: string;  // Phase 2-D: 不传则用 DEFAULT_WORKSTATION_ID
}

// ── PgDatabase 类 ─────────────────────────────────────

export class PgDatabase {
  private static instance: PgDatabase | null = null;

  private pool: Pool;
  private initialized = false;

  private constructor(config?: Partial<PgConfig>) {
    const cfg = { ...loadConfig(), ...config };
    // 启动日志：打印连接目标（不打印密码）
    console.log(`[PG] host=${cfg.host} port=${cfg.port} database=${cfg.database} user=${cfg.user}`);
    this.pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      max: cfg.max,
      // 连接超时 5 秒
      connectionTimeoutMillis: 5000,
      // 空闲连接 30 秒后回收
      idleTimeoutMillis: 30000,
    });

    // Pool 级错误处理：防止未捕获的错误导致进程崩溃
    this.pool.on('error', (err: Error) => {
      console.error('[PgDatabase] Pool 意外错误:', err.message);
    });
  }

  /** 获取单例 */
  static getInstance(config?: Partial<PgConfig>): PgDatabase {
    if (!PgDatabase.instance) {
      PgDatabase.instance = new PgDatabase(config);
    }
    return PgDatabase.instance;
  }

  /** 获取底层 Pool（供高级查询使用） */
  getPool(): Pool {
    return this.pool;
  }

  // ══════════════════════════════════════════════════════════
  // 1. init() — 幂等初始化
  // ══════════════════════════════════════════════════════════

  /**
   * 初始化数据库：读取并执行 init-schema.sql
   *
   * 使用 CREATE TABLE IF NOT EXISTS 实现幂等：
   * 多次调用 init() 不会报错，只会创建缺失的表。
   * Docker 环境：PostgreSQL 容器启动时会自动执行
   *   /docker-entrypoint-initdb.d/01-init-schema.sql，
   *   但仍然显式调用 init() 以确保非 Docker 环境也能建表。
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 1. 测试连接
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    // 2. 读取 schema 文件
    const schemaPaths = [
      // bnsy-operator-next: schema 文件位于 database/schema/
      path.join(process.cwd(), 'database', 'schema', 'init-schema.sql'),
      path.join(process.cwd(), '..', 'database', 'schema', 'init-schema.sql'),
    ];

    let sql = '';
    for (const schemaPath of schemaPaths) {
      if (fs.existsSync(schemaPath)) {
        sql = fs.readFileSync(schemaPath, 'utf8');
        console.log(`[PgDatabase] init: 读取 schema 文件 ${schemaPath}`);
        break;
      }
    }

    if (!sql) {
      console.warn('[PgDatabase] init: 未找到 init-schema.sql，跳过建表。请确认 database/schema/init-schema.sql 存在。');
      this.initialized = true;
      return;
    }

    // 3. 执行 schema（一次事务）
    await this.pool.query(sql);
    console.log('[PgDatabase] init: schema 初始化完成');
    this.initialized = true;
  }

  /** 检查连接是否存活 */
  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    try {
      const result = await this.pool.query('SELECT NOW() AS now, version() AS version');
      const row = result.rows[0];
      return {
        ok: true,
        message: `PostgreSQL ${(row as any).version} | 服务器时间: ${(row as any).now}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `连接失败: ${(err as Error).message}`,
      };
    }
  }

  // ══════════════════════════════════════════════════════════
  // 2. insertTask() — 插入新任务
  // ══════════════════════════════════════════════════════════

  /**
   * 插入新任务
   *
   * 如果 task.id 已提供（由 routes.ts 预先生成），则直接使用；
   * 否则由 PG 的 gen_random_uuid() 自动生成。
   *
   * @param task  任务参数
   * @returns 任务的 UUID
   */
  async insertTask(task: InsertTaskParams): Promise<string> {
    const tenantId = task.tenantId || DEFAULT_TENANT_ID;
    const workstationId = task.workstationId || DEFAULT_WORKSTATION_ID;
    const hasId = !!task.id;
    const result = await this.pool.query<{ id: string }>(
      hasId
        ? `INSERT INTO tasks (id, type, site_id, status, total_count, done_count, fail_count, input_data, tenant_id, workstation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`
        : `INSERT INTO tasks (type, site_id, status, total_count, done_count, fail_count, input_data, tenant_id, workstation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
      hasId
        ? [
            task.id,
            task.type,
            task.siteId,
            task.status || 'pending',
            task.totalCount,
            task.doneCount || 0,
            task.failCount || 0,
            task.inputData ? JSON.stringify(task.inputData) : null,
            tenantId,
            workstationId,
          ]
        : [
            task.type,
            task.siteId,
            task.status || 'pending',
            task.totalCount,
            task.doneCount || 0,
            task.failCount || 0,
            task.inputData ? JSON.stringify(task.inputData) : null,
            tenantId,
            workstationId,
          ]
    );

    return result.rows[0].id;
  }

  /**
   * 更新任务终态（done / failed / cancelled）
   *
   * @param taskId   任务 ID
   * @param updates  要更新的字段
   */
  async updateTaskStatus(
    taskId: string,
    updates: { status: string; doneCount?: number; failCount?: number; finishedAt?: string },
    tenantId: string = DEFAULT_TENANT_ID
  ): Promise<void> {
    await this.pool.query(
      `UPDATE tasks
       SET status     = $2,
           done_count = COALESCE($3, done_count),
           fail_count = COALESCE($4, fail_count),
           finished_at = COALESCE($5, finished_at)
       WHERE id = $1 AND tenant_id = $6`,
      [
        taskId,
        updates.status,
        updates.doneCount ?? null,
        updates.failCount ?? null,
        updates.finishedAt ?? null,
        tenantId,
      ]
    );
  }

  /**
   * 为执行引擎原子认领任务。
   *
   * local-api 只能认领 pending，避免重复执行已由 Agent 或其它本机路径接管的任务。
   * agent-engine 在 /tasks/pull 已经把任务置为 assigned，因此允许 assigned 继续进入引擎。
   */
  async claimTaskForEngine(
    tenantId: string,
    taskId: string,
    source: 'local-api' | 'agent-engine',
    workstationId: string = DEFAULT_WORKSTATION_ID,
  ): Promise<{
    id: string;
    type: string;
    site: string;
    siteName: string;
    status: string;
    totalCount: number;
    doneCount: number;
    failCount: number;
    createdAt: string;
    finishedAt: string | null;
    inputData?: unknown;
  } | null> {
    const allowedStatus = source === 'agent-engine' ? 'assigned' : 'pending';
    const result = await this.pool.query(
      `UPDATE tasks
       SET status = 'assigned',
           workstation_id = COALESCE($4, workstation_id),
           assigned_at = COALESCE(assigned_at, NOW()),
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND status = $3
       RETURNING id, type, site_id, status, total_count, done_count, fail_count, created_at, finished_at, input_data`,
      [taskId, tenantId, allowedStatus, workstationId],
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return {
      id: row.id,
      type: row.type,
      site: row.site_id,
      siteName: row.site_id,
      status: row.status,
      totalCount: row.total_count,
      doneCount: row.done_count,
      failCount: row.fail_count,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      finishedAt: row.finished_at
        ? (row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at))
        : null,
      inputData: row.input_data,
    };
  }

  // ══════════════════════════════════════════════════════════
  // 2b. getTaskList() — 分页查询任务列表
  // ══════════════════════════════════════════════════════════

  /**
   * 分页查询任务列表，支持按 type 过滤、按关键字搜索、含员工数统计
   *
   * 排序：created_at DESC（最新任务在前）
   * 搜索：支持任务类型中文名、员工名、运单号（ILIKE 模糊匹配）
   *
   * @param page    页码（从 1 开始）
   * @param limit   每页数量
   * @param type    可选任务类型过滤
   * @param search  可选关键字搜索（任务类型中文/员工名/运单号）
   * @returns { tasks, total }
   */
  async getTaskList(
    tenantId: string = DEFAULT_TENANT_ID,
    page: number,
    limit: number,
    type?: string,
    status?: string,
    search?: string,
  ): Promise<{
    tasks: Array<{
      id: string;
      type: string;
      site: string;
      siteName: string;
      status: string;
      totalCount: number;
      doneCount: number;
      failCount: number;
      inputData?: string;
      createdAt: string;
      finishedAt: string | null;
      staffCount: number;
    }>;
    total: number;
  }> {
    const offset = (page - 1) * limit;

    // Phase 2-B: tenant_id 作为第一个条件（$1），始终存在
    const conditions: string[] = [`t.tenant_id = $1`];
    const countConditions: string[] = [`t.tenant_id = $1`];
    const params: unknown[] = [tenantId];
    const countParams: unknown[] = [tenantId];

    let paramIdx = 2; // $1 已被 tenantId 占用

    if (type) {
      conditions.push(`t.type = $${paramIdx}`);
      params.push(type);
      countConditions.push(`t.type = $${paramIdx}`);
      countParams.push(type);
      paramIdx++;
    }

    if (status) {
      conditions.push(`t.status = $${paramIdx}`);
      params.push(status);
      countConditions.push(`t.status = $${paramIdx}`);
      countParams.push(status);
      paramIdx++;
    }

    // ── 搜索条件：搜索任务类型中文名映射 ──
    const typeKeywordMap: Record<string, string> = {
      '到件': 'arrive', '到件扫描': 'arrive',
      '派件': 'dispatch', '派件扫描': 'dispatch',
      '签收': 'sign', '签收录入': 'sign',
      '集成': 'integrated', '综合': 'integrated',
      '窗口': 'init_window', '初始化': 'init_window',
    };

    if (search) {
      const matchedType = typeKeywordMap[search];

      if (matchedType) {
        // 精确匹配到任务类型 → 按类型过滤
        conditions.push(`t.type = $${paramIdx}`);
        params.push(matchedType);
        countConditions.push(`t.type = $${paramIdx}`);
        countParams.push(matchedType);
        paramIdx++;
      } else {
        // 未匹配到类型 → 搜索员工名 + 运单号（ILIKE 模糊）
        // Phase 2-B: 子查询同时过滤 tenant_id，防止跨租户搜索
        const searchParam = `%${search}%`;
        conditions.push(`(
          t.id IN (SELECT DISTINCT wr.task_id FROM waybill_results wr WHERE wr.staff_name ILIKE $${paramIdx} AND wr.tenant_id = $1)
          OR t.id IN (SELECT DISTINCT wr2.task_id FROM waybill_results wr2 WHERE wr2.waybill_no ILIKE $${paramIdx} AND wr2.tenant_id = $1)
        )`);
        params.push(searchParam);
        countConditions.push(`(
          t.id IN (SELECT DISTINCT wr.task_id FROM waybill_results wr WHERE wr.staff_name ILIKE $${paramIdx} AND wr.tenant_id = $1)
          OR t.id IN (SELECT DISTINCT wr2.task_id FROM waybill_results wr2 WHERE wr2.waybill_no ILIKE $${paramIdx} AND wr2.tenant_id = $1)
        )`);
        countParams.push(searchParam);
        paramIdx++;
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countWhere = `WHERE ${countConditions.join(' AND ')}`;
    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;
    params.push(limit, offset);

    const [dataResult, countResult] = await Promise.all([
      this.pool.query(
        `SELECT t.id, t.type, t.site_id, s.name AS site_name, t.status, t.total_count, t.done_count, t.fail_count, t.input_data, t.created_at, t.finished_at, t.workstation_id,
                COALESCE(ws.staff_cnt, 0) AS staff_count
         FROM tasks t
         LEFT JOIN sites s ON s.id = t.site_id
         LEFT JOIN (
           SELECT task_id, COUNT(DISTINCT staff_name)::int AS staff_cnt
           FROM waybill_results
           WHERE staff_name IS NOT NULL AND staff_name != ''
             AND tenant_id = $1
           GROUP BY task_id
         ) ws ON ws.task_id = t.id
         ${whereClause}
         ORDER BY t.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      ),
      this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM tasks t ${countWhere}`,
        countParams
      ),
    ]);

    const tasks = dataResult.rows.map((row: any) => ({
      id: row.id,
      type: row.type,
      site: row.site_id,
      siteName: row.site_name || row.site_id,
      status: row.status,
      totalCount: row.total_count,
      doneCount: row.done_count,
      failCount: row.fail_count,
      inputData: row.input_data,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      finishedAt: row.finished_at
        ? (row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at))
        : null,
      staffCount: row.staff_count,
      workstationId: row.workstation_id || undefined,
    }));

    return { tasks, total: parseInt(countResult.rows[0].cnt, 10) };
  }

  // ══════════════════════════════════════════════════════════
  // 2b2. getTaskStats() — 服务端聚合统计
  // ══════════════════════════════════════════════════════════

  /**
   * 获取任务聚合统计（服务端 COUNT，100% 准确）
   *
   * @returns 按 status 分组的数量
   */
  async getTaskStats(tenantId: string = DEFAULT_TENANT_ID): Promise<{
    total: number;
    running: number;
    done: number;
    failed: number;
    cancelled: number;
    pending: number;
  }> {
    const result = await this.pool.query<{ status: string; cnt: string }>(
      `SELECT status, COUNT(*)::text AS cnt FROM tasks WHERE tenant_id = $1 GROUP BY status`,
      [tenantId]
    );

    const map: Record<string, number> = {};
    for (const row of result.rows) {
      map[row.status] = parseInt(row.cnt, 10);
    }

    return {
      total: Object.values(map).reduce((a, b) => a + b, 0),
      running: map.running || 0,
      done: map.done || 0,
      failed: map.failed || 0,
      cancelled: map.cancelled || 0,
      pending: map.pending || 0,
    };
  }

  // ══════════════════════════════════════════════════════════
  // 2c. getTaskById() — 按 ID 查询单个任务
  // ══════════════════════════════════════════════════════════

  /**
   * 按 ID 查询单个任务
   *
   * @param taskId  任务 ID
   * @returns 任务对象或 null
   */
  async getTaskById(tenantId: string = DEFAULT_TENANT_ID, taskId: string): Promise<{
    id: string;
    type: string;
    site: string;
    siteName: string;
    status: string;
    totalCount: number;
    doneCount: number;
    failCount: number;
    createdAt: string;
    finishedAt: string | null;
    inputData?: unknown;
  } | null> {
    const result = await this.pool.query(
      `SELECT t.id, t.type, t.site_id, s.name AS site_name, t.status, t.total_count, t.done_count, t.fail_count, t.created_at, t.finished_at, t.input_data
       FROM tasks t
       LEFT JOIN sites s ON s.id = t.site_id
       WHERE t.id = $1 AND t.tenant_id = $2`,
      [taskId, tenantId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0] as any;
    return {
      id: row.id,
      type: row.type,
      site: row.site_id,
      siteName: row.site_name || row.site_id,
      status: row.status,
      totalCount: row.total_count,
      doneCount: row.done_count,
      failCount: row.fail_count,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      finishedAt: row.finished_at
        ? (row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at))
        : null,
      inputData: row.input_data,
    };
  }

  // ══════════════════════════════════════════════════════════
  // 2c. syncSitesFromSettings() — 将设置中心的网点 id/name 同步到 PG sites 表
  // ══════════════════════════════════════════════════════════

  /**
   * 将站点名（中文）转换为站点 code（与 routes.ts normalizeSiteToCode / windowRuntimeRoutes.ts
   * normalizeSiteNameToCode 逻辑一致）。
   *
   * Phase 4-C: 必须与所有调用方保持完全一致，否则 PG tasks.site_id 外键会因 id 格式不匹配
   * 而违反约束（INSERT 失败被 fire-and-forget .catch 静默吞掉，导致任务中心永远为空）。
   */
  private siteNameToCode(siteName: string): string | null {
    if (!siteName) return null;
    if (siteName.includes('天南大')) return 'tiannanda';
    if (siteName.includes('和苑')) return 'heyuan';
    return null;
  }

  /**
   * 根据设置中心传入的 sites 配置，UPSERT PG sites 表的 id/name。
   *
   * Phase 4-C 修复：同时写入两条记录，确保外键 tasks.site_id REFERENCES sites(id) 总能满足：
   *   1. settings.json 的原始 site.id（如 'site-1782121346155'）
   *      — 兼容直接使用 settings.json id 的代码路径
   *   2. normalizeSiteToCode 转换后的 siteCode（如 'tiannanda' / 'heyuan'）
   *      — AssignmentEngine.pgDb.insertTask 实际使用的 siteId 格式
   *
   * 这样无论 insertTask 用哪种格式作为 site_id，FK 都能命中 sites 表，
   * 避免外键违反导致任务被静默丢弃、任务中心永远为空的问题。
   *
   * @param sites 设置中心格式的网点配置（含 id/name/windows）
   */
  async syncSitesFromSettings(
    sites: Array<{ id: string; name: string }>,
    tenantId: string = DEFAULT_TENANT_ID
  ): Promise<void> {
    if (!Array.isArray(sites) || sites.length === 0) return;
    for (const s of sites) {
      if (!s?.id) continue;
      const displayName = s.name || s.id;

      // 1. 写入 settings.json 原始 id（兼容直接使用 settings.json id 的代码路径）
      await this.pool.query(
        `INSERT INTO sites (id, name, tenant_id) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tenant_id = EXCLUDED.tenant_id, updated_at = NOW()`,
        [s.id, displayName, tenantId]
      );

      // 2. 写入 siteCode（与 normalizeSiteToCode 一致）—— insertTask 实际使用的 site_id 格式
      //    这是 Phase 4-C 修复的核心：tasks.site_id FK 必须命中此记录
      const siteCode = this.siteNameToCode(displayName);
      if (siteCode && siteCode !== s.id) {
        await this.pool.query(
          `INSERT INTO sites (id, name, tenant_id) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tenant_id = EXCLUDED.tenant_id, updated_at = NOW()`,
          [siteCode, displayName, tenantId]
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // 2d. cleanupOldTasks() — 清理历史已结束任务
  // ══════════════════════════════════════════════════════════

  /**
   * 清理指定天数前的已结束任务（done / failed / cancelled）
   * 禁止删除 running / pending
   *
   * @param retentionDays 保留天数，默认 30；传 -1 表示永久保留（不清理）
   * @returns 删除量统计
   */
  async cleanupOldTasks(
    tenantId: string = DEFAULT_TENANT_ID,
    retentionDays: number = 30
  ): Promise<{
    deletedTasks: number;
    deletedWaybills: number;
    deletedLogs: number;
  }> {
    if (retentionDays <= 0) {
      return { deletedTasks: 0, deletedWaybills: 0, deletedLogs: 0 };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 先统计（Phase 2-B: 加 tenant_id 过滤）
      const targetResult = await client.query<{ task_id: string }>(
        `SELECT id AS task_id FROM tasks
         WHERE status IN ('done', 'failed', 'cancelled')
           AND tenant_id = $1
           AND created_at < NOW() - ($2 || ' days')::INTERVAL`,
        [tenantId, String(retentionDays)]
      );
      const taskIds = targetResult.rows.map(r => r.task_id);

      if (taskIds.length === 0) {
        await client.query('COMMIT');
        return { deletedTasks: 0, deletedWaybills: 0, deletedLogs: 0 };
      }

      // task_logs + waybill_results 有 ON DELETE CASCADE，但显式删除更安全
      const logResult = await client.query<{ deleted_count: string }>(
        `WITH deleted AS (
           DELETE FROM task_logs WHERE task_id = ANY($1::uuid[]) RETURNING 1
         ) SELECT COUNT(*)::text AS deleted_count FROM deleted`,
        [taskIds]
      );

      const wrResult = await client.query<{ deleted_count: string }>(
        `WITH deleted AS (
           DELETE FROM waybill_results WHERE task_id = ANY($1::uuid[]) RETURNING 1
         ) SELECT COUNT(*)::text AS deleted_count FROM deleted`,
        [taskIds]
      );

      const taskResult = await client.query<{ deleted_count: string }>(
        `WITH deleted AS (
           DELETE FROM tasks WHERE id = ANY($1::uuid[]) RETURNING 1
         ) SELECT COUNT(*)::text AS deleted_count FROM deleted`,
        [taskIds]
      );

      await client.query('COMMIT');

      return {
        deletedTasks: parseInt(taskResult.rows[0].deleted_count, 10),
        deletedWaybills: parseInt(wrResult.rows[0].deleted_count, 10),
        deletedLogs: parseInt(logResult.rows[0].deleted_count, 10),
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ══════════════════════════════════════════════════════════
  // 2e. countTaskDeleteStats() — 统计选中任务关联数据量
  // ══════════════════════════════════════════════════════════

  async countTaskDeleteStats(
    tenantId: string = DEFAULT_TENANT_ID,
    taskIds: string[]
  ): Promise<{
    taskCount: number;
    waybillCount: number;
    logCount: number;
    typeBreakdown: Record<string, number>;
  }> {
    if (taskIds.length === 0) {
      return { taskCount: 0, waybillCount: 0, logCount: 0, typeBreakdown: {} };
    }
    // Phase 2-B: 所有查询加 tenant_id 过滤，防止跨租户统计
    const result = await this.pool.query(
      `SELECT
        type,
        COUNT(*)::int AS cnt
       FROM tasks
       WHERE id = ANY($1::uuid[])
         AND tenant_id = $2
         AND status IN ('done', 'failed', 'cancelled')
       GROUP BY type`,
      [taskIds, tenantId]
    );
    const typeBreakdown: Record<string, number> = {};
    let taskCount = 0;
    for (const row of result.rows) {
      typeBreakdown[row.type] = parseInt(row.cnt, 10);
      taskCount += parseInt(row.cnt, 10);
    }

    const wrResult = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM waybill_results WHERE task_id = ANY($1::uuid[]) AND tenant_id = $2`,
      [taskIds, tenantId]
    );
    const logResult = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM task_logs WHERE task_id = ANY($1::uuid[]) AND tenant_id = $2`,
      [taskIds, tenantId]
    );

    return {
      taskCount,
      waybillCount: parseInt(wrResult.rows[0].cnt, 10),
      logCount: parseInt(logResult.rows[0].cnt, 10),
      typeBreakdown,
    };
  }

  // ══════════════════════════════════════════════════════════
  // 2f. deleteTasks() — 批量删除选中任务
  // ══════════════════════════════════════════════════════════

  /**
   * 批量删除任务（自动跳过 running/pending 状态的任务）
   * @returns 删除统计
   */
  async deleteTasks(
    tenantId: string = DEFAULT_TENANT_ID,
    taskIds: string[]
  ): Promise<{
    success: number;
    skipped: number;
    deletedWaybills: number;
    deletedLogs: number;
  }> {
    if (taskIds.length === 0) {
      return { success: 0, skipped: 0, deletedWaybills: 0, deletedLogs: 0 };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Phase 2-B: 找出可删除的任务（done/failed/cancelled）且属于当前租户
      const validResult = await client.query<{ id: string }>(
        `SELECT id FROM tasks
         WHERE id = ANY($1::uuid[])
           AND tenant_id = $2
           AND status IN ('done', 'failed', 'cancelled')`,
        [taskIds, tenantId]
      );
      const validIds = validResult.rows.map(r => r.id);
      const skipped = taskIds.length - validIds.length;

      if (validIds.length === 0) {
        await client.query('COMMIT');
        return { success: 0, skipped, deletedWaybills: 0, deletedLogs: 0 };
      }

      // task_logs / waybill_results 通过 ON DELETE CASCADE 自动清理，
      // 但显式删除可统计行数，且加 tenant_id 双保险
      const logResult = await client.query<{ cnt: string }>(
        `WITH deleted AS (DELETE FROM task_logs WHERE task_id = ANY($1::uuid[]) AND tenant_id = $2 RETURNING 1)
         SELECT COUNT(*)::text AS cnt FROM deleted`,
        [validIds, tenantId]
      );
      const wrResult = await client.query<{ cnt: string }>(
        `WITH deleted AS (DELETE FROM waybill_results WHERE task_id = ANY($1::uuid[]) AND tenant_id = $2 RETURNING 1)
         SELECT COUNT(*)::text AS cnt FROM deleted`,
        [validIds, tenantId]
      );
      await client.query(
        `DELETE FROM tasks WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [validIds, tenantId]
      );

      await client.query('COMMIT');

      return {
        success: validIds.length,
        skipped,
        deletedWaybills: parseInt(wrResult.rows[0].cnt, 10),
        deletedLogs: parseInt(logResult.rows[0].cnt, 10),
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ══════════════════════════════════════════════════════════
  // 2g. resetAllTasks() — Phase K-3A-2-Prep: 清空当前租户所有任务数据
  // ══════════════════════════════════════════════════════════

  /**
   * 清空当前租户所有任务相关数据（tasks + task_logs + waybill_results）
   * 仅用于 E2E 测试前重置环境，不删站点/员工/窗口配置。
   */
  async resetAllTasks(
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<{
    deletedTasks: number;
    deletedWaybills: number;
    deletedLogs: number;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 统计将要删除的数据
      const taskCountResult = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM tasks WHERE tenant_id = $1`,
        [tenantId]
      );
      const wrCountResult = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM waybill_results WHERE tenant_id = $1`,
        [tenantId]
      );
      const logCountResult = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM task_logs WHERE tenant_id = $1`,
        [tenantId]
      );

      const expectedTasks = parseInt(taskCountResult.rows[0].cnt, 10);

      if (expectedTasks === 0) {
        await client.query('COMMIT');
        return { deletedTasks: 0, deletedWaybills: 0, deletedLogs: 0 };
      }

      // 先删子表，再删主表（虽然有 ON DELETE CASCADE，显式删除更安全可靠）
      const logResult = await client.query<{ cnt: string }>(
        `WITH deleted AS (
           DELETE FROM task_logs WHERE tenant_id = $1 RETURNING 1
         ) SELECT COUNT(*)::text AS cnt FROM deleted`,
        [tenantId]
      );
      const wrResult = await client.query<{ cnt: string }>(
        `WITH deleted AS (
           DELETE FROM waybill_results WHERE tenant_id = $1 RETURNING 1
         ) SELECT COUNT(*)::text AS cnt FROM deleted`,
        [tenantId]
      );
      const taskResult = await client.query<{ cnt: string }>(
        `WITH deleted AS (
           DELETE FROM tasks WHERE tenant_id = $1 RETURNING 1
         ) SELECT COUNT(*)::text AS cnt FROM deleted`,
        [tenantId]
      );

      await client.query('COMMIT');

      return {
        deletedTasks: parseInt(taskResult.rows[0].cnt, 10),
        deletedWaybills: parseInt(wrResult.rows[0].cnt, 10),
        deletedLogs: parseInt(logResult.rows[0].cnt, 10),
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ══════════════════════════════════════════════════════════
  // 3. insertWaybillResults() — 批量插入运单结果
  // ══════════════════════════════════════════════════════════

  /**
   * 批量插入运单结果（一条 SQL 多行 VALUES，万单级写入性能）
   *
   * 原理：将 N 条 WaybillResult 拼成一条 INSERT INTO ... VALUES ($1,$2,...), ($9,$10,...), ...
   * pg 模块原生支持这种模式，单次 SQL 即可插入数千行。
   *
   * 安全：全部使用 $N 参数化查询，无 SQL 注入风险。
   *
   * @param taskId    任务 ID
   * @param batchSeq  批次序号
   * @param results   运单结果数组
   */
  async insertWaybillResults(
    taskId: string,
    batchSeq: number,
    results: WaybillResult[],
    tenantId: string = DEFAULT_TENANT_ID
  ): Promise<void> {
    if (results.length === 0) return;

    // Phase 2-B: 通过 task_id 查询 tasks.site_id，回填到 waybill_results.site_id
    const taskRow = await this.pool.query<{ site_id: string | null }>(
      `SELECT site_id FROM tasks WHERE id = $1 AND tenant_id = $2`,
      [taskId, tenantId]
    );
    const siteId = taskRow.rows.length > 0 ? taskRow.rows[0].site_id : null;

    // Phase 2-B: 每行 10 个字段（原 8 个 + tenant_id + site_id）
    const columnCount = 10;
    const values: unknown[] = [];
    const rows: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const base = i * columnCount;
      values.push(
        taskId,           // $1, $11, $21, ...
        batchSeq,         // $2, $12, $22, ...
        r.waybillNo,      // $3, ...
        r.staffName || null,  // $4, ...
        r.success,        // $5, ...
        r.message,        // $6, ...
        r.timestamp,      // $7, ...
        r.status || null, // $8, ...
        tenantId,         // $9, ...  (tenant_id)
        siteId            // $10, ... (site_id, 可空)
      );
      rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`);
    }

    // 单条 SQL：避免多次网络往返
    await this.pool.query(
      `INSERT INTO waybill_results (task_id, batch_seq, waybill_no, staff_name, success, message, timestamp, status, tenant_id, site_id)
       VALUES ${rows.join(', ')}`,
      values
    );
  }

  // ══════════════════════════════════════════════════════════
  // 4. upsertWaybillPool() — 运单池 UPSERT（对账基石）
  // ══════════════════════════════════════════════════════════

  /**
   * 更新运单池最新状态
   *
   * 使用 PostgreSQL INSERT ... ON CONFLICT DO UPDATE：
   *   - waybill_no 不存在 → INSERT 新记录
   *   - waybill_no 已存在 → UPDATE status / task_id / updated_at
   *
   * 这是"总部/商户对账找差集"的核心基础设施：
   *   - 运单池维护每个运单的最新状态
   *   - 对比外部系统数据即可找出差异运单
   *
   * @param waybillNo  运单号
   * @param siteId     所属网点
   * @param status     最新状态
   * @param taskId     最后一次处理此运单的任务
   */
  async upsertWaybillPool(
    waybillNo: string,
    siteId: string,
    status: string,
    taskId: string,
    tenantId: string = DEFAULT_TENANT_ID
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO waybill_pool (waybill_no, site_id, status, task_id, tenant_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (waybill_no) DO UPDATE
         SET status = EXCLUDED.status,
             task_id = EXCLUDED.task_id,
             tenant_id = EXCLUDED.tenant_id,
             updated_at = NOW()`,
      [waybillNo, siteId, status, taskId, tenantId]
    );
  }

  // ══════════════════════════════════════════════════════════
  // 5. insertTaskLogs() — 批量插入任务日志
  // ══════════════════════════════════════════════════════════

  /**
   * 批量插入任务日志
   *
   * 与 insertWaybillResults 采用相同的多行 VALUES 模式。
   * 参数化查询，全部使用 $N 占位符。
   *
   * Phase 4-C: task_logs.id 列为 UUID 类型，但调用方（AssignmentEngine）生成的 id
   * 格式为 "${Date.now()}-${random}" 不是合法 UUID，导致 INSERT 失败。
   * 修复：使用 PG 内置 gen_random_uuid() 生成主键，忽略调用方传入的非 UUID id。
   * task_logs.id 仅为自增主键，无外键引用，替换安全。
   *
   * @param logs  日志条目数组
   */
  async insertTaskLogs(
    logs: TaskLogEntry[],
    tenantId: string = DEFAULT_TENANT_ID
  ): Promise<void> {
    if (logs.length === 0) return;

    // Phase 2-B: 通过第一条日志的 task_id 查询 tasks.site_id 和 workstation_id
    const firstTaskId = logs[0]?.taskId;
    const taskRow = await this.pool.query<{ site_id: string | null; workstation_id: string | null }>(
      `SELECT site_id, workstation_id FROM tasks WHERE id = $1 AND tenant_id = $2`,
      [firstTaskId, tenantId]
    );
    const siteId = taskRow.rows.length > 0 ? taskRow.rows[0].site_id : null;
    const workstationId = taskRow.rows.length > 0 ? (taskRow.rows[0].workstation_id || DEFAULT_WORKSTATION_ID) : DEFAULT_WORKSTATION_ID;

    // Phase 2-D: 每行 10 个字段（原 9 个 + workstation_id）
    const columnCount = 10;
    const values: unknown[] = [];
    const rows: string[] = [];

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      const base = i * columnCount;
      values.push(
        log.taskId,
        log.timestamp,
        log.level,
        log.message,
        log.source,
        log.staffName || null,
        log.windowId || null,
        tenantId,          // tenant_id
        siteId,            // site_id (可空)
        workstationId      // workstation_id (Phase 2-D)
      );
      rows.push(`(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`);
    }

    await this.pool.query(
      `INSERT INTO task_logs (id, task_id, timestamp, level, message, source, staff_name, window_id, tenant_id, site_id, workstation_id)
       VALUES ${rows.join(', ')}`,
      values
    );
  }

  // ══════════════════════════════════════════════════════════
  // 6. getTaskLogs() — 查询任务日志
  // ══════════════════════════════════════════════════════════

  /**
   * 查询任务日志（按 timestamp 倒序，支持分页）
   *
   * @param taskId  任务 ID
   * @param limit   每页条数（默认 500）
   * @param offset  偏移量（默认 0）
   * @returns { logs: TaskLogEntry[], total: number }
   */
  async getTaskLogs(
    tenantId: string = DEFAULT_TENANT_ID,
    taskId: string,
    limit = 500,
    offset = 0
  ): Promise<{ logs: TaskLogEntry[]; total: number }> {
    const [dataResult, countResult] = await Promise.all([
      this.pool.query(
        `SELECT id, task_id, timestamp, level, message, source, staff_name, window_id, workstation_id
         FROM task_logs
         WHERE task_id = $1 AND tenant_id = $2
         ORDER BY timestamp DESC
         LIMIT $3 OFFSET $4`,
        [taskId, tenantId, limit, offset]
      ),
      this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM task_logs WHERE task_id = $1 AND tenant_id = $2`,
        [taskId, tenantId]
      ),
    ]);

    const logs: TaskLogEntry[] = dataResult.rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      timestamp: Number(row.timestamp),
      level: row.level as TaskLogEntry['level'],
      message: row.message,
      source: row.source,
      staffName: row.staff_name || undefined,
      windowId: row.window_id || undefined,
      workstationId: row.workstation_id || undefined,
    }));

    return { logs, total: parseInt(countResult.rows[0].cnt, 10) };
  }

  // ══════════════════════════════════════════════════════════
  // 7. getTaskWaybills() — 查询任务运单明细
  // ══════════════════════════════════════════════════════════

  /**
   * 查询任务下所有运单明细，支持按 status 和员工过滤
   *
   * @param taskId       任务 ID
   * @param statusFilter 可选状态过滤（SUCCESS / PARTIAL / FAILED 等）
   * @param staffFilter  可选员工过滤（staff_name）
   * @returns { waybills: WaybillResult[], total: number }
   */
  async getTaskWaybills(
    tenantId: string = DEFAULT_TENANT_ID,
    taskId: string,
    statusFilter?: string,
    staffFilter?: string,
  ): Promise<{ waybills: WaybillResult[]; total: number }> {
    // Phase 2-B: tenant_id 作为第一个条件，task_id 查询同时校验 tenant_id
    const conditions: string[] = ['task_id = $1', 'tenant_id = $2'];
    const params: unknown[] = [taskId, tenantId];
    let paramIdx = 3;

    if (statusFilter) {
      conditions.push(`status = $${paramIdx}`);
      params.push(statusFilter);
      paramIdx++;
    }

    if (staffFilter) {
      conditions.push(`staff_name = $${paramIdx}`);
      params.push(staffFilter);
      paramIdx++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [dataResult, countResult] = await Promise.all([
      this.pool.query(
        `SELECT waybill_no, staff_name, success, message, timestamp, status
         FROM waybill_results
         ${whereClause}
         ORDER BY timestamp DESC`,
        params
      ),
      this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM waybill_results ${whereClause}`,
        params
      ),
    ]);

    const waybills: WaybillResult[] = dataResult.rows.map((row: any) => ({
      waybillNo: row.waybill_no,
      staffName: row.staff_name || undefined,
      success: row.success,
      message: row.message || '',
      timestamp: Number(row.timestamp),
      status: row.status || undefined,
    }));

    return { waybills, total: parseInt(countResult.rows[0].cnt, 10) };
  }

  // ══════════════════════════════════════════════════════════
  // 8. getTaskSummary() — 任务摘要聚合查询
  // ══════════════════════════════════════════════════════════

  /**
   * 聚合查询：返回任务基础信息 + 各状态运单数量统计
   *
   * 一次 SQL 完成：task 信息 + 按 status 分组的 COUNT
   *
   * @param taskId  任务 ID
   * @returns 任务摘要（含运单统计）
   */
  async getTaskSummary(
    tenantId: string = DEFAULT_TENANT_ID,
    taskId: string
  ): Promise<{
    taskId: string;
    type: string;
    siteId: string;
    status: string;
    totalCount: number;
    doneCount: number;
    failCount: number;
    createdAt: string;
    finishedAt: string | null;
    successCount: number;
    partialCount: number;
    failedCount: number;
    unknownCount: number;
    workstationId?: string;
  } | null> {
    // Phase 2-B: task_id 查询同时校验 tenant_id
    const [taskResult, statsResult] = await Promise.all([
      this.pool.query(
        `SELECT id, type, site_id, status, total_count, done_count, fail_count, created_at, finished_at, workstation_id
         FROM tasks WHERE id = $1 AND tenant_id = $2`,
        [taskId, tenantId]
      ),
      this.pool.query<{ status: string; cnt: string }>(
        `SELECT COALESCE(status, 'UNKNOWN') AS status, COUNT(*)::text AS cnt
         FROM waybill_results
         WHERE task_id = $1 AND tenant_id = $2
         GROUP BY status`,
        [taskId, tenantId]
      ),
    ]);

    if (taskResult.rows.length === 0) return null;

    const t = taskResult.rows[0] as any;

    // 构建 status → count 映射
    const countMap: Record<string, number> = { SUCCESS: 0, PARTIAL: 0, FAILED: 0, UNKNOWN: 0 };
    for (const row of statsResult.rows) {
      const key = row.status === 'UNKNOWN_NEEDS_MANUAL_CHECK' ? 'UNKNOWN' : row.status;
      countMap[key] = (countMap[key] || 0) + parseInt(row.cnt, 10);
    }

    return {
      taskId: t.id,
      type: t.type,
      siteId: t.site_id,
      status: t.status,
      totalCount: t.total_count,
      doneCount: t.done_count,
      failCount: t.fail_count,
      createdAt: t.created_at instanceof Date ? t.created_at.toISOString() : String(t.created_at),
      finishedAt: t.finished_at
        ? (t.finished_at instanceof Date ? t.finished_at.toISOString() : String(t.finished_at))
        : null,
      successCount: countMap.SUCCESS || 0,
      partialCount: countMap.PARTIAL || 0,
      failedCount: countMap.FAILED || 0,
      unknownCount: countMap.UNKNOWN || 0,
      workstationId: t.workstation_id || undefined,
    };
  }

  // ══════════════════════════════════════════════════════════
  // 9. getTaskStaffSummary() — 任务执行人员统计
  // ══════════════════════════════════════════════════════════

  /**
   * 查询任务下所有执行人员的运单统计（SQL 聚合，禁止前端统计）
   *
   * 统计规则：
   *   - total: 全部记录数
   *   - successCount: success=true
   *   - failCount: success=false
   *
   * @param taskId  任务 ID
   * @returns 员工统计列表（可能为空数组）
   */
  async getTaskStaffSummary(
    tenantId: string = DEFAULT_TENANT_ID,
    taskId: string
  ): Promise<{
    staffName: string;
    total: number;
    successCount: number;
    failCount: number;
  }[]> {
    // 主查询：从 waybill_results 按 staff_name 聚合（Phase 2-B: 加 tenant_id 过滤）
    const result = await this.pool.query<{
      staff_name: string;
      cnt: string;
      success_cnt: string;
      fail_cnt: string;
    }>(
      `SELECT
         staff_name,
         COUNT(*)::text AS cnt,
         COUNT(*) FILTER (WHERE success)::text AS success_cnt,
         COUNT(*) FILTER (WHERE NOT success)::text AS fail_cnt
       FROM waybill_results
       WHERE task_id = $1
         AND tenant_id = $2
         AND staff_name IS NOT NULL
       GROUP BY staff_name
       ORDER BY staff_name`,
      [taskId, tenantId]
    );

    if (result.rows.length > 0) {
      return result.rows.map(row => ({
        staffName: row.staff_name,
        total: parseInt(row.cnt, 10),
        successCount: parseInt(row.success_cnt, 10),
        failCount: parseInt(row.fail_cnt, 10),
      }));
    }

    // 兜底：waybill_results 中无 staff_name 数据（历史 Arrival 任务）
    // 从 tasks.input_data.assignments 恢复员工→运单映射，再通过运单号关联结果
    const taskResult = await this.pool.query<{ input_data: any; site_id: string }>(
      `SELECT input_data, site_id FROM tasks WHERE id = $1 AND tenant_id = $2`,
      [taskId, tenantId]
    );

    if (taskResult.rows.length === 0 || !taskResult.rows[0].input_data) {
      return [];
    }

    const inputData = taskResult.rows[0].input_data;
    const assignments: Array<{ staffName: string; waybillNos: string[] }> =
      inputData.assignments || [];

    if (assignments.length === 0) {
      // 兼容旧 Arrival 模式：waybillNos 数组（无 assignment）
      const waybillNos: string[] = inputData.waybillNos || [];
      if (waybillNos.length === 0) return [];

      // 查所有 waybill_results，统计全局（单 Worker 场景）
      const statsResult = await this.pool.query<{ cnt: string; success_cnt: string; fail_cnt: string }>(
        `SELECT
           COUNT(*)::text AS cnt,
           COUNT(*) FILTER (WHERE success)::text AS success_cnt,
           COUNT(*) FILTER (WHERE NOT success)::text AS fail_cnt
         FROM waybill_results
         WHERE task_id = $1 AND tenant_id = $2`,
        [taskId, tenantId]
      );

      if (statsResult.rows.length === 0) return [];

      const stats = statsResult.rows[0];
      return [{
        staffName: '(管理员)',
        total: parseInt(stats.cnt, 10),
        successCount: parseInt(stats.success_cnt, 10),
        failCount: parseInt(stats.fail_cnt, 10),
      }];
    }

    // 多个 Assignment → 按员工统计
    const workerStats: Array<{ staffName: string; total: number; successCount: number; failCount: number }> = [];

    for (const assignment of assignments) {
      if (!assignment.waybillNos || assignment.waybillNos.length === 0) continue;

      const statsResult = await this.pool.query<{ cnt: string; success_cnt: string; fail_cnt: string }>(
        `SELECT
           COUNT(*)::text AS cnt,
           COUNT(*) FILTER (WHERE success)::text AS success_cnt,
           COUNT(*) FILTER (WHERE NOT success)::text AS fail_cnt
         FROM waybill_results
         WHERE task_id = $1
           AND tenant_id = $2
           AND waybill_no = ANY($3::text[])`,
        [taskId, tenantId, assignment.waybillNos]
      );

      const stats = statsResult.rows[0];
      const total = parseInt(stats.cnt, 10);
      if (total > 0) {
        workerStats.push({
          staffName: assignment.staffName,
          total,
          successCount: parseInt(stats.success_cnt, 10),
          failCount: parseInt(stats.fail_cnt, 10),
        });
      }
    }

    return workerStats;
  }

  // ══════════════════════════════════════════════════════════
  // 事务辅助
  // ══════════════════════════════════════════════════════════

  /**
   * 在事务中执行回调
   *
   * @param fn  业务逻辑。接收 PoolClient，可执行多次 query。
   *            抛出异常 → 自动 ROLLBACK；正常返回 → 自动 COMMIT
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ══════════════════════════════════════════════════════════
  // 生命周期
  // ══════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════
  // 10. workstations 基础查询（Phase 2-D）
  // ══════════════════════════════════════════════════════════

  /**
   * 确保默认工作站存在（幂等，启动时调用）
   *
   * 如有需要，写入默认 workstation 配置。
   * 实际插入由 migration 002 保证，此方法仅做运行时验证。
   */
  async ensureDefaultWorkstation(tenantId: string = DEFAULT_TENANT_ID): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM workstations
       WHERE id = $1 AND tenant_id = $2`,
      [DEFAULT_WORKSTATION_ID, tenantId]
    );
    return result.rows.length > 0;
  }

  /**
   * 查询指定工作站信息
   *
   * @param tenantId      租户 ID
   * @param workstationId 工作站 ID
   * @returns 工作站信息或 null
   */
  async getWorkstationById(
    tenantId: string = DEFAULT_TENANT_ID,
    workstationId: string
  ): Promise<{
    id: string;
    tenantId: string;
    name: string;
    status: string;
    onlineStatus: string;
    browserStatus: string;
    siteId: string | null;
  } | null> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, name, status, online_status, browser_status, site_id
       FROM workstations
       WHERE id = $1 AND tenant_id = $2`,
      [workstationId, tenantId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      status: row.status,
      onlineStatus: row.online_status,
      browserStatus: row.browser_status,
      siteId: row.site_id,
    };
  }

  // ══════════════════════════════════════════════════════════
  // 11. users / auth（Phase 3-B）
  // ══════════════════════════════════════════════════════════

  /**
   * 创建默认超级管理员（幂等，启动时调用一次）
   * 用户名和密码从环境变量读取，不硬编码。
   */
  async createBootstrapAdminIfMissing(): Promise<boolean> {
    const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!username || !password) {
      console.warn('[PG] BOOTSTRAP_ADMIN_USERNAME 或 BOOTSTRAP_ADMIN_PASSWORD 未设置，跳过默认管理员创建');
      return false;
    }

    // 动态导入密码模块（避免循环依赖）
    const { hashPassword, verifyPassword } = await import('../auth/password');
    const passwordHash = await hashPassword(password);

    // 检查是否已存在
    const existing = await this.pool.query(
      `SELECT id, password_hash FROM users WHERE tenant_id = $1 AND username = $2`,
      [DEFAULT_TENANT_ID, username]
    );
    if (existing.rows.length > 0) {
      const storedHash = existing.rows[0].password_hash;
      const matches = await verifyPassword(password, storedHash).catch(() => false);
      if (!matches) {
        await this.pool.query(
          `UPDATE users SET password_hash = $1 WHERE tenant_id = $2 AND username = $3`,
          [passwordHash, DEFAULT_TENANT_ID, username]
        );
        console.log(`[PG] 默认管理员密码已同步更新: ${username}`);
      }
      return true;
    }

    await this.pool.query(
      `INSERT INTO users (tenant_id, username, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [DEFAULT_TENANT_ID, username, passwordHash, 'super_admin', 'active']
    );
    console.log(`[PG] 默认超级管理员已创建: ${username}`);
    return true;
  }

  /** 按租户和用户名查询用户 */
  async getUserByUsername(tenantId: string, username: string): Promise<{
    id: string;
    tenantId: string;
    username: string;
    passwordHash: string;
    role: string;
    status: string;
  } | null> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, username, password_hash, role, status
       FROM users WHERE tenant_id = $1 AND username = $2`,
      [tenantId, username]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      status: row.status,
    };
  }

  /** 按 ID 查询用户 */
  async getUserById(tenantId: string, userId: string): Promise<{
    id: string;
    tenantId: string;
    username: string;
    role: string;
    status: string;
  } | null> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, username, role, status
       FROM users WHERE id = $1 AND tenant_id = $2`,
      [userId, tenantId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      username: row.username,
      role: row.role,
      status: row.status,
    };
  }

  /** 插入 Refresh Token hash */
  async insertRefreshToken(
    userId: string,
    tenantId: string,
    tokenHash: string,
    expiresAt: Date
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, tenantId, tokenHash, expiresAt]
    );
  }

  /** 查找 Refresh Token（未撤销、未过期） */
  async findRefreshToken(tokenHash: string): Promise<{
    id: string;
    userId: string;
    tenantId: string;
    expiresAt: Date;
  } | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, tenant_id, expires_at
       FROM refresh_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return {
      id: row.id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      expiresAt: row.expires_at,
    };
  }

  /** 撤销 Refresh Token */
  async revokeRefreshToken(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
      [tokenHash]
    );
  }

  /** 释放连接池（在应用停机时调用） */
  async close(): Promise<void> {
    await this.pool.end();
    PgDatabase.instance = null;
    this.initialized = false;
    console.log('[PgDatabase] 连接池已关闭');
  }

  // ══════════════════════════════════════════════════════════
  // 12. 租户/站点/工作站只读查询（Phase 3-F）
  // ══════════════════════════════════════════════════════════

  /** 获取租户信息 */
  async getTenantById(tenantId: string): Promise<{
    id: string;
    name: string;
    status: string;
    maxWorkstations: number;
    expiresAt: string | null;
    createdAt: string;
  } | null> {
    const result = await this.pool.query(
      `SELECT id, name, status, max_workstations, expires_at, created_at
       FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0] as any;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      maxWorkstations: r.max_workstations,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    };
  }

  /** 获取租户下所有站点 */
  async getSitesByTenant(tenantId: string): Promise<Array<{
    id: string;
    name: string;
    code: string | null;
    enabled: boolean;
    createdAt: string;
  }>> {
    const result = await this.pool.query(
      `SELECT id, name, code, enabled, created_at
       FROM sites WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      enabled: r.enabled,
      createdAt: r.created_at,
    }));
  }

  /** 获取租户下所有工作站 */
  async getWorkstationsByTenant(tenantId: string): Promise<Array<{
    id: string;
    name: string;
    siteId: string | null;
    status: string;
    onlineStatus: string;
    browserStatus: string;
    lastHeartbeatAt: string | null;
    createdAt: string;
  }>> {
    const result = await this.pool.query(
      `SELECT id, name, site_id, status, online_status, browser_status, last_heartbeat_at, created_at
       FROM workstations WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      siteId: r.site_id,
      status: r.status,
      onlineStatus: r.online_status,
      browserStatus: r.browser_status,
      lastHeartbeatAt: r.last_heartbeat_at,
      createdAt: r.created_at,
    }));
  }

  /** Phase 3-G: 获取租户下所有用户（不返回 password_hash） */
  async getUsersByTenant(tenantId: string): Promise<Array<{
    id: string;
    tenantId: string;
    username: string;
    role: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, username, role, status, created_at, updated_at
       FROM users WHERE tenant_id = $1 ORDER BY username`,
      [tenantId]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      tenantId: r.tenant_id,
      username: r.username,
      role: r.role,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // ══════════════════════════════════════════════════════════
  // 12. Agent Token 鉴权（Phase 4-E）
  // ══════════════════════════════════════════════════════════

  /**
   * 通过执行电脑授权码查询工作站
   *
   * 因 agent_token_hash 是 hash 值，无法直接 WHERE 查询。
   * 需遍历当前租户所有活跃工作站，逐个比对 hash。
   *
   * @param plainToken 明文 token（来自 HTTP 请求头）
   * @returns 工作站信息或 null
   */
  async getWorkstationByTokenHash(plainToken: string): Promise<{
    id: string;
    tenantId: string;
    siteId: string | null;
    name: string;
    status: string;
    tokenRevokedAt: string | null;
  } | null> {
    const { verifyAgentToken } = await import('../auth/agentToken');

    // 查询所有有 token hash 的工作站（不限 tenant，确保跨租户匹配）
    const result = await this.pool.query(
      `SELECT id, tenant_id, site_id, name, status, agent_token_hash, agent_token_revoked_at
       FROM workstations
       WHERE agent_token_hash IS NOT NULL
         AND status != 'deleted'`
    );

    for (const row of result.rows) {
      const r = row as any;
      if (!r.agent_token_hash) continue;
      if (verifyAgentToken(plainToken, r.agent_token_hash)) {
        return {
          id: r.id,
          tenantId: r.tenant_id,
          siteId: r.site_id,
          name: r.name,
          status: r.status,
          tokenRevokedAt: r.agent_token_revoked_at,
        };
      }
    }

    return null;
  }

  /**
   * 更新执行电脑授权码的最后使用时间
   *
   * @param workstationId 工作站 ID
   */
  async touchAgentToken(workstationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE workstations
       SET agent_token_last_used_at = NOW()
       WHERE id = $1`,
      [workstationId]
    );
  }

  /**
   * 更新工作站心跳状态
   *
   * @param params 心跳参数
   */
  async updateWorkstationHeartbeat(params: {
    workstationId: string;
    tenantId: string;
    browserStatus: string;
    agentVersion: string;
    machineFingerprint: string;
    lastIp: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE workstations
       SET online_status       = 'online',
           browser_status      = $3,
           last_heartbeat_at   = NOW(),
           agent_version       = $4,
           machine_fingerprint = $5,
           last_ip             = $6,
           updated_at          = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [
        params.workstationId,
        params.tenantId,
        params.browserStatus,
        params.agentVersion,
        params.machineFingerprint,
        params.lastIp,
      ]
    );
  }

  // ══════════════════════════════════════════════════════════
  // 13. Agent 任务管道（Phase 4-F）
  // ══════════════════════════════════════════════════════════

  /**
   * 原子拉取一个待执行的 agent_test 任务
   *
   * 规则：
   *   1. 只拉取当前租户下的 pending 任务
   *   2. 第一版只拉取 type=agent_test
   *   3. 分配原子化（SELECT ... FOR UPDATE SKIP LOCKED）
   *   4. 拉取成功后更新 status=assigned, workstation_id, assigned_at
   *
   * @param tenantId      租户 ID
   * @param workstationId 执行电脑 ID
   * @returns 任务信息或 null（无待执行任务）
   */
  async pullPendingTask(
    tenantId: string,
    workstationId: string
  ): Promise<{
    id: string;
    type: string;
    siteId: string;
    status: string;
    totalCount: number;
    inputData: Record<string, unknown> | null;
    createdAt: string;
  } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 原子化：SELECT ... FOR UPDATE SKIP LOCKED 防止并发抢任务
      const result = await client.query(
        `SELECT id, type, site_id, status, total_count, input_data, created_at
         FROM tasks
         WHERE tenant_id = $1
           AND status = 'pending'
           AND type IN ('agent_test', 'arrival', 'dispatch', 'integrated', 'sign')
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [tenantId]
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const row = result.rows[0] as any;

      // 更新为 assigned
      await client.query(
        `UPDATE tasks
         SET status = 'assigned',
             workstation_id = $2,
             assigned_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, workstationId]
      );

      await client.query('COMMIT');

      return {
        id: row.id,
        type: row.type,
        siteId: row.site_id,
        status: 'assigned',
        totalCount: row.total_count,
        inputData: row.input_data,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 更新任务进度
   *
   * @param taskId          任务 ID
   * @param tenantId        租户 ID
   * @param workstationId   执行电脑 ID
   * @param progress        进度值（0-100）
   * @param status          新状态（assigned → running）
   */
  async updateTaskProgress(
    taskId: string,
    tenantId: string,
    workstationId: string,
    progress: number,
    status: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE tasks
       SET progress = GREATEST(progress, $4),
           status = CASE WHEN $5 = 'running' AND status = 'assigned' THEN 'running' ELSE status END,
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND workstation_id = $3`,
      [taskId, tenantId, workstationId, progress, status]
    );
  }

  /**
   * 员任务为 done
   *
   * 规则：
   *   1. 只允许 running/assigned 状态的任务 complete
   *   2. 已 done 的不重复写
   *
   * @returns true=操作成功，false=任务已终态（already finished）
   */
  async completeAgentTask(
    taskId: string,
    tenantId: string,
    workstationId: string,
    counts?: { doneCount?: number; failCount?: number; finalStatus?: 'done' | 'failed' }
  ): Promise<boolean> {
    const finalStatus = counts?.finalStatus || 'done';
    const result = await this.pool.query(
      `UPDATE tasks
       SET status = $4,
           progress = 100,
           done_count = COALESCE($5, done_count),
           fail_count = COALESCE($6, fail_count),
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND workstation_id = $3
         AND status IN ('assigned', 'running')`,
      [taskId, tenantId, workstationId, finalStatus, counts?.doneCount, counts?.failCount]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * 标记任务为 failed
   *
   * 规则：
   *   1. 只允许 running/assigned 状态的任务 fail
   *   2. 已 done 的不允许 fail
   *
   * @returns true=操作成功，false=任务已终态
   */
  async failAgentTask(
    taskId: string,
    tenantId: string,
    workstationId: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE tasks
       SET status = 'failed',
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND workstation_id = $3
         AND status IN ('assigned', 'running')`,
      [taskId, tenantId, workstationId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * 检查是否有待执行任务
   *
   * @param tenantId 租户 ID
   * @returns 是否有 pending 的 agent_test 任务
   */
  async hasPendingTask(tenantId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM tasks
       WHERE tenant_id = $1
         AND status = 'pending'
         AND type IN ('agent_test', 'arrival', 'dispatch', 'integrated', 'sign')
       LIMIT 1`,
      [tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ══════════════════════════════════════════════════════════
  // Phase Deploy-0C: Agent 窗口状态上报
  // ══════════════════════════════════════════════════════════

  /**
   * Upsert Agent 上报的窗口状态
   *
   * 唯一键: (tenant_id, site_id, workstation_id, window_id)
   * 冲突时更新全部字段
   */
  async upsertWindowStatus(params: {
    tenantId: string;
    siteId: string;
    workstationId: string;
    windowId: string;
    staffName: string;
    status: string;
    statusText: string;
    currentUrl?: string;
    isProcessAlive: boolean;
    isCdpReady: boolean;
    isDashboardReady: boolean;
    isLoginPage: boolean;
    lastError?: string | null;
    cdpEndpoint?: string | null;
    profilePath?: string | null;
    chromePid?: number | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO window_status (
        tenant_id, site_id, workstation_id, window_id, staff_name,
        status, status_text, current_url, is_process_alive, is_cdp_ready,
        is_dashboard_ready, is_login_page, last_error, cdp_endpoint,
        profile_path, chrome_pid, last_heartbeat_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
      ON CONFLICT (tenant_id, site_id, workstation_id, window_id)
      DO UPDATE SET
        staff_name = EXCLUDED.staff_name,
        status = EXCLUDED.status,
        status_text = EXCLUDED.status_text,
        current_url = EXCLUDED.current_url,
        is_process_alive = EXCLUDED.is_process_alive,
        is_cdp_ready = EXCLUDED.is_cdp_ready,
        is_dashboard_ready = EXCLUDED.is_dashboard_ready,
        is_login_page = EXCLUDED.is_login_page,
        last_error = EXCLUDED.last_error,
        cdp_endpoint = EXCLUDED.cdp_endpoint,
        profile_path = EXCLUDED.profile_path,
        chrome_pid = EXCLUDED.chrome_pid,
        last_heartbeat_at = NOW(),
        updated_at = NOW()`,
      [
        params.tenantId, params.siteId, params.workstationId, params.windowId, params.staffName,
        params.status, params.statusText, params.currentUrl || null, params.isProcessAlive, params.isCdpReady,
        params.isDashboardReady, params.isLoginPage, params.lastError || null, params.cdpEndpoint || null,
        params.profilePath || null, params.chromePid || null,
      ]
    );
  }

  /**
   * 按 tenantId + siteId 查询窗口状态列表
   */
  async getWindowStatusBySite(tenantId: string, siteId: string): Promise<Array<{
    siteId: string;
    workstationId: string;
    windowId: string;
    staffName: string;
    status: string;
    statusText: string;
    currentUrl: string | null;
    isProcessAlive: boolean;
    isCdpReady: boolean;
    isDashboardReady: boolean;
    isLoginPage: boolean;
    lastHeartbeatAt: string;
    updatedAt: string;
    lastError: string | null;
  }>> {
    const result = await this.pool.query(
      `SELECT
        site_id, workstation_id, window_id, staff_name,
        status, status_text, current_url,
        is_process_alive, is_cdp_ready, is_dashboard_ready, is_login_page,
        last_heartbeat_at, updated_at, last_error
      FROM window_status
      WHERE tenant_id = $1 AND site_id = $2
      ORDER BY updated_at DESC`,
      [tenantId, siteId]
    );
    return result.rows.map(r => ({
      siteId: r.site_id,
      workstationId: r.workstation_id,
      windowId: r.window_id,
      staffName: r.staff_name,
      status: r.status,
      statusText: r.status_text,
      currentUrl: r.current_url,
      isProcessAlive: r.is_process_alive,
      isCdpReady: r.is_cdp_ready,
      isDashboardReady: r.is_dashboard_ready,
      isLoginPage: r.is_login_page,
      lastHeartbeatAt: r.last_heartbeat_at ? new Date(r.last_heartbeat_at).toISOString() : '',
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : '',
      lastError: r.last_error,
    }));
  }

  // ══════════════════════════════════════════════════════════
  // Phase Deploy-0D: Window connections from persisted status
  // ══════════════════════════════════════════════════════════

  /**
   * 查询 ready 状态的窗口连接信息（优先从 Agent 上报的 window_status）
   *
   * 仅返回 cdp_endpoint 不为空、status=ready、未过期的窗口。
   * 用于 /agent/window-connections 优先数据源。
   */
  async getReadyWindowConnectionsFromStatus(tenantId: string, siteId?: string): Promise<Array<{
    siteId: string;
    windowId: string;
    staffName: string;
    cdpEndpoint: string;
    cdpAttachable: boolean;
    status: string;
  }>> {
    const conditions: string[] = [
      'tenant_id = $1',
      'status = \'ready\'',
      'is_cdp_ready = true',
      'is_dashboard_ready = true',
      'cdp_endpoint IS NOT NULL',
      'last_heartbeat_at > NOW() - INTERVAL \'60 seconds\'',
    ];
    const params: unknown[] = [tenantId];
    let paramIdx = 2;

    if (siteId) {
      conditions.push(`site_id = $${paramIdx}`);
      params.push(siteId);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const result = await this.pool.query(
      `SELECT site_id, window_id, staff_name, cdp_endpoint, status
       FROM window_status
       WHERE ${whereClause}
       ORDER BY updated_at DESC`,
      params
    );

    return result.rows.map((r: any) => ({
      siteId: r.site_id,
      windowId: r.window_id,
      staffName: r.staff_name,
      cdpEndpoint: r.cdp_endpoint,
      cdpAttachable: true,
      status: 'ready',
    }));
  }

  // ══════════════════════════════════════════════════════════
  // Phase Deploy-0D: Window Commands CRUD
  // ══════════════════════════════════════════════════════════

  /** 窗口命令插入参数 */
  async createWindowCommand(params: {
    id: string;
    tenantId: string;
    siteId: string;
    workstationId: string;
    windowId: string;
    staffName: string;
    type: string;
  }): Promise<string> {
    await this.pool.query(
      `INSERT INTO window_commands (id, tenant_id, site_id, workstation_id, window_id, staff_name, type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [params.id, params.tenantId, params.siteId, params.workstationId, params.windowId, params.staffName, params.type]
    );
    return params.id;
  }

  /**
   * 原子 claim 待执行的窗口命令
   *
   * 使用 SELECT ... FOR UPDATE SKIP LOCKED 防止并发抢夺。
   * 只拉取本 workstation 的 pending 命令，claim 后状态变为 claimed。
   */
  async claimPendingWindowCommands(
    tenantId: string,
    workstationId: string,
    limit: number = 10,
  ): Promise<Array<{
    id: string;
    tenantId: string;
    siteId: string;
    workstationId: string;
    windowId: string;
    staffName: string;
    type: string;
    params: Record<string, unknown>;
  }>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, tenant_id, site_id, workstation_id, window_id, staff_name, type, params
         FROM window_commands
         WHERE tenant_id = $1
           AND workstation_id = $2
           AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED`,
        [tenantId, workstationId, limit]
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return [];
      }

      const ids = result.rows.map(r => r.id);

      await client.query(
        `UPDATE window_commands
         SET status = 'claimed', claimed_at = NOW(), updated_at = NOW()
         WHERE id = ANY($1::text[])`,
        [ids]
      );

      await client.query('COMMIT');

      return result.rows.map(r => ({
        id: r.id,
        tenantId: r.tenant_id,
        siteId: r.site_id,
        workstationId: r.workstation_id,
        windowId: r.window_id,
        staffName: r.staff_name,
        type: r.type,
        params: (r.params as Record<string, unknown>) || {},
      }));
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** 标记命令为 running */
  async markWindowCommandRunning(commandId: string): Promise<void> {
    await this.pool.query(
      `UPDATE window_commands
       SET status = 'running', started_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'claimed'`,
      [commandId]
    );
  }

  /** 命令执行完成 */
  async completeWindowCommand(commandId: string, result?: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE window_commands
       SET status = 'done', result = $2, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN ('claimed', 'running')`,
      [commandId, result ? JSON.stringify(result) : null]
    );
  }

  /** 命令执行失败 */
  async failWindowCommand(commandId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE window_commands
       SET status = 'failed', error = $2, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN ('claimed', 'running')`,
      [commandId, error]
    );
  }

  /** 查询单个命令 */
  async getWindowCommandById(commandId: string): Promise<{
    id: string;
    tenantId: string;
    siteId: string;
    workstationId: string;
    windowId: string;
    staffName: string;
    type: string;
    status: string;
    result: Record<string, unknown> | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  } | null> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, site_id, workstation_id, window_id, staff_name,
              type, status, result, error, created_at, updated_at
       FROM window_commands
       WHERE id = $1`,
      [commandId]
    );

    if (result.rows.length === 0) return null;

    const r = result.rows[0] as any;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      siteId: r.site_id,
      workstationId: r.workstation_id,
      windowId: r.window_id,
      staffName: r.staff_name,
      type: r.type,
      status: r.status,
      result: r.result || null,
      error: r.error || null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
  }

  /** 查询最近的窗口命令 */
  async listRecentWindowCommands(
    tenantId: string,
    siteId: string,
    limit: number = 20,
  ): Promise<Array<{
    id: string;
    windowId: string;
    staffName: string;
    type: string;
    status: string;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  }>> {
    const result = await this.pool.query(
      `SELECT id, window_id, staff_name, type, status, error, created_at, updated_at
       FROM window_commands
       WHERE tenant_id = $1 AND site_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [tenantId, siteId, limit]
    );

    return result.rows.map((r: any) => ({
      id: r.id,
      windowId: r.window_id,
      staffName: r.staff_name,
      type: r.type,
      status: r.status,
      error: r.error || null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    }));
  }
}
