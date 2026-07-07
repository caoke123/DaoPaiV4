/**
 * 系统设置管理器 — 独立于业务数据库
 *
 * 存储文件: data/settings.json
 * 数据安全:
 *   - PIN 码: SHA-256(pin + salt)，不可逆
 *   - 密码: Base64 编码存储（非加密，仅防明眼看）
 *   - 写入: 原子写入 (.tmp → rename)，防断电损坏
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ── 类型 ──

export interface SettingsWindowEntry {
  windowName: string;
  employeeName: string;
  username: string;
  /** Base64 编码的密码（存储格式）；Phase 4-C 允许为空（空密码 = 仅目标派件员） */
  password: string;
  /** EasyBR 浏览器 ID（精准定位，无需模糊匹配） */
  easybrBrowserId?: string;
}

/** Phase 4-C: 员工账号能力判断 */

/** 可作为执行窗口的员工：有姓名、有账号、有密码 */
export function isLoginCapableWindow(w: Pick<SettingsWindowEntry, 'employeeName' | 'username' | 'password'>): boolean {
  return !!(w.employeeName && w.username && w.password);
}

/** 可作为目标派件员的员工：有姓名、有账号（不要求密码） */
export function isTargetableEmployee(w: Pick<SettingsWindowEntry, 'employeeName' | 'username'>): boolean {
  return !!(w.employeeName && w.username);
}

export interface SettingsSite {
  id: string;
  name: string;
  windows: SettingsWindowEntry[];
}

export interface DataRetentionConfig {
  /** 任务记录保留天数：30/60/90/180/-1（-1=永久保留） */
  retentionDays: number;
  /** 自动清理频率: 'weekly'|'monthly'|'off' */
  cleanupFrequency: 'weekly' | 'monthly' | 'off';
}

export interface RuntimeConfig {
  /** 试运行模式：true=跳过最终提交按钮，false=真实执行；缺省/读取失败默认true（安全优先） */
  dryRunMode: boolean;
}

const DEFAULT_RETENTION: DataRetentionConfig = {
  retentionDays: 30,
  cleanupFrequency: 'weekly',
};

const DEFAULT_RUNTIME: RuntimeConfig = {
  dryRunMode: true,
};

export interface SettingsData {
  initialized: boolean;
  pinHash: string;
  pinSalt: string;
  sites: SettingsSite[];
  dataRetention?: DataRetentionConfig;
  runtime?: RuntimeConfig;
}

/** API 返回给前端的格式（密码已解码为明文） */
export interface PublicSiteConfig {
  id: string;
  name: string;
  windows: {
    windowName: string;
    employeeName: string;
    username: string;
    password: string; // 明文
    easybrBrowserId?: string;
  }[];
}

export interface PublicSettingsResponse {
  initialized: boolean;
  sites: PublicSiteConfig[];
  dataRetention: DataRetentionConfig;
}

// ── 常量 ──

const SETTINGS_FILE = path.resolve(__dirname, '..', '..', 'data', 'settings.json');
const SALT_BYTES = 16;

// ── 工具函数 ──

function hashPin(pin: string, salt: string): string {
  return crypto.createHash('sha256').update(pin + salt).digest('hex');
}

function generateSalt(): string {
  return crypto.randomBytes(SALT_BYTES).toString('hex');
}

/** 将存储格式的 sites 转为 API 响应格式（密码 Base64 → 明文） */
function sitesToPublic(entry: SettingsSite[]): PublicSiteConfig[] {
  return entry.map((s) => ({
    ...s,
    windows: s.windows.map((w) => ({
      windowName: w.windowName,
      employeeName: w.employeeName,
      username: w.username,
      password: decodePassword(w.password),
      easybrBrowserId: w.easybrBrowserId,
    })),
  }));
}

/** 将前端提交的配置转为存储格式（密码明文 → Base64） */
function sitesToStorage(entry: PublicSiteConfig[]): SettingsSite[] {
  return entry.map((s) => ({
    ...s,
    windows: s.windows.map((w) => ({
      windowName: w.windowName,
      employeeName: w.employeeName,
      username: w.username,
      password: encodePassword(w.password),
      easybrBrowserId: w.easybrBrowserId,
    })),
  }));
}

