// C1-2/C1-3 单元测试: parseArriveScanResult 纯函数
// 使用 node:assert 自执行，无需测试框架依赖
// 运行: npx tsx src/operations/__tests__/arriveScanResult.test.ts
import assert from 'node:assert/strict';
import { parseArriveScanResult } from '../arriveScanResult';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).message}`);
  }
}

console.log('\n=== parseArriveScanResult 单元测试 ===\n');

// ── C1-2: toast 缺失误判 ──
console.log('[C1-2] toast 缺失误判');

test('空字符串 → UNKNOWN_NEEDS_MANUAL_CHECK（不等于 FAILED）', () => {
  const r = parseArriveScanResult('', 2);
  assert.equal(r.status, 'UNKNOWN_NEEDS_MANUAL_CHECK');
  assert.equal(r.successCount, null);
  assert.equal(r.failCount, null);
  assert.ok(r.message.includes('toast 未出现'), `message 应提示 toast 未出现，实际: ${r.message}`);
});

test('null/undefined → UNKNOWN_NEEDS_MANUAL_CHECK', () => {
  const r1 = parseArriveScanResult(null as unknown as string, 2);
  const r2 = parseArriveScanResult(undefined as unknown as string, 2);
  assert.equal(r1.status, 'UNKNOWN_NEEDS_MANUAL_CHECK');
  assert.equal(r2.status, 'UNKNOWN_NEEDS_MANUAL_CHECK');
});

test('纯空格 → UNKNOWN_NEEDS_MANUAL_CHECK', () => {
  const r = parseArriveScanResult('   \n  \t ', 2);
  assert.equal(r.status, 'UNKNOWN_NEEDS_MANUAL_CHECK');
});

// ── C1-3: 成功判定过宽 ──
console.log('\n[C1-3] 成功判定过宽 — 解析具体数量');

test('"批量到件成功"（无数量）→ SUCCESS，数量取 batchSize', () => {
  const r = parseArriveScanResult('批量到件成功', 2);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.successCount, 2);
  assert.equal(r.failCount, 0);
});

test('"成功2条,失败0条" → SUCCESS', () => {
  const r = parseArriveScanResult('批量到件成功2条,失败0条', 2);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.successCount, 2);
  assert.equal(r.failCount, 0);
});

test('"部分成功,成功1条,失败1条" → PARTIAL（不应为纯 SUCCESS）', () => {
  const r = parseArriveScanResult('部分成功,成功1条,失败1条', 2);
  assert.equal(r.status, 'PARTIAL');
  assert.equal(r.successCount, 1);
  assert.equal(r.failCount, 1);
  assert.notEqual(r.status, 'SUCCESS', 'PARTIAL 不应被误判为 SUCCESS');
});

test('"成功1条失败1条"（无逗号）→ PARTIAL', () => {
  const r = parseArriveScanResult('成功1条失败1条', 2);
  assert.equal(r.status, 'PARTIAL');
  assert.equal(r.successCount, 1);
  assert.equal(r.failCount, 1);
});

test('"操作失败"（纯失败文案）→ FAILED', () => {
  const r = parseArriveScanResult('操作失败', 2);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.successCount, 0);
  assert.equal(r.failCount, 2);
});

test('"成功0条,失败2条" → FAILED', () => {
  const r = parseArriveScanResult('成功0条,失败2条', 2);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.successCount, 0);
  assert.equal(r.failCount, 2);
});

test('"成功0条失败2条" → FAILED', () => {
  const r = parseArriveScanResult('成功0条失败2条', 2);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.failCount, 2);
});

test('无法解析的文案 → UNKNOWN_NEEDS_MANUAL_CHECK（不默认成功）', () => {
  const r = parseArriveScanResult('系统繁忙，请稍后再试', 2);
  assert.equal(r.status, 'UNKNOWN_NEEDS_MANUAL_CHECK');
  assert.equal(r.successCount, null);
  assert.ok(r.message.includes('无法解析'), `message 应提示无法解析，实际: ${r.message}`);
});

test('"成功0条失败0条"（数量异常）→ UNKNOWN_NEEDS_MANUAL_CHECK', () => {
  const r = parseArriveScanResult('成功0条失败0条', 2);
  assert.equal(r.status, 'UNKNOWN_NEEDS_MANUAL_CHECK');
});

// ── 关键回归：旧逻辑会误判的场景 ──
console.log('\n[回归] 旧正则 /成功|完成|success/ 会误判的场景');

test('"部分成功" 旧逻辑会判 SUCCESS，新逻辑应 PARTIAL', () => {
  const r = parseArriveScanResult('部分成功,成功1条,失败1条', 2);
  assert.notEqual(r.status, 'SUCCESS');
  assert.equal(r.status, 'PARTIAL');
});

test('"操作失败" 旧逻辑不含关键词会判 false，但"失败"含"成功"子串？验证不误判', () => {
  // "操作失败" 不含"成功"，旧逻辑判 false；新逻辑明确 FAILED
  const r = parseArriveScanResult('操作失败', 2);
  assert.equal(r.status, 'FAILED');
});

test('toast 缺失 旧逻辑判 false(等同失败)，新逻辑应 UNKNOWN', () => {
  const r = parseArriveScanResult('', 2);
  assert.notEqual(r.status, 'FAILED');
  assert.equal(r.status, 'UNKNOWN_NEEDS_MANUAL_CHECK');
});

// ── Phase L-2: 反向数量匹配 ──
console.log('\n[L-2] 反向数量匹配（N条成功/M条失败）');

test('"2条成功,0条失败"（反向文案）→ SUCCESS', () => {
  const r = parseArriveScanResult('2条成功,0条失败', 2);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.successCount, 2);
  assert.equal(r.failCount, 0);
});

test('"0条成功,2条失败"（反向纯失败）→ FAILED', () => {
  const r = parseArriveScanResult('0条成功,2条失败', 2);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.successCount, 0);
  assert.equal(r.failCount, 2);
});

test('"1条成功,1条失败"（反向部分成功）→ PARTIAL', () => {
  const r = parseArriveScanResult('1条成功,1条失败', 2);
  assert.equal(r.status, 'PARTIAL');
  assert.equal(r.successCount, 1);
  assert.equal(r.failCount, 1);
});

// ── Phase L-2: "部分成功" 纯文案（无具体数量） ──
console.log('\n[L-2] "部分成功"纯文案无数量');

test('"部分成功"（无数量）→ PARTIAL，需人工核实', () => {
  const r = parseArriveScanResult('部分成功', 5);
  assert.equal(r.status, 'PARTIAL');
  assert.equal(r.successCount, null);
  assert.equal(r.failCount, null);
  assert.ok(r.message.includes('部分成功'), `message 应包含部分成功: ${r.message}`);
  assert.ok(r.message.includes('需人工核实'), `message 应提示需人工核实: ${r.message}`);
});

test('"部分失败，请联系管理员"（无数量）→ PARTIAL', () => {
  const r = parseArriveScanResult('部分失败，请联系管理员', 5);
  assert.equal(r.status, 'PARTIAL');
  assert.equal(r.successCount, null);
  assert.equal(r.failCount, null);
});

test('"部分异常"（无数量）→ PARTIAL', () => {
  const r = parseArriveScanResult('部分异常', 5);
  assert.equal(r.status, 'PARTIAL');
  assert.equal(r.successCount, null);
  assert.equal(r.failCount, null);
});

// ── Phase L-2: 变体文案 ──
console.log('\n[L-2] 变体文案（已完成/处理成功 N 条）');

test('"已完成5条" → SUCCESS', () => {
  const r = parseArriveScanResult('已完成5条', 5);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.successCount, 5);
  assert.equal(r.failCount, 0);
});

test('"处理成功3条" → SUCCESS', () => {
  const r = parseArriveScanResult('处理成功3条', 3);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.successCount, 3);
  assert.equal(r.failCount, 0);
});

test('"提交成功"（无数量）→ SUCCESS', () => {
  const r = parseArriveScanResult('提交成功', 5);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.successCount, 5);
  assert.equal(r.failCount, 0);
});

test('"提交失败"（无数量）→ FAILED', () => {
  const r = parseArriveScanResult('提交失败', 5);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.successCount, 0);
  assert.equal(r.failCount, 5);
});

// ── 数量带空格的容错 ──
console.log('\n[容错] 数量带空格');

test('"成功 2 条, 失败 0 条"（带空格）→ SUCCESS', () => {
  const r = parseArriveScanResult('成功 2 条, 失败 0 条', 2);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.successCount, 2);
});

// ── 汇总 ──
console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
if (failed > 0) {
  process.exit(1);
}
