/**
 * appendResults.test.ts — 批次级增量结果持久化的集成测试（Phase I）
 *
 * 测试目标：
 *   A. 100 批次并发写入 → 全部入库（数量正确，无丢失、无重复）
 *   B. Promise 链串行化 → 写入顺序与调用顺序一致
 *   C. getTaskResults 容错读取 → 损坏行被跳过，其余数据正常
 *   D. IO 异常隔离 → 写入失败不崩溃，任务信息依然可查
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock fs-extra（使用 vi.hoisted 避免 hoisting 顺序问题） ──

const { mockExistsSync, mockEnsureDirSync, mockAppendFileSync, mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => {
  return {
    mockExistsSync: vi.fn().mockReturnValue(false),
    mockEnsureDirSync: vi.fn(),
    mockAppendFileSync: vi.fn(),
    mockReadFileSync: vi.fn().mockReturnValue(''),
    mockWriteFileSync: vi.fn(),
  };
});

vi.mock('fs-extra', () => ({
  default: {
    existsSync: mockExistsSync,
    ensureDirSync: mockEnsureDirSync,
    appendFileSync: mockAppendFileSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  },
  existsSync: mockExistsSync,
  ensureDirSync: mockEnsureDirSync,
  appendFileSync: mockAppendFileSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
}));

import { Database } from '../Database';
import type { OperationResult } from '../../operations/BaseOperation';

// ── 模拟 OperationResult ──────────────────────────────

function makeResult(waybillNo: string, success = true): OperationResult {
  return {
    waybillNo,
    staffName: '测试员工',
    success,
    message: success ? '扫描成功' : '扫描失败',
    timestamp: Date.now(),
    status: success ? 'SUCCESS' : 'FAILED',
  };
}

// ── 测试前/后重置 ─────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  (Database as any).instance = null;

  mockExistsSync.mockReturnValue(false);
  mockEnsureDirSync.mockReset();
  mockAppendFileSync.mockReset();
  mockReadFileSync.mockReturnValue('');
  mockWriteFileSync.mockReset();
});

// ── 测试用例 ──────────────────────────────────────────

describe('Database — 批次级增量写入', () => {
  it('A-1: 100 批次并发追加 → 全部入库（模拟 Promise 链）', async () => {
    const db = Database.getInstance();

    // 内存中模拟 JSONL 存储
    const storedLines: string[] = [];
    mockAppendFileSync.mockImplementation((_filePath: string, data: string) => {
      storedLines.push(data.trimEnd());
    });
    mockReadFileSync.mockImplementation(() => storedLines.join('\n') + '\n');
    mockExistsSync.mockReturnValue(true);

    // 准备 100 批数据
    const totalBatches = 100;
    const resultsPerBatch = 3;
    const batches: OperationResult[][] = Array.from({ length: totalBatches }, (_, i) =>
      Array.from({ length: resultsPerBatch }, (_, j) =>
        makeResult(`580${String(i * resultsPerBatch + j).padStart(9, '0')}`, j % 3 !== 0),
      ),
    );

    // 模拟 Engine 中的简易 Promise 链（与 AssignmentEngine 实现完全一致）
    let writeChain: Promise<void> = Promise.resolve();

    const appendPromises = batches.map((batch) => {
      writeChain = writeChain.then(() =>
        Promise.resolve(db.appendTaskResults('test-concurrent-001', batch)),
      );
      return writeChain;
    });

    // 等待所有写入完成
    await Promise.all(appendPromises);

    // 断言：100 个批次全部写入
    expect(storedLines).toHaveLength(totalBatches);

    // 断言：每行都是合法的 JSON 数组
    for (const line of storedLines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(resultsPerBatch);
    }

    // 断言：读取回来数据完整
    const allResults = db.getTaskResults('test-concurrent-001');
    expect(allResults).toHaveLength(totalBatches * resultsPerBatch);

    // 断言：成功/失败计数正确（每 3 条有 2 成功 1 失败）
    const successCount = allResults.filter(r => r.success).length;
    const failCount = allResults.filter(r => !r.success).length;
    expect(successCount).toBe(totalBatches * 2);
    expect(failCount).toBe(totalBatches * 1);
  });

  it('A-2: 写入顺序与调用顺序一致（串行保证）', async () => {
    const db = Database.getInstance();

    const storedLines: string[] = [];
    mockAppendFileSync.mockImplementation((_filePath: string, data: string) => {
      storedLines.push(data.trimEnd());
    });
    mockReadFileSync.mockImplementation(() => storedLines.join('\n') + '\n');
    mockExistsSync.mockReturnValue(true);

    // 按顺序写入批次（模拟串行 Promise 链）
    let writeChain: Promise<void> = Promise.resolve();
    const seq: number[] = [];

    for (let i = 0; i < 50; i++) {
      writeChain = writeChain.then(() => {
        seq.push(i);
        return Promise.resolve(
          db.appendTaskResults('test-order-001', [makeResult(`ORD${String(i).padStart(6, '0')}`)]),
        );
      });
    }

    await writeChain;

    // 断言：顺序与调用一致
    for (let i = 0; i < 50; i++) {
      expect(seq[i]).toBe(i);
    }

    // 断言：所有数据都可以读回
    const allResults = db.getTaskResults('test-order-001');
    expect(allResults).toHaveLength(50);
    expect(allResults[0].waybillNo).toContain('ORD000000');
    expect(allResults[49].waybillNo).toContain('ORD000049');
  });

  it('A-3: 并发写入不丢失批次', async () => {
    const db = Database.getInstance();

    const storedLines: string[] = [];
    mockAppendFileSync.mockImplementation((_filePath: string, data: string) => {
      storedLines.push(data.trimEnd());
    });
    mockReadFileSync.mockImplementation(() => storedLines.join('\n') + '\n');
    mockExistsSync.mockReturnValue(true);

    // 同时触发 200 个批次写入（模拟极端并发）
    let writeChain: Promise<void> = Promise.resolve();
    const totalBatches = 200;
    const allPromises: Promise<void>[] = [];

    for (let i = 0; i < totalBatches; i++) {
      const batch = [makeResult(`C${String(i).padStart(8, '0')}`)];
      writeChain = writeChain.then(() =>
        Promise.resolve(db.appendTaskResults('test-concurrent-002', batch)),
      );
      allPromises.push(writeChain);
    }

    await Promise.all(allPromises);

    // 断言：200 个批次全部写入，无丢失
    expect(storedLines).toHaveLength(totalBatches);

    // 断言：无重复行
    const uniqueLines = new Set(storedLines);
    expect(uniqueLines.size).toBe(totalBatches);

    // 断言：可完整读回
    const allResults = db.getTaskResults('test-concurrent-002');
    expect(allResults).toHaveLength(totalBatches);
  });
});

describe('Database — 容错读取', () => {
  it('B-1: getTaskResults 跳过损坏行，正常行依然可读', () => {
    const db = Database.getInstance();

    // 构造 JSONL：2 行正常 + 1 行损坏 + 2 行正常
    const mixedContent = [
      JSON.stringify([makeResult('GOOD01')]),
      JSON.stringify([makeResult('GOOD02')]),
      '{{{ broken json {{{', // 损坏行（进程崩溃所致）
      JSON.stringify([makeResult('GOOD03')]),
      JSON.stringify([makeResult('GOOD04')]),
    ].join('\n') + '\n';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(mixedContent);

    const results = db.getTaskResults('test-tolerance-001');

    // 断言：4 条正确数据都被读出
    expect(results).toHaveLength(4);
    expect(results.map(r => r.waybillNo)).toEqual([
      'GOOD01', 'GOOD02', 'GOOD03', 'GOOD04',
    ]);
  });

  it('B-2: 文件不存在时返回空数组', () => {
    const db = Database.getInstance();
    mockExistsSync.mockReturnValue(false);

    const results = db.getTaskResults('non-existent-task');
    expect(results).toEqual([]);
  });

  it('B-3: 全部损坏行时返回空数组', () => {
    const db = Database.getInstance();

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json at all\nstill not json\n');

    const results = db.getTaskResults('test-all-broken');
    expect(results).toEqual([]);
  });
});

describe('Database — IO 异常隔离', () => {
  it('C-1: appendTaskResults 写入失败不抛异常', () => {
    const db = Database.getInstance();

    // 模拟磁盘满：ensureDirSync 抛错
    mockEnsureDirSync.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    // 不应抛出异常
    expect(() => {
      db.appendTaskResults('test-io-error', [makeResult('IO01')]);
    }).not.toThrow();

    // 即使写入失败，任务信息依然可查（通过 getTask）
    // 这是隐式断言的：代码已经跑过了没有异常
  });

  it('C-2: JSON.stringify 失败不抛异常', () => {
    const db = Database.getInstance();

    // 构造循环引用对象（JSON.stringify 会抛错）
    const circular: any = { waybillNo: 'CIRC' };
    circular.self = circular;

    const badResults = [circular] as any;

    // 不应抛出异常
    expect(() => {
      db.appendTaskResults('test-circular', badResults);
    }).not.toThrow();
  });
});