function encodePassword(plain: string): string {
  return Buffer.from(plain, 'utf-8').toString('base64');
}

function decodePassword(encoded: string): string {
  try {
    return Buffer.from(encoded, 'base64').toString('utf-8');
  } catch {
    return encoded; // 兼容旧明文数据
  }
}

// ── 文件读写 ──

async function readSettingsFile(): Promise<SettingsData | null> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw) as SettingsData;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 原子写入：先写 .tmp，再 rename 覆盖
 * 防止写入中途崩溃导致 settings.json 损坏
 */
async function writeSettingsFile(data: SettingsData): Promise<void> {
  const tmpPath = SETTINGS_FILE + '.tmp';
  const dir = path.dirname(SETTINGS_FILE);

  // 确保 data 目录存在
  await fs.mkdir(dir, { recursive: true });

  // 1. 写入临时文件
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, json, 'utf-8');

  // 2. 原子替换
  await fs.rename(tmpPath, SETTINGS_FILE);
}

// ── 单例 ──

let instance: SettingsManager | null = null;

export class SettingsManager {
  public static getInstance(): SettingsManager {
    if (!instance) {
      instance = new SettingsManager();
    }
    return instance;
  }

  private constructor() {}

  // ── 公开方法 ──

  /**
   * 首次初始化系统：创建 PIN + 空站点配置
   */
  async init(pin: string): Promise<void> {
    const existing = await readSettingsFile();
    if (existing?.initialized) {
      throw new Error('系统已初始化，不能重复 init');
    }

    const pinSalt = generateSalt();
    const pinHash = hashPin(pin, pinSalt);

    const data: SettingsData = {
      initialized: true,
      pinHash,
      pinSalt,
      sites: [],
    };

    await writeSettingsFile(data);
    console.log('[SettingsManager] 系统初始化完成');
  }

  /**
   * 验证 PIN 码
   */
  async verifyPin(pin: string): Promise<boolean> {
    const data = await readSettingsFile();
    if (!data?.initialized) {
      throw new Error('系统未初始化');
    }

    const computed = hashPin(pin, data.pinSalt);
    return computed === data.pinHash;
  }

  /**
   * 获取配置（密码解码为明文）
   */
  async getConfig(): Promise<PublicSettingsResponse> {
    const data = await readSettingsFile();
    if (!data?.initialized) {
      throw new Error('NOT_INITIALIZED');
    }

    return {
      initialized: true,
      sites: sitesToPublic(data.sites),
      dataRetention: data.dataRetention ?? DEFAULT_RETENTION,
    };
  }

  /**
   * 更新配置（密码明文 → Base64 存储）
   */
  async updateConfig(sites: PublicSiteConfig[]): Promise<void> {
    const data = await readSettingsFile();
    if (!data?.initialized) {
      throw new Error('系统未初始化');
    }

    data.sites = sitesToStorage(sites);
    await writeSettingsFile(data);
    console.log(`[SettingsManager] 配置已保存: ${sites.length} 个网点`);
  }

  /**
   * 获取数据保留配置
   */
  async getDataRetention(): Promise<DataRetentionConfig> {
    const data = await readSettingsFile();
    return data?.dataRetention ?? DEFAULT_RETENTION;
  }

  /**
   * 更新数据保留配置
   */
  async updateDataRetention(config: DataRetentionConfig): Promise<void> {
    const data = await readSettingsFile();
    if (!data?.initialized) {
      throw new Error('系统未初始化');
    }
    data.dataRetention = config;
    await writeSettingsFile(data);
    console.log(`[SettingsManager] 数据保留配置已更新: ${config.retentionDays}天, ${config.cleanupFrequency}`);
  }

