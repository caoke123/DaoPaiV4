/**
 * Problem C 对照测试脚本
 *
 * 目标：验证 EasyBR 自动拉起窗口后，browerid 是否稳定
 *
 * 流程：
 *   1. 采集基线快照（getBrowerList + openedList 完整数据）
 *   2. 通过 EasyBR API 关闭指定窗口
 *   3. 每 2 秒轮询 getBrowerList + openedList，持续 120 秒
 *   4. 所有数据带时间戳落盘到 JSON 文件
 *
 * 用法：
 *   npx tsx scripts/problem-c-test.ts <browername> [duration_seconds]
 *   例：npx tsx scripts/problem-c-test.ts "天南大-刘磊" 120
 */

import axios from 'axios';

const EASYBR_BASE = 'http://127.0.0.1:3001';
const POLL_INTERVAL_MS = 2000;
const DEFAULT_DURATION_S = 120;

interface BrowerConfig {
  browerid: string;
  browername: string;
}

interface OpenedWindow {
  browerid: string;
  browername: string;
  isopen: boolean;
}

interface Snapshot {
  timestamp: string;
  elapsedMs: number;
  getBrowerList: BrowerConfig[];
  openedList: OpenedWindow[];
  error?: string;
}

async function getBrowerList(): Promise<BrowerConfig[]> {
  const resp = await axios.get(`${EASYBR_BASE}/auto/getBrowerList`, {
    params: { page: 1, limit: 100 },
    timeout: 8000,
  });
  if (resp.data.code !== 0) throw new Error(`getBrowerList code=${resp.data.code}`);
  return resp.data.data as BrowerConfig[];
}

async function openedList(): Promise<OpenedWindow[]> {
  const resp = await axios.get(`${EASYBR_BASE}/auto/openedList`, {
    timeout: 8000,
  });
  if (resp.data.code !== 0) throw new Error(`openedList code=${resp.data.code}`);
  return resp.data.data as OpenedWindow[];
}

async function closeBrower(browerid: string): Promise<void> {
  const resp = await axios.post(`${EASYBR_BASE}/auto/closeBrower`, {
    browerid,
  }, { timeout: 8000 });
  if (resp.data.code !== 0) throw new Error(`closeBrower code=${resp.data.code} msg=${resp.data.msg}`);
}

