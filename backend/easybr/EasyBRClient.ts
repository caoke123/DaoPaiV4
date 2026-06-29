// ────────────────────────────────────────────────────────────
// ⚠️ LEGACY 模块 — bnsy-operator-next 标记为待替换
// ────────────────────────────────────────────────────────────
// 本模块为从生产项目 bnsy-operator/ 复制而来的 EasyBR 集成代码。
// bnsy-operator-next 的架构方向是使用 Playwright 原生管理浏览器窗口，
// 不再依赖 EasyBR 指纹浏览器。
//
// 当前阶段（初始化隔离）保留此代码避免破坏现有任务执行逻辑，
// 后续阶段将逐步替换为 Playwright BrowserContext + persistent context 方案。
// 禁止在新代码中新增对 EasyBRClient 的依赖。
// ────────────────────────────────────────────────────────────

// EasyBRClient — EasyBR 本地 API 统一访问入口
// Phase D-1: 封装 getBrowerList / openBrower / closeBrower / openedList
// 提供统一重试/超时/错误处理，禁止其他模块直接 axios 访问 http://127.0.0.1:3001

import axios, { type AxiosInstance } from 'axios';

// ── 类型定义 ──────────────────────────────────────────

/** EasyBR 浏览器配置项 */
export interface BrowserConfig {
  browerid: string;
  browername: string;
}

/** openBrower 返回的 CDP 连接信息 */
export interface OpenBrowerResult {
  ws: string;
  http: string;
  session: string;
}

/** openedList 返回的已打开窗口 */
export interface OpenedWindow {
  browerid: string;
  browername: string;
  isopen: boolean;
}

// ── 错误类型 ──────────────────────────────────────────

/** EasyBRClient 专用错误 */
export class EasyBRClientError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'EasyBRClientError';
    this.code = code;
  }
}

/** Phase G-2: 熔断器错误 */
export class EasyBRCircuitOpenError extends EasyBRClientError {
  constructor(message: string) {
    super(message, 'CIRCUIT_OPEN');
    this.name = 'EasyBRCircuitOpenError';
  }
}

// ── API 响应类型 ──────────────────────────────────────

interface ApiResponse<T> {
  code: number;
  data: T;
  msg?: string;
}

// ── EasyBRClient 类 ───────────────────────────────────

export class EasyBRClient {
  private static instance: EasyBRClient | null = null;

  private readonly baseUrl = 'http://127.0.0.1:3001';
  private readonly axios: AxiosInstance;
  private readonly maxRetries = 2;
  private readonly retryDelay = 500;

  private stats = {
    getBrowerListCalls: 0,
    openedListCalls: 0,
    openBrowerCalls: 0,
    closeBrowerCalls: 0,
    errors: 0,
    retries: 0,
  };

  // Phase G-2: 熔断器配置
  // 连续失败 5 次进入熔断状态，暂停连接 5 分钟
  private static readonly CIRCUIT_FAILURE_THRESHOLD = 5;
  private static readonly CIRCUIT_RESET_MS = 5 * 60 * 1000; // 5 分钟

  /** 熔断器状态 */
  private circuitBreaker = {
    failureCount: 0,
    isOpen: false,
    openedAt: 0,
  };

  // ── 步骤5: openedList 异常持续监控 ──
  // 当 getBrowerList 返回非空（配置正常）但 openedList 连续返回空时，标记为异常
  // 30s 内静默信任 BrowserPool，超过 30s 触发前端告警，超过 60s 日志升级 ERROR
  private static readonly OPENED_LIST_WARN_MS = 30_000;  // 30s 告警阈值
  private static readonly OPENED_LIST_ERROR_MS = 60_000; // 60s ERROR 阈值
  /** openedList 持续返回空的开始时间戳（null = 当前无异常） */
  private openedListEmptySince: number | null = null;
  /** openedList 最近一次非空时间戳 */
  private openedListLastNonEmptyAt: number = 0;
  /** getBrowerList 最近一次返回的窗口数（用于交叉校验 openedList 空是否为异常） */
  private lastBrowerListCount: number = 0;
  /** 是否已输出过 60s ERROR 日志（避免重复刷屏，恢复后重置） */
  private openedListErrorLogged: boolean = false;

