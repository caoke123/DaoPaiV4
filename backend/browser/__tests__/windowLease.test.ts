import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BrowserPool, type WindowLeaseHandle } from '../BrowserPool';
import { WindowLockManager, WindowBusyError } from '../WindowLockManager';

function resetBrowserPool(): BrowserPool {
  (BrowserPool as any).instance = null;
  (WindowLockManager as any).instance = null;
  const pool = BrowserPool.getInstance();
  (pool as any).windowBusy.clear();
  (pool as any).activeWindowLeases.clear();
  (pool as any).runtimeStates.clear();
  (pool as any).connections.clear();
  (pool as any).p0Verified.clear();
  (pool as any).loginRequiredWindows.clear();
  return pool;
}

describe('BrowserPool — WindowLease Adapter', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    pool = resetBrowserPool();
  });

  afterEach(() => {
    (pool as any).activeWindowLeases.clear();
    (pool as any).windowBusy.clear();
    (WindowLockManager as any).instance = null;
    vi.restoreAllMocks();
  });

  it('L1: acquireWindowLease 成功 → lock/busy/lease 均存在', async () => {
    const handle = await pool.acquireWindowLease({
      windowId: 'win-L1',
      taskId: 'task-L1',
      staffName: '张三',
      taskType: 'arrival',
    });

    expect(handle).toBeDefined();
    expect(handle.windowId).toBe('win-L1');
    expect(handle.taskId).toBe('task-L1');

    const lock = WindowLockManager.getInstance();
    expect(lock.isBusy('win-L1')).toBe(true);
    expect(pool.isWindowBusy('win-L1')).toBe(true);
    expect(pool.isWindowLeased('win-L1')).toBe(true);

    const leaseInfo = pool.getActiveWindowLease('win-L1');
    expect(leaseInfo).not.toBeNull();
    expect(leaseInfo!.windowId).toBe('win-L1');
    expect(leaseInfo!.taskId).toBe('task-L1');
    expect(leaseInfo!.staffName).toBe('张三');
    expect(leaseInfo!.taskType).toBe('arrival');
    expect(typeof leaseInfo!.acquiredAt).toBe('number');
    expect(typeof leaseInfo!.lastRenewedAt).toBe('number');
  });

  it('L2: acquireWindowLease 失败（重复获取）→ 抛 WindowBusyError，无残留', async () => {
    await pool.acquireWindowLease({ windowId: 'win-L2', taskId: 'task-A' });

    await expect(
      pool.acquireWindowLease({ windowId: 'win-L2', taskId: 'task-B' }),
    ).rejects.toBeInstanceOf(WindowBusyError);

    const lock = WindowLockManager.getInstance();
    expect(lock.isBusy('win-L2')).toBe(true);
    const lockInfo = lock.getLock('win-L2');
    expect(lockInfo!.taskId).toBe('task-A');

    const leaseInfo = pool.getActiveWindowLease('win-L2');
    expect(leaseInfo!.taskId).toBe('task-A');

    expect(pool.isWindowLeased('win-L2')).toBe(true);
  });

  it('L3: releaseWindowLease 成功 → lock/busy/lease 均清理', async () => {
    const handle = await pool.acquireWindowLease({
      windowId: 'win-L3',
      taskId: 'task-L3',
      taskType: 'dispatch',
    });

    handle.release('completed');

    const lock = WindowLockManager.getInstance();
    expect(lock.isBusy('win-L3')).toBe(false);
    expect(pool.isWindowBusy('win-L3')).toBe(false);
    expect(pool.isWindowLeased('win-L3')).toBe(false);
    expect(pool.getActiveWindowLease('win-L3')).toBeNull();
  });

  it('L4: releaseWindowLease 幂等 — 重复release不报错', async () => {
    const handle = await pool.acquireWindowLease({
      windowId: 'win-L4',
      taskId: 'task-L4',
    });

    handle.release('completed');
    expect(() => handle.release('completed-again')).not.toThrow();
    expect(() => pool.releaseWindowLease('win-L4', 'task-L4')).not.toThrow();

    expect(pool.isWindowLeased('win-L4')).toBe(false);
    expect(WindowLockManager.getInstance().isBusy('win-L4')).toBe(false);
  });

  it('L5: renewWindowLease 更新 lastRenewedAt 和 windowBusy 时间戳', async () => {
    const handle = await pool.acquireWindowLease({
      windowId: 'win-L5',
      taskId: 'task-L5',
    });

    const before = pool.getActiveWindowLease('win-L5')!.lastRenewedAt;
    const busyBefore = (pool as any).windowBusy.get('win-L5') as number;

    await new Promise(r => setTimeout(r, 10));

    handle.renew();

    const after = pool.getActiveWindowLease('win-L5')!.lastRenewedAt;
    const busyAfter = (pool as any).windowBusy.get('win-L5') as number;

    expect(after).toBeGreaterThanOrEqual(before);
    expect(busyAfter).toBeGreaterThanOrEqual(busyBefore);
    expect(WindowLockManager.getInstance().isBusy('win-L5')).toBe(true);
  });

  it('L6: releaseWindowLease taskId不匹配时不释放', async () => {
    await pool.acquireWindowLease({ windowId: 'win-L6', taskId: 'task-owner' });

    pool.releaseWindowLease('win-L6', 'task-wrong');

    expect(WindowLockManager.getInstance().isBusy('win-L6')).toBe(true);
    expect(pool.isWindowLeased('win-L6')).toBe(true);
    expect(pool.getActiveWindowLease('win-L6')!.taskId).toBe('task-owner');

    pool.releaseWindowLease('win-L6', 'task-owner');
    expect(WindowLockManager.getInstance().isBusy('win-L6')).toBe(false);
  });

  it('L7: forceReleaseWindowLease 不校验taskId，强制清理', async () => {
    await pool.acquireWindowLease({ windowId: 'win-L7', taskId: 'task-L7' });

    pool.forceReleaseWindowLease('win-L7', 'dead_connection');

    expect(WindowLockManager.getInstance().isBusy('win-L7')).toBe(false);
    expect(pool.isWindowLeased('win-L7')).toBe(false);
    expect(pool.getActiveWindowLease('win-L7')).toBeNull();
  });

  it('L8: forceReleaseWindowLease 对无lease窗口幂等', () => {
    expect(() => pool.forceReleaseWindowLease('win-noexist', 'test')).not.toThrow();
    expect(pool.isWindowLeased('win-noexist')).toBe(false);
  });

  it('L9: getActiveWindowLease 返回只读副本（外部修改不影响内部状态）', async () => {
    await pool.acquireWindowLease({ windowId: 'win-L9', taskId: 'task-L9', staffName: '李四' });

    const info = pool.getActiveWindowLease('win-L9')!;
    expect(Object.isFrozen(info)).toBe(true);

    const internal = (pool as any).activeWindowLeases.get('win-L9');
    expect(internal.staffName).toBe('李四');
  });

  it('L10: isWindowLeased 等价于 isWindowBusy', async () => {
    expect(pool.isWindowLeased('win-L10')).toBe(false);
    expect(pool.isWindowBusy('win-L10')).toBe(false);

    await pool.acquireWindowLease({ windowId: 'win-L10', taskId: 'task-L10' });
    expect(pool.isWindowLeased('win-L10')).toBe(true);
    expect(pool.isWindowBusy('win-L10')).toBe(true);

    pool.releaseWindowLease('win-L10', 'task-L10');
    expect(pool.isWindowLeased('win-L10')).toBe(false);
    expect(pool.isWindowBusy('win-L10')).toBe(false);
  });

  it('L11: handle.release() 正确释放', async () => {
    const handle = await pool.acquireWindowLease({ windowId: 'win-L11', taskId: 'task-L11' });
    handle.release('test');
    expect(WindowLockManager.getInstance().isBusy('win-L11')).toBe(false);
    expect(pool.getActiveWindowLease('win-L11')).toBeNull();
  });

  it('L12: handle.renew() 正确续租', async () => {
    const handle = await pool.acquireWindowLease({ windowId: 'win-L12', taskId: 'task-L12' });
    const before = pool.getActiveWindowLease('win-L12')!.lastRenewedAt;
    await new Promise(r => setTimeout(r, 10));
    handle.renew();
    const after = pool.getActiveWindowLease('win-L12')!.lastRenewedAt;
    expect(after).toBeGreaterThan(before);
  });

  it('L13: renewWindowLease 对不存在的窗口安全不报错', () => {
    expect(() => pool.renewWindowLease('win-noexist', 'task-x')).not.toThrow();
  });

  it('L14: releaseWindowLease 对不存在lease的窗口安全（尝试释放lock但不碰busy）', () => {
    expect(() => pool.releaseWindowLease('win-noexist', 'task-x')).not.toThrow();
  });

  it('L15: cleanupDeadConnection 清理 lock / busy / activeWindowLeases 三者一致', async () => {
    const windowId = 'win-L15-dead';

    await pool.acquireWindowLease({
      windowId,
      taskId: 'task-L15',
      staffName: '测试员工',
      taskType: 'arrival',
    });

    expect(WindowLockManager.getInstance().isBusy(windowId)).toBe(true);
    expect(pool.isWindowBusy(windowId)).toBe(true);
    expect(pool.isWindowLeased(windowId)).toBe(true);
    expect(pool.getActiveWindowLease(windowId)).not.toBeNull();

    const fakeBrowser = { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const fakeConn = {
      windowInfo: {
        id: windowId,
        name: '测试窗口',
        role: 'staff' as const,
        site: 'test',
        staff_name: '测试员工',
        is_connected: 1,
        updated_at: new Date().toISOString(),
      },
      browser: fakeBrowser,
      page: { evaluate: vi.fn().mockResolvedValue(1) },
    };

    (pool as any).connections.set(windowId, fakeConn);
    (pool as any).p0Verified.add(windowId);

    (pool as any).cleanupDeadConnection(windowId, fakeConn);

    expect(WindowLockManager.getInstance().isBusy(windowId)).toBe(false);
    expect(pool.isWindowBusy(windowId)).toBe(false);
    expect(pool.isWindowLeased(windowId)).toBe(false);
    expect(pool.getActiveWindowLease(windowId)).toBeNull();
    expect((pool as any).connections.has(windowId)).toBe(false);
    expect((pool as any).p0Verified.has(windowId)).toBe(false);
  });
});
