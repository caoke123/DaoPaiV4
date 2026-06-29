/**
 * Problem C 对照测试 — 手动关闭模式
 *
 * 用法：
 *   npx tsx scripts/problem-c-manual.ts <browername> [duration_seconds]
 *   例：npx tsx scripts/problem-c-manual.ts "天南大-肖飞" 120
 *
 * 流程：
 *   1. 采集基线快照
 *   2. 等待用户手动关闭窗口（提示后开始轮询）
 *   3. 每 2 秒轮询 getBrowerList + openedList
 *   4. 检测窗口从 openedList 消失 → 检测窗口重新出现
 *   5. 所有数据落盘
 */

import axios from 'axios';

const EASYBR_BASE = 'http://127.0.0.1:3001';
const POLL_INTERVAL_MS = 2000;

interface BrowerConfig { browerid: string; browername: string; }
interface OpenedWindow { browerid: string; browername: string; isopen: boolean; }
interface Snapshot {
  timestamp: string;
  elapsedMs: number;
  getBrowerList: BrowerConfig[];
  openedList: OpenedWindow[];
  error?: string;
}

async function getBrowerList(): Promise<BrowerConfig[]> {
  const resp = await axios.get(`${EASYBR_BASE}/auto/getBrowerList`, {
    params: { page: 1, limit: 100 }, timeout: 8000,
  });
  if (resp.data.code !== 0) throw new Error(`getBrowerList code=${resp.data.code}`);
  return resp.data.data as BrowerConfig[];
}

async function openedList(): Promise<OpenedWindow[]> {
  const resp = await axios.get(`${EASYBR_BASE}/auto/openedList`, { timeout: 8000 });
  if (resp.data.code !== 0) throw new Error(`openedList code=${resp.data.code}`);
  return resp.data.data as OpenedWindow[];
}

async function takeSnapshot(elapsedMs: number): Promise<Snapshot> {
  const timestamp = new Date().toISOString();
  try {
    const [browerList, opened] = await Promise.all([getBrowerList(), openedList()]);
    return { timestamp, elapsedMs, getBrowerList: browerList, openedList: opened };
  } catch (e) {
    return { timestamp, elapsedMs, getBrowerList: [], openedList: [],
      error: e instanceof Error ? e.message : String(e) };
  }
}

function formatTarget(snap: Snapshot, targetName: string): string {
  if (snap.error) return `[${snap.timestamp}] (+${(snap.elapsedMs/1000).toFixed(1)}s) ERROR: ${snap.error}`;

  const inList = snap.getBrowerList.find(b => b.browername === targetName);
  const inOpened = snap.openedList.find(b => b.browername === targetName);
  const openCount = snap.openedList.filter(w => w.isopen).length;

  let line = `[${snap.timestamp}] (+${(snap.elapsedMs/1000).toFixed(1)}s)`;
  line += ` | getBrowerList: ${inList ? `id="${inList.browerid}"` : '❌未找到'}`;
  line += ` | openedList: ${inOpened ? `id="${inOpened.browerid}" isopen=${inOpened.isopen}` : '❌未找到'}`;
  line += ` | openedList总计: ${snap.openedList.length}条 (${openCount}个isopen=true)`;
  return line;
}

