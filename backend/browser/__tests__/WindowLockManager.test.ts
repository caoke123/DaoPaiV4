// WindowLockManager 单元测试
// 使用 node:assert 自执行，无需测试框架依赖
// 运行: npx tsx src/browser/__tests__/WindowLockManager.test.ts
import assert from 'node:assert/strict';
import {
  WindowLockManager,
  WindowBusyError,
} from '../WindowLockManager';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve(fn())
    .then(() => {
      passed++;
      console.log(`  \u2713 ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  \u2717 ${name}`);
      console.error(`    ${(e as Error).message}`);
    })
    .finally(() => {
      // 异步测试计数器，runTests 末尾有 setTimeout 兜底
    });
}

/**
 * 重置单例（通过反射访问 private static instance）
 * 保证每个测试用例独立
 */
function resetSingleton(): void {
  (WindowLockManager as unknown as { instance: WindowLockManager | null }).instance = null;
}

console.log('\n=== WindowLockManager 单元测试 ===\n');

// ── Case 1: acquire → success ──
console.log('[Case1] acquire → success');

test('acquire 空闲窗口应成功', async () => {
  resetSingleton();
  const lock = WindowLockManager.getInstance();
  await lock.acquire('win-001', 'task-A');
  assert.equal(lock.isBusy('win-001'), true);
  const info = lock.getLock('win-001');
  assert.ok(info, 'getLock 应返回锁信息');
  assert.equal(info!.windowId, 'win-001');
  assert.equal(info!.taskId, 'task-A');
  assert.equal(typeof info!.acquiredAt, 'number');
});

// ── Case 2: acquire → acquire → WindowBusyError ──
console.log('[Case2] acquire → acquire → WindowBusyError');

test('acquire 已占用窗口应抛 WindowBusyError', async () => {
  resetSingleton();
  const lock = WindowLockManager.getInstance();
  await lock.acquire('win-002', 'task-A');
  await assert.rejects(
    () => lock.acquire('win-002', 'task-B'),
    (err: unknown) => {
      assert.ok(err instanceof WindowBusyError, '应抛 WindowBusyError');
      assert.equal((err as WindowBusyError).windowId, 'win-002');
      assert.equal((err as WindowBusyError).currentTaskId, 'task-A');
      return true;
    },
  );
});

// ── Case 3: acquire → release → acquire → success ──
console.log('[Case3] acquire → release → acquire → success');

test('release 后再次 acquire 应成功', async () => {
  resetSingleton();
  const lock = WindowLockManager.getInstance();
  await lock.acquire('win-003', 'task-A');
  lock.release('win-003', 'task-A');
  assert.equal(lock.isBusy('win-003'), false);
  // 释放后可再次获取
  await lock.acquire('win-003', 'task-B');
  assert.equal(lock.isBusy('win-003'), true);
  const info = lock.getLock('win-003');
  assert.equal(info!.taskId, 'task-B');
});

// ── Case 4: release → release → no throw ──
console.log('[Case4] release → release → no throw');

test('重复 release 不报错（幂等）', () => {
  resetSingleton();
  const lock = WindowLockManager.getInstance();
  // 未 acquire 直接 release
  assert.doesNotThrow(() => lock.release('win-004'));
  // acquire 后多次 release
  void lock.acquire('win-004', 'task-A').then(() => {
    lock.release('win-004', 'task-A');
    assert.doesNotThrow(() => lock.release('win-004', 'task-A'));
    assert.doesNotThrow(() => lock.release('win-004'));
  });
});

// ── 额外用例：getSnapshot / getOverdueLocks / taskId 校验 ──
console.log('[额外] getSnapshot / getOverdueLocks / taskId 校验');

test('getSnapshot 返回所有占用窗口', async () => {
  resetSingleton();
  const lock = WindowLockManager.getInstance();
  await lock.acquire('win-A', 'task-1');
  await lock.acquire('win-B', 'task-2');
  const snapshot = lock.getSnapshot();
  assert.equal(snapshot.length, 2);
  const winA = snapshot.find((s) => s.windowId === 'win-A');
  assert.ok(winA);
  assert.equal(winA!.busy, true);
  assert.equal(winA!.taskId, 'task-1');
});

test('getOverdueLocks 返回超时锁（不自动释放）', async () => {
  resetSingleton();
  const lock = WindowLockManager.getInstance();
  await lock.acquire('win-old', 'task-old');
  // 手动篡改 acquiredAt 为 10 分钟前
  const info = lock.getLock('win-old')!;
  (info as { acquiredAt: number }).acquiredAt = Date.now() - 10 * 60 * 1000;
  await lock.acquire('win-new', 'task-new');

  const overdue = lock.getOverdueLocks(5 * 60 * 1000);
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].windowId, 'win-old');
  // 确认未自动释放
  assert.equal(lock.isBusy('win-old'), true);
  assert.equal(lock.isBusy('win-new'), true);
});

test('release 时 taskId 不匹配应跳过（不报错，不释放）', async () => {
  resetSingleton();
  const lock = WindowLockManager.getInstance();
  await lock.acquire('win-005', 'task-A');
  // 用错误的 taskId 释放
  lock.release('win-005', 'task-WRONG');
  assert.equal(lock.isBusy('win-005'), true, 'taskId 不匹配时不应释放');
  // 用正确的 taskId 释放
  lock.release('win-005', 'task-A');
  assert.equal(lock.isBusy('win-005'), false);
});

test('单例：getInstance 返回同一实例', () => {
  resetSingleton();
  const a = WindowLockManager.getInstance();
  const b = WindowLockManager.getInstance();
  assert.equal(a, b);
});

// 兜底：等待所有异步测试完成
setTimeout(() => {
  console.log(`\n=== 测试结果: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}, 500);
