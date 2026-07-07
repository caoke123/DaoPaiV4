/**
 * engineTimeout.test.ts — AssignmentEngine 超时与取消机制的单元测试
 *
 * Phase 9.2 更新：窗口占用已迁移到 Lease Adapter，
 * 测试从验证 lockManager.acquire/release 改为验证 lease.release()/renew()
 *
 * 测试目标（Phase G-3 + 9.2）：
 *   A. Handler 硬超时 → lease强制释放 → status='failed'
 *   B. 外部 cancelTask() → lease强制释放 → status='cancelled'（不被覆盖为 'failed'）
 *   C. 正常完成后 cancelControllers Map 清理（内存泄漏防护）
 *
 * Mock 策略：
 *   - Database → vi.mock，返回可控的 getTask / updateTask
 *   - BrowserPool → vi.mock，mock acquireWindowLease 返回 lease handle
 *   - EasyBRClient → vi.mock，返回健康
 *   - RuntimeMetrics → vi.mock，空操作
 *   - taskLogManager → vi.mock，空操作
 *   - Handler → 测试内联创建：正常 / 挂起 / 抛错
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AssignmentEngine } from '../AssignmentEngine';
import type { TaskHandler } from '../handlers/TaskHandler';
import type { Assignment } from '../types';

// ── Mock 模块 ─────────────────────────────────────────

const mockDb = {
  updateTask: vi.fn(),
  getTask: vi.fn(),
  listTasksByStatus: vi.fn().mockReturnValue([]),
  listWindows: vi.fn().mockReturnValue([]),
  appendTaskResults: vi.fn(),
  getTaskResults: vi.fn().mockReturnValue([]),
};

function setupMockDbState(initialStatus: string = 'running') {
  let currentTaskState: Record<string, any> = {
    id: 'test-task',
    type: 'arrival',
    site: 'tiannanda',
    status: initialStatus,
    total_count: 3,
    done_count: 0,
    fail_count: 0,
    result_data: null,
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  mockDb.getTask.mockImplementation(() => currentTaskState);
  mockDb.updateTask.mockImplementation((_taskId: string, updates: Record<string, any>) => {
    currentTaskState = { ...currentTaskState, ...updates };
  });
  return currentTaskState;
}

vi.mock('../../../db/Database', () => ({
  Database: {
    getInstance: () => mockDb,
  },
}));

vi.mock('../../../browser/BrowserPool', () => ({
  BrowserPool: {
    getInstance: () => ({
      getStaffConnection: vi.fn().mockResolvedValue({
        windowId: 'test-window-001',
        page: {},
      }),
      ensureWindowReady: vi.fn().mockResolvedValue(undefined),
      acquireWindowLease: vi.fn().mockImplementation(async (opts: any) => ({
        windowId: opts.windowId,
        taskId: opts.taskId,
        release: vi.fn(),
        renew: vi.fn(),
      })),
      markWindowBusy: vi.fn(),
      markWindowIdle: vi.fn(),
      refreshBusyLease: vi.fn(),
    }),
  },
}));

vi.mock('../../../easybr/EasyBRClient', () => ({
  EasyBRClient: {
    getInstance: () => ({
      checkHealth: () => Promise.resolve({ ok: true, message: 'mock-health-ok' }),
    }),
  },
}));

vi.mock('../../../runtime/RuntimeMetrics', () => ({
  RuntimeMetrics: {
    getInstance: () => ({
      taskSucceeded: vi.fn(),
      taskFailed: vi.fn(),
      snapshot: () => ({}),
    }),
  },
}));

vi.mock('../../../db/PgDatabase', () => ({
  PgDatabase: {
    getInstance: () => ({
      insertTask: vi.fn().mockResolvedValue(undefined),
      insertTaskLogs: vi.fn().mockResolvedValue(undefined),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      insertWaybillResults: vi.fn().mockResolvedValue(undefined),
      upsertWaybillPool: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock('../../../utils/TaskLogManager', () => ({
  taskLogManager: {
    addLog: vi.fn(),
    getLogs: vi.fn().mockReturnValue([]),
    getRecentLogs: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../../utils/TaskEventBus', () => ({
  taskEventBus: {
    emit: vi.fn(),
  },
}));

// ── 辅助工具 ──────────────────────────────────────────

function createMockLease(windowId: string, taskId: string) {
  return {
    windowId,
    taskId,
    release: vi.fn(),
    renew: vi.fn(),
  };
}

function createHangingHandler(): TaskHandler {
  return {
    executeWorker: () => new Promise(() => {}),
  };
}

function createOkHandler(): TaskHandler {
  return {
    executeWorker: vi.fn().mockResolvedValue({ success: true, processed: 1, failed: 0 }),
  };
}

function createErrorHandler(): TaskHandler {
  return {
    executeWorker: vi.fn().mockRejectedValue(new Error('模拟业务异常')),
  };
}

function makeAssignment(staffName = '测试员工', count = 3): Assignment {
  const waybillNos: string[] = [];
  for (let i = 0; i < count; i++) {
    waybillNos.push(`58000000000${String(i).padStart(2, '0')}`);
  }
  return { staffName, waybillNos };
}

// ── 测试前/后重置 ─────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  (AssignmentEngine as any).instance = null;
  mockDb.updateTask.mockReset();
  mockDb.getTask.mockReset();
  mockDb.listTasksByStatus.mockReturnValue([]);
  setupMockDbState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 测试用例 ──────────────────────────────────────────

describe('AssignmentEngine — 超时控制 (Phase 9.2: Lease)', () => {
  it('A-1: Handler 硬超时 → lease被强制释放', async () => {
    const engine = AssignmentEngine.getInstance();
    const lease = createMockLease('test-window-001', 'test-timeout-001');

    const mockPool = {
      getStaffConnection: vi.fn().mockResolvedValue({
        windowId: 'test-window-001',
        page: {},
      }),
      ensureWindowReady: vi.fn().mockResolvedValue(undefined),
      acquireWindowLease: vi.fn().mockResolvedValue(lease),
      markWindowBusy: vi.fn(),
      markWindowIdle: vi.fn(),
      refreshBusyLease: vi.fn(),
    };
    const { BrowserPool } = await import('../../../browser/BrowserPool');
    (BrowserPool as any).getInstance = () => mockPool;

    await engine.execute({
      taskId: 'test-timeout-001',
      site: 'tiannanda',
      taskType: 'arrival',
      assignments: [makeAssignment('员工A', 3)],
      handler: createHangingHandler(),
      handlerTimeoutMs: 500,
    });

    // 断言：acquireWindowLease 被调用
    expect(mockPool.acquireWindowLease).toHaveBeenCalledWith(expect.objectContaining({
      windowId: 'test-window-001',
      taskId: 'test-timeout-001',
    }));
    // 断言：lease.release 被调用（超时后 finally 块释放）
    expect(lease.release).toHaveBeenCalled();
    // 断言：任务状态更新为 'failed'（超时导致）
    const failedCall = mockDb.updateTask.mock.calls.find(
      (call: any[]) => call[1]?.status === 'failed',
    );
    expect(failedCall).toBeTruthy();
    expect(failedCall[0]).toBe('test-timeout-001');
  });

  it('A-2: Handler 正常完成 → 超时不触发', async () => {
    const engine = AssignmentEngine.getInstance();
    const lease = createMockLease('test-window-001', 'test-normal-001');

    const mockPool = {
      getStaffConnection: vi.fn().mockResolvedValue({
        windowId: 'test-window-001',
        page: {},
      }),
      ensureWindowReady: vi.fn().mockResolvedValue(undefined),
      acquireWindowLease: vi.fn().mockResolvedValue(lease),
      markWindowBusy: vi.fn(),
      markWindowIdle: vi.fn(),
      refreshBusyLease: vi.fn(),
    };
    const { BrowserPool } = await import('../../../browser/BrowserPool');
    (BrowserPool as any).getInstance = () => mockPool;

    await engine.execute({
      taskId: 'test-normal-001',
      site: 'tiannanda',
      taskType: 'arrival',
      assignments: [makeAssignment('员工A', 3)],
      handler: createOkHandler(),
      handlerTimeoutMs: 30_000,
    });

    // 断言：lease.release 被调用
    expect(lease.release).toHaveBeenCalled();
    // 断言：状态为 'done'（非 'failed'）
    const doneCall = mockDb.updateTask.mock.calls.find(
      (call: any[]) => call[1]?.status === 'done',
    );
    expect(doneCall).toBeTruthy();
  });

  it('A-3: Handler 抛业务异常 → lease仍然被释放', async () => {
    const engine = AssignmentEngine.getInstance();
    const lease = createMockLease('test-window-001', 'test-error-001');

    const mockPool = {
      getStaffConnection: vi.fn().mockResolvedValue({
        windowId: 'test-window-001',
        page: {},
      }),
      ensureWindowReady: vi.fn().mockResolvedValue(undefined),
      acquireWindowLease: vi.fn().mockResolvedValue(lease),
      markWindowBusy: vi.fn(),
      markWindowIdle: vi.fn(),
      refreshBusyLease: vi.fn(),
    };
    const { BrowserPool } = await import('../../../browser/BrowserPool');
    (BrowserPool as any).getInstance = () => mockPool;

    await engine.execute({
      taskId: 'test-error-001',
      site: 'tiannanda',
      taskType: 'arrival',
      assignments: [makeAssignment('员工A', 3)],
      handler: createErrorHandler(),
      handlerTimeoutMs: 30_000,
    });

    // 断言：lease.release 被调用
    expect(lease.release).toHaveBeenCalled();
  });
});

describe('AssignmentEngine — 取消机制 (Phase 9.2: Lease)', () => {
  it('B-1: cancelTask() → lease被释放 → status 保持 cancelled', async () => {
    const engine = AssignmentEngine.getInstance();
    const lease = createMockLease('test-window-001', 'test-cancel-001');

    const mockPool = {
      getStaffConnection: vi.fn().mockResolvedValue({
        windowId: 'test-window-001',
        page: {},
      }),
      ensureWindowReady: vi.fn().mockResolvedValue(undefined),
      acquireWindowLease: vi.fn().mockResolvedValue(lease),
      markWindowBusy: vi.fn(),
      markWindowIdle: vi.fn(),
      refreshBusyLease: vi.fn(),
    };
    const { BrowserPool } = await import('../../../browser/BrowserPool');
    (BrowserPool as any).getInstance = () => mockPool;

    const taskPromise = engine.execute({
      taskId: 'test-cancel-001',
      site: 'tiannanda',
      taskType: 'arrival',
      assignments: [makeAssignment('员工A', 3)],
      handler: createHangingHandler(),
      handlerTimeoutMs: 30_000,
    });

    await new Promise(r => setTimeout(r, 100));

    const cancelled = await engine.cancelTask('test-cancel-001');
    expect(cancelled).toBe(true);

    await taskPromise;
    await new Promise(r => setTimeout(r, 50));

    // 断言：lease.release 被调用
    expect(lease.release).toHaveBeenCalled();

    // 断言：cancelTask 中调用了 db.updateTask(status='cancelled')
    const cancelledCalls = mockDb.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.status === 'cancelled',
    );
    expect(cancelledCalls.length).toBeGreaterThanOrEqual(1);

    // 断言：没有 calls 覆盖为 'failed'
    const failedCalls = mockDb.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.status === 'failed',
    );
    expect(failedCalls.length).toBe(0);
  });

  it('B-2: cancelTask() 对不存在的任务返回 false', async () => {
    const engine = AssignmentEngine.getInstance();
    const result = await engine.cancelTask('non-existent-task-id');
    expect(result).toBe(false);
  });

  it('B-3: cancelTask() 对已完成的任务返回 false', async () => {
    const engine = AssignmentEngine.getInstance();
    const lease = createMockLease('test-window-001', 'test-done-001');

    const mockPool = {
      getStaffConnection: vi.fn().mockResolvedValue({
        windowId: 'test-window-001',
        page: {},
      }),
      ensureWindowReady: vi.fn().mockResolvedValue(undefined),
      acquireWindowLease: vi.fn().mockResolvedValue(lease),
      markWindowBusy: vi.fn(),
      markWindowIdle: vi.fn(),
      refreshBusyLease: vi.fn(),
    };
    const { BrowserPool } = await import('../../../browser/BrowserPool');
    (BrowserPool as any).getInstance = () => mockPool;

    await engine.execute({
      taskId: 'test-done-001',
      site: 'tiannanda',
      taskType: 'arrival',
      assignments: [makeAssignment('员工A', 3)],
      handler: createOkHandler(),
    });

    const result = await engine.cancelTask('test-done-001');
    expect(result).toBe(false);
  });
});

describe('AssignmentEngine — 内存泄漏防护 (Phase 9.2: Lease)', () => {
  it('C-1: 正常完成后 cancelControllers Map 被清理', async () => {
    const engine = AssignmentEngine.getInstance();
    const lease = createMockLease('test-window-001', 'test-cleanup-001');

    const mockPool = {
      getStaffConnection: vi.fn().mockResolvedValue({
        windowId: 'test-window-001',
        page: {},
      }),
      ensureWindowReady: vi.fn().mockResolvedValue(undefined),
      acquireWindowLease: vi.fn().mockResolvedValue(lease),
      markWindowBusy: vi.fn(),
      markWindowIdle: vi.fn(),
      refreshBusyLease: vi.fn(),
    };
    const { BrowserPool } = await import('../../../browser/BrowserPool');
    (BrowserPool as any).getInstance = () => mockPool;

    await engine.execute({
      taskId: 'test-cleanup-001',
      site: 'tiannanda',
      taskType: 'arrival',
      assignments: [makeAssignment('员工A', 3)],
      handler: createOkHandler(),
    });

    const result = await engine.cancelTask('test-cleanup-001');
    expect(result).toBe(false);
    // 验证 lease.release 被调用（无资源残留）
    expect(lease.release).toHaveBeenCalled();
  });

  it('C-2: 超时后 cancelControllers Map 被清理', async () => {
    const engine = AssignmentEngine.getInstance();
    const lease = createMockLease('test-window-001', 'test-cleanup-timeout');

    const mockPool = {
      getStaffConnection: vi.fn().mockResolvedValue({
        windowId: 'test-window-001',
        page: {
          close: vi.fn().mockResolvedValue(undefined),
        },
      }),
      ensureWindowReady: vi.fn().mockResolvedValue(undefined),
      acquireWindowLease: vi.fn().mockResolvedValue(lease),
      markWindowBusy: vi.fn(),
      markWindowIdle: vi.fn(),
      refreshBusyLease: vi.fn(),
    };
    const { BrowserPool } = await import('../../../browser/BrowserPool');
    (BrowserPool as any).getInstance = () => mockPool;

    await engine.execute({
      taskId: 'test-cleanup-timeout',
      site: 'tiannanda',
      taskType: 'arrival',
      assignments: [makeAssignment('员工A', 3)],
      handler: createHangingHandler(),
      handlerTimeoutMs: 500,
    });

    const result = await engine.cancelTask('test-cleanup-timeout');
    expect(result).toBe(false);
    expect(lease.release).toHaveBeenCalled();
  });

  it('C-3: 取消后 cancelControllers Map 被清理', async () => {
    const engine = AssignmentEngine.getInstance();
    const lease = createMockLease('test-window-001', 'test-cleanup-cancel');

    const mockPool = {
      getStaffConnection: vi.fn().mockResolvedValue({
        windowId: 'test-window-001',
        page: {},
      }),
      ensureWindowReady: vi.fn().mockResolvedValue(undefined),
      acquireWindowLease: vi.fn().mockResolvedValue(lease),
      markWindowBusy: vi.fn(),
      markWindowIdle: vi.fn(),
      refreshBusyLease: vi.fn(),
    };
    const { BrowserPool } = await import('../../../browser/BrowserPool');
    (BrowserPool as any).getInstance = () => mockPool;

    const taskPromise = engine.execute({
      taskId: 'test-cleanup-cancel',
      site: 'tiannanda',
      taskType: 'arrival',
      assignments: [makeAssignment('员工A', 3)],
      handler: createHangingHandler(),
      handlerTimeoutMs: 30_000,
    });

    await new Promise(r => setTimeout(r, 100));

    const firstCancel = await engine.cancelTask('test-cleanup-cancel');
    expect(firstCancel).toBe(true);

    await taskPromise;
    await new Promise(r => setTimeout(r, 50));

    const secondCancel = await engine.cancelTask('test-cleanup-cancel');
    expect(secondCancel).toBe(false);
    expect(lease.release).toHaveBeenCalled();
  });
});