  /**
   * 获取试运行模式开关（安全优先：缺省/读取失败均返回 true）
   */
  async getDryRunMode(): Promise<boolean> {
    try {
      const data = await readSettingsFile();
      if (!data?.initialized) return true;
      return data.runtime?.dryRunMode !== false;
    } catch {
      return true;
    }
  }

  /**
   * Phase M-3B: 统一解析任务级 dryRun
   *
   * 优先级（与 Agent Executor 保持一致）：
   *   1. inputData.dryRunMode（Phase M-3B 主字段）
   *   2. inputData.browserDryRun（兼容旧字段）
   *   3. inputData.dryRun（兼容旧字段）
   *   4. SettingsManager.getDryRunMode()（全局兜底）
   *
   * 返回 browserDryRun boolean 和来源标识
   */
  static async resolveTaskDryRun(inputData: unknown): Promise<{ browserDryRun: boolean; source: string }> {
    const data = inputData as Record<string, unknown> | null | undefined;

    // Phase M-3B: dryRunMode 优先
    if (data && typeof data.dryRunMode === 'boolean') {
      return { browserDryRun: data.dryRunMode, source: 'task.inputData.dryRunMode' };
    }

    // 兼容旧字段 browserDryRun
    if (data && typeof data.browserDryRun === 'boolean') {
      return { browserDryRun: data.browserDryRun, source: 'task.inputData.browserDryRun (compat)' };
    }

    // 兼容旧字段 dryRun
    if (data && typeof data.dryRun === 'boolean') {
      return { browserDryRun: data.dryRun, source: 'task.inputData.dryRun (compat)' };
    }

    // 全局兜底
    const sm = SettingsManager.getInstance();
    const globalDryRun = await sm.getDryRunMode();
    return { browserDryRun: globalDryRun, source: 'SettingsManager fallback' };
  }

  /**
   * Phase 5-I-1: 真实提交安全门
   *
   * 当 dryRun=false 时，检查是否允许真实提交。
   * 需要环境变量 ENABLE_REAL_SUBMIT=true 才允许。
   * 默认 false（安全优先）。
   */
  static isRealSubmitAllowed(): boolean {
    return process.env.ENABLE_REAL_SUBMIT === 'true';
  }

  /**
   * 设置试运行模式
   */
  async setDryRunMode(enabled: boolean): Promise<void> {
    const data = await readSettingsFile();
    if (!data?.initialized) {
      throw new Error('系统未初始化');
    }
    if (!data.runtime) {
      data.runtime = { ...DEFAULT_RUNTIME };
    }
    data.runtime.dryRunMode = enabled;
    await writeSettingsFile(data);
    console.log(`[SettingsManager] 运行模式已更新: ${enabled ? '试运行模式' : '真实执行模式'}`);
  }

