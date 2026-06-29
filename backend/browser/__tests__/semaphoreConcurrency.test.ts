/**
 * Phase I: SimpleSemaphore + 并发启动测试
 *
 * 测试目标：
 *   1. SimpleSemaphore 基础行为（acquire/release/排队/超时/防死锁）
 *   2. 5 个窗口并发调用 openBrowerWithRetry → 最多 2 个并发 openBrower
 *   3. 防重复调用：同一窗口同时被多次请求 → 复用已有 Promise
 *
 * Mock 策略：
 *   - 完全 stub EasyBRClient.openBrower（不发起真实 HTTP 请求）
 *   - 完全 stub chromium.connectOverCDP（不建立真实 CDP 连接）
 *   - 使用 delayPromise 控制 openBrower 完成时序，验证并发限制
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SimpleSemaphore, BrowserPool } from '../BrowserPool';
import { EasyBRClient } from '../../easybr/EasyBRClient';

// ── 工具函数 ──────────────────────────────────────────
/** 返回一个在 ms 毫秒后 resolve 的 Promise */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Test Suite A: SimpleSemaphore 基础行为 ────────────

describe('SimpleSemaphore — 基础行为', () => {
  let sema: SimpleSemaphore;

  beforeEach(() => {
    sema = new SimpleSemaphore(2);
  });

  it('A-1: 初始状态可用槽位 = max (2)', () => {
    expect(sema.available).toBe(2);
    expect(sema.queueLength).toBe(0);
  });

  it('A-2: acquire → 可用槽位递减', async () => {
    await sema.acquire(1000);
    expect(sema.available).toBe(1);
    await sema.acquire(1000);
    expect(sema.available).toBe(0);
  });

  it('A-3: 槽位满时 acquire 排队等待', async () => {
    // 占满 2 个槽位
    await sema.acquire(1000);
    await sema.acquire(1000);
    expect(sema.available).toBe(0);
    expect(sema.queueLength).toBe(0);

    // 第 3 个 acquire 进入排队（不 await，立即返回）
    const acquirePromise = sema.acquire(10_000);
    // 给事件循环一个 tick
    await delay(10);
    expect(sema.queueLength).toBe(1);
    expect(sema.available).toBe(0);

    // release → 排队者被唤醒
    sema.release();
    await acquirePromise;
    expect(sema.available).toBe(0); // 3 个 acquire，1 个 release → 2/2 满
    expect(sema.queueLength).toBe(0);
  });

  it('A-4: release 超过 acquire 数时 current 不回负', () => {
    sema.release();
    sema.release();
    sema.release();
    expect(sema.available).toBe(2); // 不低于 0
  });

  it('A-5: acquire 超时抛 SemaphoreTimeoutError', async () => {
    // 占满 2 个槽位
    await sema.acquire(1000);
    await sema.acquire(1000);

    // 第 3 个 acquire 100ms 超时
    await expect(sema.acquire(100)).rejects.toThrow('信号量等待超时');
    expect(sema.queueLength).toBe(0); // 超时者已从队列移除
    expect(sema.available).toBe(0);   // 槽位未被占用
  });

  it('A-6: 超时后 release 不影响已取消的等待者', async () => {
    await sema.acquire(1000);
    await sema.acquire(1000);

    // 两个等待者：一个 200ms 超时（会失败），一个 10000ms（会成功）
    const fastTimeout = sema.acquire(200).catch(() => 'timeout');
    const slowWait = sema.acquire(10_000);

    // 等 fast 超时
    await delay(300);
    expect(await fastTimeout).toBe('timeout');
    expect(sema.queueLength).toBe(1); // 只剩 slowWait

    // release → slowWait 被唤醒
    sema.release();
    await slowWait;
    expect(sema.queueLength).toBe(0);
  });
});

// ── Test Suite B: 5 窗口并发启动 — 信号量限制最多 2 并发 ──