  private constructor() {
    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: 8000,
    });
  }

  static getInstance(): EasyBRClient {
    if (!EasyBRClient.instance) {
      EasyBRClient.instance = new EasyBRClient();
    }
    return EasyBRClient.instance;
  }

  // ── Phase G-2: 健康检测与熔断 ────────────────────────

  // 健康检测结果缓存（避免短时间内重复请求 EasyBR）
  // 缓存 TTL: 5 秒，高频提交任务时直接复用，减轻 EasyBR 压力
  private healthCache: { result: { ok: boolean; message: string }; timestamp: number } | null = null;
  private static readonly HEALTH_CACHE_TTL_MS = 5000;

  /**
   * Phase G-2: EasyBR 健康检测
   *
   * 验证：
   *   1. API 可访问
   *   2. 获取窗口成功
   *   3. 响应时间正常
   *
   * 启动任务前必须执行 checkHealth()，失败则禁止启动任务。
   *
   * ★ 保护 EasyBR 稳定性：5 秒内重复调用直接复用缓存，不重复打 API。
   *
   * @returns { ok: boolean; message: string }
   */
  async checkHealth(): Promise<{ ok: boolean; message: string }> {
    // 先检查熔断器状态
    if (this.isCircuitOpen()) {
      const remainMs = EasyBRClient.CIRCUIT_RESET_MS - (Date.now() - this.circuitBreaker.openedAt);
      const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
      return {
        ok: false,
        message: `EasyBR 熔断中，剩余 ${remainSec} 秒自动恢复`,
      };
    }

    // ★ 5 秒内有缓存结果直接复用（保护 EasyBR 不被高频任务打爆）
    if (this.healthCache && (Date.now() - this.healthCache.timestamp) < EasyBRClient.HEALTH_CACHE_TTL_MS) {
      const cached = this.healthCache.result;
      return { ok: cached.ok, message: `${cached.message} (缓存)` };
    }

    const startTime = Date.now();
    try {
      // 验证 API 可访问 + 获取窗口成功
      const list = await this.getBrowerList();
      const elapsed = Date.now() - startTime;

      let result: { ok: boolean; message: string };

      // 响应时间正常（< 5s）
      if (elapsed > 5000) {
        result = {
          ok: true,
          message: `EasyBR 响应缓慢 (${elapsed}ms)，窗口数: ${list.size}`,
        };
      } else {
        result = {
          ok: true,
          message: `EasyBR 健康 (${elapsed}ms)，窗口数: ${list.size}`,
        };
      }

      // 更新缓存
      this.healthCache = { result, timestamp: Date.now() };
      return result;
    } catch (err) {
      const failResult = {
        ok: false,
        message: `EasyBR 不可用: ${(err as Error).message || String(err)}`,
      };
      // 失败结果也缓存 5 秒（避免每任务都重试失败）
      this.healthCache = { result: failResult, timestamp: Date.now() };
      return failResult;
    }
  }

  /**
   * Phase G-2: 熔断器是否开启
   */
  isCircuitOpen(): boolean {
    if (!this.circuitBreaker.isOpen) return false;

    // 检查是否到了自动恢复时间
    const elapsed = Date.now() - this.circuitBreaker.openedAt;
    if (elapsed >= EasyBRClient.CIRCUIT_RESET_MS) {
      // 半开探测：自动关闭熔断，允许下一次请求
      console.log('[EasyBRClient] 熔断器半开探测，允许请求通过');
      this.circuitBreaker.isOpen = false;
      this.circuitBreaker.failureCount = 0;
      return false;
    }
    return true;
  }

  /**
   * Phase G-2: 记录成功（重置失败计数）
   */
  private recordSuccess(): void {
    if (this.circuitBreaker.failureCount > 0 || this.circuitBreaker.isOpen) {
      console.log('[EasyBRClient] 熔断器恢复，请求成功');
    }
    this.circuitBreaker.failureCount = 0;
    this.circuitBreaker.isOpen = false;
  }

  /**
   * Phase G-2: 记录失败（累加计数，达到阈值进入熔断）
   */
  private recordFailure(): void {
    this.circuitBreaker.failureCount++;
    if (this.circuitBreaker.failureCount >= EasyBRClient.CIRCUIT_FAILURE_THRESHOLD) {
      this.circuitBreaker.isOpen = true;
      this.circuitBreaker.openedAt = Date.now();
      console.error(
        `[EasyBRClient] EasyBR 连续失败 ${this.circuitBreaker.failureCount} 次，进入熔断状态，暂停连接 5 分钟`,
      );
    }
  }

  // ── 核心 API ────────────────────────────────────────

  /**
   * 获取全部浏览器配置列表
   * @returns browerid → browername 映射
   */
  async getBrowerList(): Promise<Map<string, string>> {
    this.stats.getBrowerListCalls++;
    const data = await this.request<BrowserConfig[]>({
      method: 'GET',
      url: '/auto/getBrowerList',
      params: { page: 1, limit: 100 },
    });
    const map = new Map<string, string>();
    for (const item of data) {
      if (item.browerid && item.browername) {
        if (map.has(item.browerid)) {
          console.warn(`[EasyBRClient] ⚠️ getBrowerList 发现重复 browerid: ${item.browerid} → 旧="${map.get(item.browerid)}" 新="${item.browername}"`);
        }
        map.set(item.browerid, item.browername);
      }
    }
    console.log(`[EasyBRClient] getBrowerList: ${map.size} 个配置 (原始 ${data.length} 条)`);
    // ★ 步骤5: 记录最近一次 getBrowerList 窗口数，供 openedList 异常监控交叉校验
    this.lastBrowerListCount = map.size;
    // ★ 诊断：打印完整未截断的 browerid + browername
    for (const item of data) {
      if (item.browername && item.browername.includes('天南大')) {
        console.log(`[EasyBRClient]   getBrowerList 完整数据: browerid="${item.browerid}" browername="${item.browername}"`);
      }
    }
    return map;
  }

  /**
   * 获取已打开窗口列表
   * 替代 CdpScanner 的 netstat 端口扫描
   *
   * ★ 步骤5: 新增 openedList 异常持续监控
   *   当 getBrowerList 返回非空（配置正常）但 openedList 返回空时，
   *   标记为 openedListAbnormal 并记录持续时长。
   */
  async openedList(): Promise<OpenedWindow[]> {
    this.stats.openedListCalls++;
    const data = await this.request<OpenedWindow[]>({
      method: 'GET',
      url: '/auto/openedList',
    });
    const openCount = data.filter(w => w.isopen).length;
    console.log(`[EasyBRClient] openedList: ${data.length} 个窗口 (${openCount} 已打开)`);

    // ★ 步骤5: openedList 异常持续监控
    // 交叉校验：getBrowerList 有配置但 openedList 返回空 → 异常
    if (data.length === 0 && this.lastBrowerListCount > 0) {
      if (this.openedListEmptySince === null) {
        this.openedListEmptySince = Date.now();
        console.warn(`[EasyBRClient] openedList 返回空但 getBrowerList 有 ${this.lastBrowerListCount} 个配置，开始监控异常持续时间`);
      }
      const durationMs = Date.now() - this.openedListEmptySince;
      // 超过 60s → ERROR 日志（只输出一次，避免刷屏）
      if (durationMs >= EasyBRClient.OPENED_LIST_ERROR_MS && !this.openedListErrorLogged) {
        console.error(`[EasyBRClient] openedList 持续空 ${(durationMs / 1000).toFixed(0)}s，超过 60s 阈值，EasyBR 状态接口严重异常`);
        this.openedListErrorLogged = true;
      }
    } else if (data.length > 0) {
      // 恢复正常
      if (this.openedListEmptySince !== null) {
        const recoveredDuration = Date.now() - this.openedListEmptySince;
        console.log(`[EasyBRClient] openedList 异常已恢复（持续 ${(recoveredDuration / 1000).toFixed(0)}s）`);
      }
      this.openedListEmptySince = null;
      this.openedListErrorLogged = false;
      this.openedListLastNonEmptyAt = Date.now();
    }

    // ★ 诊断：打印完整未截断的 browerid + browername
    for (const item of data) {
      if (item.browername && item.browername.includes('天南大')) {
        console.log(`[EasyBRClient]   openedList 完整数据: browerid="${item.browerid}" browername="${item.browername}" isopen=${item.isopen}`);
      }
    }
    return data;
  }

  /**
   * 步骤5: 获取 openedList 异常状态
   * @returns { abnormal: boolean; durationMs: number }
   *   - abnormal: openedList 是否处于异常状态（getBrowerList 非空但 openedList 空）
   *   - durationMs: 异常持续时长（毫秒），非异常时为 0
   */
  getOpenedlistAnomalyStatus(): { abnormal: boolean; durationMs: number } {
    if (this.openedListEmptySince === null) {
      return { abnormal: false, durationMs: 0 };
    }
    return { abnormal: true, durationMs: Date.now() - this.openedListEmptySince };
  }

  /**
   * 获取 EasyBR 完整健康状态（供前端展示和重连按钮使用）
   * @returns 包含熔断器状态、openedList 异常、是否需要重连等信息
   */
  getHealthStatus(): {
    circuitBreakerOpen: boolean;
    circuitBreakerRemainingMs: number;
    openedListAbnormal: boolean;
    openedListAbnormalDurationMs: number;
    /** 是否需要提示用户重连（熔断中 或 openedList 异常超过 30s） */
    reconnectNeeded: boolean;
    /** 状态描述文字 */
    message: string;
  } {
    const now = Date.now();
    const circuitBreakerOpen = this.isCircuitOpen();
    const circuitBreakerRemainingMs = circuitBreakerOpen
      ? Math.max(0, EasyBRClient.CIRCUIT_RESET_MS - (now - this.circuitBreaker.openedAt))
      : 0;
    const ebAnomaly = this.getOpenedlistAnomalyStatus();
    const openedListAbnormal = ebAnomaly.abnormal && ebAnomaly.durationMs >= EasyBRClient.OPENED_LIST_WARN_MS;

    let message = 'EasyBR 连接正常';
    let reconnectNeeded = false;

    if (circuitBreakerOpen) {
      const remainSec = Math.ceil(circuitBreakerRemainingMs / 1000);
      message = `EasyBR 熔断中，剩余 ${remainSec} 秒自动恢复`;
      reconnectNeeded = true;
    } else if (openedListAbnormal) {
      message = 'EasyBR 状态接口异常，窗口状态以本地连接为准';
      reconnectNeeded = true;
    }

    return {
      circuitBreakerOpen,
      circuitBreakerRemainingMs,
      openedListAbnormal,
      openedListAbnormalDurationMs: ebAnomaly.durationMs,
      reconnectNeeded,
      message,
    };
  }

  /**
   * 打开浏览器窗口，返回 CDP 连接端点
   * - ChromeDriver 模式: ws 为空，返回 http endpoint
   * - 原生 CDP 模式: 返回 ws URL
   * 如果窗口已打开，直接返回现有端点（幂等操作）
   */
  async openBrower(browerid: string): Promise<{ ws: string; http: string }> {
    this.stats.openBrowerCalls++;
    const data = await this.request<OpenBrowerResult>(
      {
        method: 'POST',
        url: '/auto/openBrower',
        data: { browerid },
      },
      { timeout: 25000 }, // 启动浏览器可能需要数秒
    );
    // ws 可能为空（ChromeDriver 模式），此时用 http endpoint 作为 CDP 连接目标
    console.log(`[EasyBRClient] openBrower: ${browerid} → ws=${data.ws || '(empty)'} http=${data.http}`);
    return { ws: data.ws, http: data.http };
  }

  /**
   * 关闭浏览器窗口（幂等操作）
   */
  async closeBrower(browerid: string): Promise<void> {
    this.stats.closeBrowerCalls++;
    await this.request(
      {
        method: 'POST',
        url: '/auto/closeBrower',
        data: { browerid },
      },
      { maxRetries: 1 },
    );
    console.log(`[EasyBRClient] closeBrower: ${browerid}`);
  }

  /**
   * 检查 EasyBR API 服务是否可用
   */
  async checkStatus(): Promise<boolean> {
    try {
      await this.axios.get('/auto/getBrowerList', { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 手动重置 EasyBR 连接状态
   * 用于用户手动重启 EasyBR 后，立即清除熔断器、缓存和异常监控状态，强制重连
   */
  resetConnection(): void {
    console.log('[EasyBRClient] 手动重置 EasyBR 连接状态');
    this.circuitBreaker.failureCount = 0;
    this.circuitBreaker.isOpen = false;
    this.circuitBreaker.openedAt = 0;
    this.healthCache = null;
    this.openedListEmptySince = null;
    this.openedListErrorLogged = false;
    this.lastBrowerListCount = 0;
    this.stats.errors = 0;
    this.stats.retries = 0;
  }

  // ── 统计 ────────────────────────────────────────────

  /** 获取调用统计 */
  getStats() {
    return { ...this.stats };
  }

  // ── 内部：统一请求 ───────────────────────────────────

  private async request<T>(
    config: { method: string; url: string; params?: unknown; data?: unknown },
    opts?: { timeout?: number; maxRetries?: number },
  ): Promise<T> {
    // Phase G-2: 熔断器检查
    if (this.isCircuitOpen()) {
      throw new EasyBRCircuitOpenError(
        'EasyBR 熔断中，暂停连接 5 分钟',
      );
    }

    const maxAttempts = (opts?.maxRetries ?? this.maxRetries) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const resp = await this.axios({
          method: config.method,
          url: config.url,
          params: config.params,
          data: config.data,
          timeout: opts?.timeout ?? 8000,
        });

        const body = resp.data as ApiResponse<T>;

        if (body.code === 0) {
          // Phase G-2: 请求成功，重置熔断器
          this.recordSuccess();
          return body.data;
        }

        // 业务错误（不重试）
        // Phase G-2: 业务错误不视为 EasyBR 不可用，不累加熔断失败计数
        throw new EasyBRClientError(
          body.msg ?? `EasyBR API 错误: code=${body.code}`,
          'API_ERROR',
        );
      } catch (error) {
        lastError = error as Error;

        // EasyBRClientError 不重试
        if (error instanceof EasyBRClientError) {
          throw error;
        }

        // 网络错误 → 重试
        if (attempt < maxAttempts - 1) {
          this.stats.retries++;
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          continue;
        }

        // 最后一次尝试失败
        // Phase G-2: 记录熔断失败
        this.recordFailure();

        if (axios.isAxiosError(error)) {
          if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            throw new EasyBRClientError(
              `EasyBR API 超时: ${config.method} ${config.url}`,
              'NETWORK_TIMEOUT',
            );
          }
          throw new EasyBRClientError(
            `EasyBR API 网络错误: ${error.message}`,
            'NETWORK_ERROR',
          );
        }
        throw error;
      }
    }

    this.stats.errors++;
    throw (
      lastError ??
      new EasyBRClientError(`未知错误: ${config.method} ${config.url}`, 'UNKNOWN')
    );
  }
}