  /**
   * ★ P0 安全加固：校验员工是否属于指定站点
   *
   * 用于后端任务创建前拒绝跨站点 assignments。
   * 只查 settings.json 当前站点 windows，不依赖 credentials.ts。
   *
   * siteInput 支持三种格式：
   *   - site.id（如 'site-1782121346155'）
   *   - siteCode（如 'tiannanda' / 'heyuan'）
   *   - 中文站点名（如 '天南大' / '和苑'）
   *
   * staffName 匹配字段：
   *   - window.employeeName 精确匹配
   *   - window.windowName 包含 staffName
   *
   * @returns true=属于该站点；false=不属于或站点不存在
   */
  async isStaffBelongsToSite(siteInput: string, staffName: string): Promise<boolean> {
    try {
      const config = await this.getConfig();
      for (const s of config.sites) {
        // site 匹配：支持 site.id / site.name / siteCode
        const siteMatch =
          s.id === siteInput
          || s.name === siteInput
          || (siteInput === 'tiannanda' && s.name.includes('天南大'))
          || (siteInput === 'heyuan' && s.name.includes('和苑'));
        if (!siteMatch) continue;

        // 在该站点的 windows 中查找 staffName
        for (const w of s.windows) {
          const nameMatch = w.employeeName === staffName
            || w.windowName.includes(staffName);
          if (nameMatch) return true;
        }
        // 站点匹配但员工不在该站点 → 不继续搜索其他站点
        return false;
      }
      // 站点未找到
      return false;
    } catch (e) {
      console.warn(`[SettingsManager] isStaffBelongsToSite 校验失败: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * 统一解析员工窗口凭据 — 设置中心优先，credentials.ts 兜底
   *
   * 查找顺序：
   *   1. settings.json sites[].windows[]（按 browserId 精确匹配，或 staffName 模糊匹配）
   *   2. credentials.ts findCredential(staffName) 兜底
   *
   * employeeId 规则：
   *   settings: window.employeeId || window.username
   *   credentials: credential.account
   */
  async resolveWorkerCredential(input: {
    site?: string;
    staffName: string;
    browserId?: string;
  }): Promise<{
    staffName: string;
    employeeId: string;
    account: string;
    password: string;
    easybrBrowserId?: string;
    windowName: string;
    source: 'settings' | 'credentials';
  }> {
    const { site, staffName, browserId } = input;

    // 1. 优先从 settings.json 查找
    try {
      const config = await this.getConfig();
      for (const s of config.sites) {
        // site 匹配：支持 site.id 和 site.name（内部 Site code 通过 name 推导）
        const siteMatch = !site
          || s.id === site
          || s.name === site
          || (site === 'tiannanda' && s.name.includes('天南大'))
          || (site === 'heyuan' && s.name.includes('和苑'));
        if (!siteMatch) continue;

        for (const w of s.windows) {
          // browserId 精确匹配优先
          if (browserId && w.easybrBrowserId && w.easybrBrowserId !== browserId) continue;

          // 员工名匹配：employeeName / windowName 包含 staffName
          const nameMatch = w.employeeName === staffName
            || w.windowName.includes(staffName)
            || (browserId && w.easybrBrowserId === browserId);
          if (!nameMatch) continue;

          if (w.username && w.password) {
            const employeeId = (w as SettingsWindowEntry & { employeeId?: string }).employeeId || w.username;
            console.log(`[worker-credential] matched source=settings staffName=${w.employeeName} employeeId=${employeeId} password=存在`);
            return {
              staffName: w.employeeName,
              employeeId,
              account: w.username,
              password: w.password,
              easybrBrowserId: w.easybrBrowserId,
              windowName: w.windowName,
              source: 'settings',
            };
          }
        }
      }
    } catch (e) {
      console.warn(`[worker-credential] 读取 settings.json 失败: ${(e as Error).message}`);
    }

    // 2. 兜底 credentials.ts
    // ★ P0 安全加固：fallback 前检查员工是否属于其他站点，禁止跨站点返回凭据
    // 注意：只在员工明确属于"其他站点"时才拒绝；
    //       如果员工不在 settings.json 任何站点中（可能是配置不完整），仍允许 fallback
    if (site) {
      const config = await this.getConfig();
      for (const s of config.sites) {
        // 跳过当前站点
        const isCurrentSite = s.id === site
          || s.name === site
          || (site === 'tiannanda' && s.name.includes('天南大'))
          || (site === 'heyuan' && s.name.includes('和苑'));
        if (isCurrentSite) continue;
        // 检查其他站点是否有此员工
        for (const w of s.windows) {
          if (w.employeeName === staffName || w.windowName.includes(staffName)) {
            throw new Error(`员工 "${staffName}" 不属于当前网点，无法解析凭据，请切换网点后重新选择员工。`);
          }
        }
      }
    }
    const { findCredential } = await import('./credentials');
    const fallback = findCredential(staffName);
    if (fallback) {
      console.log(`[worker-credential] matched source=credentials staffName=${staffName} employeeId=${fallback.account} password=存在`);
      return {
        staffName: fallback.name,
        employeeId: fallback.account,
        account: fallback.account,
        password: fallback.password,
        windowName: staffName,
        source: 'credentials',
      };
    }

    // 3. 未找到
    throw new Error(`未找到员工 "${staffName}" 的设置中心窗口配置，无法解析 employeeId，请检查设置中心账号信息。`);
  }
}