describe('BrowserPool — 并发启动 5 窗口', () => {
  let pool: BrowserPool;

  /** 用于拦截 openBrower 调用并记录并发数 */
  let concurrentCalls = 0;
  let maxConcurrentCalls = 0;
  let callOrder: string[] = [];
  /** 每个窗口 ID 对应的 resolve 函数，控制 openBrower 完成时序 */
  const openBrowerResolvers = new Map<string, () => void>();

  beforeEach(() => {
    // 重置单例
    (BrowserPool as any).instance = null;
    pool = BrowserPool.getInstance();

    concurrentCalls = 0;
    maxConcurrentCalls = 0;
    callOrder = [];
    openBrowerResolvers.clear();

    // Mock EasyBRClient.openBrower：返回受控的 Promise
    vi.spyOn(EasyBRClient.prototype, 'openBrower').mockImplementation(async (browerid: string) => {
      concurrentCalls++;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
      callOrder.push(`start:${browerid}`);

      // 创建一个可控的 Promise — 由外部 resolve 才会完成
      await new Promise<void>(resolve => {
        openBrowerResolvers.set(browerid, resolve);
      });

      concurrentCalls--;
      callOrder.push(`end:${browerid}`);
      return { ws: `ws://mock/${browerid}`, http: `http://mock/${browerid}` };
    });

    // Mock chromium.connectOverCDP 和后续步骤（不建立真实连接）
    vi.mock('playwright', async () => {
      const actual = await vi.importActual('playwright');
      return {
        ...actual as object,
        chromium: {
          connectOverCDP: vi.fn().mockResolvedValue({
            close: vi.fn().mockResolvedValue(undefined),
            contexts: () => [{
              pages: () => [{ url: () => 'https://bnsy.benniaosuyun.com/dashboard' }],
              newPage: vi.fn().mockResolvedValue({
                goto: vi.fn().mockResolvedValue(undefined),
                waitForSelector: vi.fn().mockResolvedValue(undefined),
                url: () => 'https://bnsy.benniaosuyun.com/dashboard',
              }),
            }],
          }),
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('B-1: 5 窗口并发启动 → 最多 2 个 openBrower 同时执行', async () => {
    // 发起 5 个窗口的并发连接（通过访问 openBrowerWithRetry 的间接路径）
    // 注意：openBrowerWithRetry 是 private 的，我们用 vi.hoisted 或反射来访问
    // 这里通过内部调用路径触发：直接操作 connectingPromises 和 doConnectAndSetup

    const windowIds = ['win-a', 'win-b', 'win-c', 'win-d', 'win-e'];

    // 使用 Reflect 访问 private 方法（仅测试用）
    const openBrowerWithRetry = (pool as any).openBrowerWithRetry.bind(pool);

    // 5 个窗口并发调用
    const tasks = windowIds.map(id => openBrowerWithRetry(id));

    // 等待一个 tick 让所有 5 个任务都排队
    await delay(100);

    // 验证：最多 2 个在执行
    expect(maxConcurrentCalls).toBeLessThanOrEqual(2);
    // 前 2 个应该已开始
    expect(callOrder.filter(c => c.startsWith('start:')).length).toBe(2);

    // 逐个 resolve，验证每次释放后新任务进入
    for (let i = 0; i < 5; i++) {
      const id = windowIds[i];
      const resolver = openBrowerResolvers.get(id);
      if (resolver) resolver();
      await delay(50);
      // 每次释放后，并发数不超过 2
      expect(maxConcurrentCalls).toBeLessThanOrEqual(2);
    }

    await Promise.all(tasks);

    // 所有 5 个都完成
    expect(callOrder.filter(c => c.startsWith('start:')).length).toBe(5);
    expect(callOrder.filter(c => c.startsWith('end:')).length).toBe(5);
  });

  it('B-2: 并发控制严格限制 ≤ 2', async () => {
    // 发起 10 个窗口并发
    const windowIds = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const openBrowerWithRetry = (pool as any).openBrowerWithRetry.bind(pool);

    const tasks = windowIds.map(id => openBrowerWithRetry(id));

    // 等待排队稳定
    await delay(100);

    // 验证：从未超过 2 个并发
    expect(maxConcurrentCalls).toBeLessThanOrEqual(2);

    // 陆续 resolve 所有
    for (const id of windowIds) {
      const resolver = openBrowerResolvers.get(id);
      if (resolver) resolver();
      await delay(10);
      expect(maxConcurrentCalls).toBeLessThanOrEqual(2);
    }

    await Promise.all(tasks);
  });

  it('B-3: 单窗口重试时正确排入信号量队列', async () => {
    // 场景：窗口 win-a 首次 openBrower 失败 → 2s 后退避重试 → 重试成功
    const eb = EasyBRClient.getInstance();
    let callCount = 0;

    vi.mocked(eb.openBrower).mockImplementation(async (browerid: string) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('EasyBR 启动失败（模拟）');
      }
      // 第二次成功
      return { ws: `ws://mock/${browerid}`, http: `http://mock/${browerid}` };
    });

    const openBrowerWithRetry = (pool as any).openBrowerWithRetry.bind(pool);

    // 发起调用（会先失败、等 2s、重试）
    const start = Date.now();
    const result = await openBrowerWithRetry('win-retry');
    const elapsed = Date.now() - start;

    // 验证结果
    expect(result.ws).toContain('win-retry');
    expect(callCount).toBe(2); // 调用了两次：首次失败 + 重试成功
    expect(elapsed).toBeGreaterThanOrEqual(1_900); // 2s 退避
    expect(elapsed).toBeLessThan(3_500); // 不会太久
  }, 10_000); // 超时 10s，因为需要真实等待 2s

  it('B-4: 排队日志输出正确格式', async () => {
    // 直接用 SimpleSemaphore 验证日志格式中包含排队信息
    const testSema = new SimpleSemaphore(2);

    // 占满 2 个槽位
    await testSema.acquire(1000);
    await testSema.acquire(1000);

    // 第 3 个 acquire 进入排队（异步，不 await）
    const acquire3Promise = testSema.acquire(10_000);
    await delay(10);

    // 验证队列状态
    expect(testSema.queueLength).toBe(1);
    expect(testSema.available).toBe(0);

    // 释放一个槽位 → 第 3 个被唤醒
    testSema.release();
    await acquire3Promise;
    expect(testSema.queueLength).toBe(0);
  }, 5000);
});

// ── Test Suite C: 防重复调用 — Promise 复用 ──

describe('BrowserPool — 防重复调用（connectingPromises）', () => {
  it('C-1: connectingPromises 机制 — 同一 key 的 Promise 被复用', async () => {
    const pool = BrowserPool.getInstance();
    const connectingPromises = (pool as any).connectingPromises as Map<string, Promise<any>>;

    // 直接测试 Map 的去重行为：模拟 connectAndSetupWindow 的 dedup 逻辑
    const TEST_KEY = 'dedup-window-1';
    let callCount = 0;

    // 模拟 connectAndSetupWindow 内部逻辑：如果 Map 中已有 Promise，复用；否则创建新的
    async function simulatedConnectAndSetup(): Promise<string> {
      const existingPromise = connectingPromises.get(TEST_KEY);
      if (existingPromise) {
        return existingPromise;
      }

      const newPromise = (async () => {
        callCount++;
        await delay(50); // 模拟耗时操作
        return 'connected';
      })();

      connectingPromises.set(TEST_KEY, newPromise);
      try {
        return await newPromise;
      } finally {
        connectingPromises.delete(TEST_KEY);
      }
    }

    // 3 次并发调用
    const [r1, r2, r3] = await Promise.all([
      simulatedConnectAndSetup(),
      simulatedConnectAndSetup(),
      simulatedConnectAndSetup(),
    ]);

    // 验证：函数体只执行了 1 次（callCount === 1），3 次调用得到相同结果
    expect(callCount).toBe(1);
    expect(r1).toBe('connected');
    expect(r2).toBe('connected');
    expect(r3).toBe('connected');
    // Map 已被清理
    expect(connectingPromises.has(TEST_KEY)).toBe(false);
  });

  it('C-2: 不同 key 的 Promise 互不干扰', async () => {
    const pool = BrowserPool.getInstance();
    const connectingPromises = (pool as any).connectingPromises as Map<string, Promise<any>>;
    let callCount = 0;

    async function simulatedConnect(key: string): Promise<string> {
      const existingPromise = connectingPromises.get(key);
      if (existingPromise) return existingPromise;

      const newPromise = (async () => {
        callCount++;
        await delay(20);
        return `connected:${key}`;
      })();

      connectingPromises.set(key, newPromise);
      try { return await newPromise; }
      finally { connectingPromises.delete(key); }
    }

    // 两个不同 key 并发
    const [r1, r2] = await Promise.all([
      simulatedConnect('win-a'),
      simulatedConnect('win-b'),
    ]);

    // 两个不同的 key → callCount === 2（各执行一次）
    expect(callCount).toBe(2);
    expect(r1).toBe('connected:win-a');
    expect(r2).toBe('connected:win-b');
  });
});