async function main() {
  const targetName = process.argv[2] || '天南大-肖飞';
  const durationS = parseInt(process.argv[3] || '120', 10);

  console.log('═══════════════════════════════════════════');
  console.log('  Problem C 对照测试 — 手动关闭模式');
  console.log('═══════════════════════════════════════════');
  console.log(`  目标窗口: ${targetName}`);
  console.log(`  采集时长: ${durationS}s`);
  console.log('');

  // 基线快照
  console.log('━━━ 基线快照 ━━━');
  const baseline = await takeSnapshot(0);
  console.log(formatTarget(baseline, targetName));
  const targetInList = baseline.getBrowerList.find(b => b.browername === targetName);
  if (!targetInList) {
    console.error(`❌ getBrowerList 中未找到 "${targetName}"`);
    process.exit(1);
  }
  const targetBrowerId = targetInList.browerid;
  console.log(`  → 基线 browerid: ${targetBrowerId}`);
  console.log('');

  // 等待用户手动关闭
  console.log('━━━ 请现在手动关闭浏览器窗口 ━━━');
  console.log(`  目标: ${targetName} (browerid: ${targetBrowerId})`);
  console.log('  脚本将每 2 秒自动采集一次数据...');
  console.log('');

  const snapshots: Snapshot[] = [baseline];
  const startTime = Date.now();
  let windowDisappeared = false;
  let windowReappeared = false;
  let reappearTime: number | null = null;

  while (Date.now() - startTime < durationS * 1000) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const elapsed = Date.now() - startTime;
    const snap = await takeSnapshot(elapsed);
    snapshots.push(snap);
    console.log(formatTarget(snap, targetName));

    const target = snap.openedList.find(b => b.browername === targetName);
    if (!target && !windowDisappeared) {
      windowDisappeared = true;
      console.log(`  ★ 窗口从 openedList 消失! (+${(elapsed/1000).toFixed(1)}s)`);
    }
    if (target && windowDisappeared && !windowReappeared) {
      windowReappeared = true;
      reappearTime = elapsed;
      console.log(`  ★★★ 窗口重新出现在 openedList! (+${(elapsed/1000).toFixed(1)}s) isopen=${target.isopen} browerid="${target.browerid}"`);
      console.log(`  ★★★ browerid 是否一致: ${target.browerid === targetBrowerId ? '✓ 一致' : '❌ 不一致! 旧=' + targetBrowerId + ' 新=' + target.browerid}`);
    }

    // 窗口恢复后继续采集 15 秒
    if (windowReappeared && reappearTime && elapsed - reappearTime > 15000) {
      console.log('  → 窗口已恢复 15 秒，停止采集');
      break;
    }
  }

  // 保存数据
  const outputFile = `scripts/problem-c-manual-result-${Date.now()}.json`;
  const fs = await import('fs');
  fs.writeFileSync(outputFile, JSON.stringify(snapshots, null, 2), 'utf-8');

  console.log('');
  console.log('━━━ 完成 ━━━');
  console.log(`  采集 ${snapshots.length} 个快照`);
  console.log(`  数据保存到: ${outputFile}`);
  console.log(`  窗口消失: ${windowDisappeared ? '是' : '否'}`);
  console.log(`  窗口恢复: ${windowReappeared ? `是 (+${(reappearTime!/1000).toFixed(1)}s)` : '否'}`);

  // 对比摘要
  console.log('');
  console.log('━━━ 对比摘要 ━━━');
  console.log(`  基线 browerid: ${targetBrowerId}`);
  const finalSnap = snapshots[snapshots.length - 1];
  const finalInList = finalSnap.getBrowerList.find(b => b.browername === targetName);
  const finalInOpened = finalSnap.openedList.find(b => b.browername === targetName);
  if (finalInList) {
    console.log(`  最终 getBrowerList browerid: ${finalInList.browerid} ${finalInList.browerid === targetBrowerId ? '✓一致' : '❌不一致'}`);
  }
  if (finalInOpened) {
    console.log(`  最终 openedList browerid: ${finalInOpened.browerid} ${finalInOpened.browerid === targetBrowerId ? '✓一致' : '❌不一致'}`);
    console.log(`  最终 isopen: ${finalInOpened.isopen}`);
  }

  // isopen 变化时间线
  console.log('');
  console.log('━━━ openedList 变化时间线 ━━━');
  let prevFound: boolean | null = null;
  let prevIsOpen: boolean | null = null;
  for (const snap of snapshots) {
    const target = snap.openedList.find(b => b.browername === targetName);
    const found = !!target;
    const isOpen = target?.isopen ?? null;
    if (found !== prevFound || isOpen !== prevIsOpen) {
      console.log(`  [${snap.timestamp}] (+${(snap.elapsedMs/1000).toFixed(1)}s) found=${found} isopen=${isOpen} browerid="${target?.browerid ?? 'N/A'}"`);
      prevFound = found;
      prevIsOpen = isOpen;
    }
  }
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
