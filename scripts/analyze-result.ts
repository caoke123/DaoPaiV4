import fs from 'fs';

const data = JSON.parse(fs.readFileSync('scripts/problem-c-manual-result-1782214994487.json', 'utf-8')) as any[];
const target = '天南大-肖飞';

const baseline = data[0];
const baseTarget = baseline.getBrowerList.find((b: any) => b.browername === target);
console.log('快照数:', data.length);
console.log('基线 browerid:', baseTarget?.browerid);
console.log('');

console.log('━━━ openedList 变化时间线 ━━━');
let prevFound: boolean | null = null;
let prevOpen: boolean | null = null;
for (const s of data) {
  const t = s.openedList.find((b: any) => b.browername === target);
  const found = !!t;
  const open = t?.isopen ?? null;
  if (found !== prevFound || open !== prevOpen) {
    const idMatch = t && baseTarget && t.browerid !== baseTarget.browerid ? ' ❌ID变化!' : '';
    console.log(`+${(s.elapsedMs / 1000).toFixed(1)}s found=${found} isopen=${open} browerid="${t?.browerid ?? 'N/A'}"${idMatch}`);
    prevFound = found;
    prevOpen = open;
  }
}

console.log('');
console.log('━━━ getBrowerList 变化时间线 ━━━');
let prevId: string | null = null;
for (const s of data) {
  const t = s.getBrowerList.find((b: any) => b.browername === target);
  const id = t?.browerid ?? null;
  if (id !== prevId) {
    const match = id && baseTarget && id !== baseTarget.browerid ? ' ❌ID变化!' : ' ✓';
    console.log(`+${(s.elapsedMs / 1000).toFixed(1)}s browerid="${id ?? 'N/A'}"${match}`);
    prevId = id;
  }
}

console.log('');
console.log('━━━ 最终状态 ━━━');
const final = data[data.length - 1];
const finalInList = final.getBrowerList.find((b: any) => b.browername === target);
const finalInOpened = final.openedList.find((b: any) => b.browername === target);
console.log('getBrowerList:', finalInList ? `browerid="${finalInList.browerid}" ${finalInList.browerid === baseTarget.browerid ? '✓一致' : '❌不一致'}` : '❌未找到');
console.log('openedList:', finalInOpened ? `browerid="${finalInOpened.browerid}" isopen=${finalInOpened.isopen} ${finalInOpened.browerid === baseTarget.browerid ? '✓一致' : '❌不一致'}` : '❌未找到');