async function takeSnapshot(elapsedMs: number): Promise<Snapshot> {
  const timestamp = new Date().toISOString();
  try {
    const [browerList, opened] = await Promise.all([
      getBrowerList(),
      openedList(),
    ]);
    return { timestamp, elapsedMs, getBrowerList: browerList, openedList: opened };
  } catch (e) {
    return {
      timestamp,
      elapsedMs,
      getBrowerList: [],
      openedList: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function formatSnapshot(snap: Snapshot, targetName: string): string {
  const lines: string[] = [];
  lines.push(`[${snap.timestamp}] (+${(snap.elapsedMs / 1000).toFixed(1)}s)`);

  if (snap.error) {
    lines.push(`  ❌ ERROR: ${snap.error}`);
    return lines.join('\n');
  }

  // 打印目标窗口在 getBrowerList 中的状态
  const targetInList = snap.getBrowerList.find(b => b.browername === targetName);
  if (targetInList) {
    lines.push(`  getBrowerList: browerid="${targetInList.browerid}" name="${targetInList.browername}"`);
  } else {
    lines.push(`  getBrowerList: ❌ 未找到 "${targetName}"`);
  }

  // 打印目标窗口在 openedList 中的状态
  const targetInOpened = snap.openedList.find(b => b.browername === targetName);
  if (targetInOpened) {
    lines.push(`  openedList:    browerid="${targetInOpened.browerid}" name="${targetInOpened.browername}" isopen=${targetInOpened.isopen}`);
  } else {
    lines.push(`  openedList:    ❌ 未找到 "${targetName}"`);
  }

  // 打印所有 openedList 窗口概要
  const openCount = snap.openedList.filter(w => w.isopen).length;
  lines.push(`  openedList 总计: ${snap.openedList.length} 条 (${openCount} 个 isopen=true)`);
  for (const w of snap.openedList) {
    if (w.browername.includes('天南大')) {
      lines.push(`    - browerid="${w.browerid}" name="${w.browername}" isopen=${w.isopen}`);
    }
  }

  return lines.join('\n');
}

async function main() {
  const targetName = process.argv[2] || '天南大-刘磊';
  const durationS = parseInt(process.argv[3] || String(DEFAULT_DURATION_S), 10);

  console.log('═══════════════════════════════════════════');
  console.log('  Problem C 对照测试');
  console.log('═══════════════════════════════════════════');
  console.log(`  目标窗口: ${targetName}`);
  console.log(`  采集时长: ${durationS}s`);
  console.log(`  轮询间隔: ${POLL_INTERVAL_MS}ms`);
  console.log('');

  // ── 第一步：采集基线快照 ──
  console.log('━━━ 第一步：采集基线快照（关闭前）━━━');
  const baseline = await takeSnapshot(0);
  console.log(formatSnapshot(baseline, targetName));
  console.log('');

  // 找到目标窗口的 browerid
  const targetInList = baseline.getBrowerList.find(b => b.browername === targetName);
  if (!targetInList) {
    console.error(`❌ 在 getBrowerList 中未找到 "${targetName}"，无法继续测试`);
    process.exit(1);
  }
  const targetBrowerId = targetInList.browerid;
  console.log(`  → 目标窗口 browerid: ${targetBrowerId}`);
  console.log('');

  // ── 第二步：关闭窗口 ──
  console.log('━━━ 第二步：通过 EasyBR API 关闭窗口 ━━━');
  const closeTime = Date.now();
  try {
    await closeBrower(targetBrowerId);
    console.log(`  ✓ closeBrower 成功: ${targetBrowerId}`);
  } catch (e) {
    console.error(`  ❌ closeBrower 失败: ${e instanceof Error ? e.message : String(e)}`);
    console.log('  → 继续采集数据（窗口可能已被手动关闭）');
  }
  console.log('');

  // ── 第三步：持续轮询采集 ──
  console.log(`━━━ 第三步：持续轮询采集 (${durationS}s) ━━━`);
  const snapshots: Snapshot[] = [baseline];
  const startTime = Date.now();

  while (Date.now() - startTime < durationS * 1000) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const elapsed = Date.now() - closeTime;
    const snap = await takeSnapshot(elapsed);
    snapshots.push(snap);
    console.log(formatSnapshot(snap, targetName));

    // 如果目标窗口已恢复（isopen=true），继续采集 10 秒后停止
    const targetOpened = snap.openedList.find(b => b.browername === targetName);
    if (targetOpened && targetOpened.isopen && elapsed > 20000) {
      console.log(`  → 窗口已恢复，继续采集 10 秒...`);
      await new Promise(r => setTimeout(r, 10000));
      // 再采集一次最终状态
      const finalSnap = await takeSnapshot(Date.now() - closeTime);
      snapshots.push(finalSnap);
      console.log(formatSnapshot(finalSnap, targetName));
      break;
    }
  }

  // ── 第四步：保存完整数据到 JSON ──
  const outputFile = `scripts/problem-c-result-${Date.now()}.json`;
  const fs = await import('fs');
  fs.writeFileSync(outputFile, JSON.stringify(snapshots, null, 2), 'utf-8');
  console.log('');
  console.log(`━━━ 完成 ━━━`);
  console.log(`  采集 ${snapshots.length} 个快照`);
  console.log(`  完整数据已保存到: ${outputFile}`);

  // ── 第五步：打印对比摘要 ──
  console.log('');
  console.log('━━━ 对比摘要 ━━━');
  console.log(`  基线 browerid (getBrowerList): ${targetBrowerId}`);

  const finalSnap = snapshots[snapshots.length - 1];
  const finalInList = finalSnap.getBrowerList.find(b => b.browername === targetName);
  const finalInOpened = finalSnap.openedList.find(b => b.browername === targetName);

  if (finalInList) {
    const same = finalInList.browerid === targetBrowerId;
    console.log(`  最终 browerid (getBrowerList): ${finalInList.browerid} ${same ? '✓ 一致' : '❌ 不一致!'}`);
  } else {
    console.log(`  最终 browerid (getBrowerList): ❌ 未找到`);
  }

  if (finalInOpened) {
    const same = finalInOpened.browerid === targetBrowerId;
    console.log(`  最终 browerid (openedList):    ${finalInOpened.browerid} ${same ? '✓ 一致' : '❌ 不一致!'}`);
    console.log(`  最终 isopen: ${finalInOpened.isopen}`);
  } else {
    console.log(`  最终 browerid (openedList):    ❌ 未找到`);
  }

  // 打印 openedList 中 isopen 变化时间线
  console.log('');
  console.log('━━━ openedList isopen 变化时间线 ━━━');
  let prevIsOpen: boolean | null = null;
  let prevFound: boolean | null = null;
  for (const snap of snapshots) {
    const target = snap.openedList.find(b => b.browername === targetName);
    const found = !!target;
    const isOpen = target?.isopen ?? null;

    if (found !== prevFound || isOpen !== prevIsOpen) {
      console.log(`  [${snap.timestamp}] (+${(snap.elapsedMs / 1000).toFixed(1)}s) found=${found} isopen=${isOpen} browerid="${target?.browerid ?? 'N/A'}"`);
      prevFound = found;
      prevIsOpen = isOpen;
    }
  }
}

main().catch(e => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
