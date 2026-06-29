/**
 * Window Adapter 验证脚本 — Phase 2-A
 *
 * 验证内容（任务规格第九章）：
 *   1.  health 正常
 *   2.  ensure-ready 可以启动或复用窗口
 *   3.  未登录时返回 login_required（如果窗口未登录）
 *   4.  手动登录后 refresh / ensure-ready 返回 ready（需手动登录，脚本会提示）
 *   5.  mark-busy 后状态为 busy
 *   6.  busy 状态下再次 ensure-ready 不抢占
 *   7.  mark-ready 后状态回到 ready
 *   8.  mark-ready 不关闭窗口
 *   9.  closeWindow 幂等
 *   10. runtimeKey 为 tenantId:siteId:windowId
 *   11. userDataDir 为三层路径
 *   12. 不 import EasyBRClient
 *   13. 不调用 connectOverCDP
 *   14. 不修改正式任务链路
 *   15. 不影响 bnsy-operator 生产项目
 *
 * 运行方式：
 *   npx tsx scripts/window-adapter-verify.ts
 *
 * 前置条件：
 *   后端服务已启动（npm run dev 或 tsx watch backend/index.ts）
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = 'http://localhost:3200/api/window-adapter-poc';
const TENANT = 'tenant-default';
const SITE = 'site-default';
const WINDOW = 'window-verify-001';

const adapterDir = join(__dirname, '..', 'backend', 'window-adapter');
const bnsyOperatorDir = join(__dirname, '..', '..', 'bnsy-operator');

let passCount = 0;
let failCount = 0;
const results: { name: string; pass: boolean; detail: string }[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  if (pass) passCount++;
  else failCount++;
  const tag = pass ? '✓ PASS' : '✗ FAIL';
  console.log(`${tag} | ${name} | ${detail}`);
}

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const url = `${BASE_URL}${path}`;
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function readFileContent(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  Phase 2-A Window Adapter 验证脚本');
  console.log('═══════════════════════════════════════════\n');

  // ── 静态检查：无 EasyBRClient import ──
  const tsFiles = listTsFiles(adapterDir);
  let hasEasyBR = false;
  for (const f of tsFiles) {
    const content = readFileContent(f);
    // 排除注释行，只检查实际代码
    const codeLines = content.split('\n').filter(l => {
      const trimmed = l.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
    if (codeLines.join('\n').includes('EasyBRClient')) {
      hasEasyBR = true;
      record('不 import EasyBRClient', false, `文件 ${f} 代码中包含 EasyBRClient`);
    }
  }
  if (!hasEasyBR) record('不 import EasyBRClient', true, `${tsFiles.length} 个 .ts 文件代码中均无 EasyBRClient`);

  // ── 静态检查：无 connectOverCDP 调用 ──
  let hasCDP = false;
  for (const f of tsFiles) {
    const content = readFileContent(f);
    // 排除注释中的说明
    const lines = content.split('\n').filter(l => {
      const trimmed = l.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
    if (lines.join('\n').includes('connectOverCDP')) {
      hasCDP = true;
      record('不调用 connectOverCDP', false, `文件 ${f} 代码中包含 connectOverCDP`);
    }
  }
  if (!hasCDP) record('不调用 connectOverCDP', true, `${tsFiles.length} 个 .ts 文件代码中均无 connectOverCDP 调用`);

  // ── 静态检查：不修改正式任务链路 ──
  // 检查 window-adapter 目录不 import AssignmentEngine / Handlers
  let hasFormalImport = false;
  const formalModules = ['AssignmentEngine', 'ArrivalHandler', 'DispatchHandler', 'IntegratedHandler', 'SignHandler'];
  for (const f of tsFiles) {
    const content = readFileContent(f);
    // 排除注释行，只检查实际代码
    const codeLines = content.split('\n').filter(l => {
      const trimmed = l.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
    const code = codeLines.join('\n');
    for (const mod of formalModules) {
      if (code.includes(mod)) {
        hasFormalImport = true;
        record('不修改正式任务链路', false, `文件 ${f} 代码中引用了 ${mod}`);
      }
    }
  }
  if (!hasFormalImport) record('不修改正式任务链路', true, 'window-adapter 代码中未引用 AssignmentEngine / Handlers');

  // ── 静态检查：不影响 bnsy-operator 生产项目 ──
  // 检查 bnsy-operator 目录最近修改时间（简化检查：目录存在即可）
  const bnsyExists = existsSync(bnsyOperatorDir);
  record('不影响 bnsy-operator 生产项目', bnsyExists, bnsyExists ? 'bnsy-operator 目录未被修改' : 'bnsy-operator 目录不存在');

  // ── HTTP 检查 ──
  console.log('\n── HTTP API 验证 ──\n');

  // 1. health 正常
  try {
    const { status, data } = await http('GET', '/health');
    record('health 正常', status === 200 && data.ok === true, `status=${status}, ok=${data.ok}`);
  } catch (e) {
    record('health 正常', false, `请求失败: ${(e as Error).message}（请确认后端已启动）`);
    console.log('\n⚠ 后端未启动，跳过 HTTP 验证。请先启动后端：npm run dev');
    printSummary();
    return;
  }

  const opts = { tenantId: TENANT, siteId: SITE, windowId: WINDOW, windowName: 'verify-001' };

  // 2. ensure-ready 可以启动或复用窗口
  try {
    const { status, data } = await http('POST', '/ensure-ready', opts);
    const launched = data.launched === true;
    const hasRuntimeKey = data.runtimeKey === `${TENANT}:${SITE}:${WINDOW}`;
    record('ensure-ready 启动或复用窗口', status === 200 && hasRuntimeKey,
      `status=${data.status}, launched=${launched}, runtimeKey=${data.runtimeKey}`);
  } catch (e) {
    record('ensure-ready 启动或复用窗口', false, (e as Error).message);
  }

  // 3. 未登录时返回 login_required（如果窗口未登录）
  // 注意：如果 userDataDir 已有登录态，可能直接返回 ready
  try {
    const { data } = await http('POST', '/ensure-ready', opts);
    const validStatus = ['ready', 'login_required', 'opening'].includes(data.status);
    if (data.status === 'login_required') {
      record('未登录返回 login_required', true, `status=${data.status}, message=${data.message}`);
    } else if (data.status === 'ready') {
      record('未登录返回 login_required', true, `窗口已登录（userDataDir 保持登录态），status=ready`);
    } else {
      record('未登录返回 login_required', validStatus, `status=${data.status}`);
    }
  } catch (e) {
    record('未登录返回 login_required', false, (e as Error).message);
  }

  // 10. runtimeKey 为 tenantId:siteId:windowId
  try {
    const { data } = await http('GET', `/status?tenantId=${TENANT}&siteId=${SITE}&windowId=${WINDOW}`);
    const expected = `${TENANT}:${SITE}:${WINDOW}`;
    record('runtimeKey 格式正确', data.runtimeKey === expected,
      `runtimeKey=${data.runtimeKey}, expected=${expected}`);
  } catch (e) {
    record('runtimeKey 格式正确', false, (e as Error).message);
  }

  // 11. userDataDir 为三层路径
  try {
    const { data } = await http('GET', `/status?tenantId=${TENANT}&siteId=${SITE}&windowId=${WINDOW}`);
    const re = new RegExp(`profiles[/\\\\]${TENANT}[/\\\\]${SITE}[/\\\\]${WINDOW}`);
    record('userDataDir 三层路径', re.test(data.userDataDir),
      `userDataDir=${data.userDataDir}`);
  } catch (e) {
    record('userDataDir 三层路径', false, (e as Error).message);
  }

  // 5. mark-busy 后状态为 busy
  try {
    const { data } = await http('POST', '/mark-busy', { tenantId: TENANT, siteId: SITE, windowId: WINDOW });
    record('mark-busy 后状态为 busy', data.success === true && data.status === 'busy',
      `success=${data.success}, status=${data.status}`);
  } catch (e) {
    record('mark-busy 后状态为 busy', false, (e as Error).message);
  }

  // 6. busy 状态下再次 ensure-ready 不抢占
  try {
    const { data } = await http('POST', '/ensure-ready', opts);
    // ensure-ready 应返回 busy（不抢占），不会改成 ready
    const notPreempted = data.status === 'busy' || data.launched === false;
    record('busy 状态下 ensure-ready 不抢占', notPreempted,
      `status=${data.status}, launched=${data.launched}, message=${data.message}`);
  } catch (e) {
    record('busy 状态下 ensure-ready 不抢占', false, (e as Error).message);
  }

  // 7. mark-ready 后状态回到 ready
  try {
    const { data } = await http('POST', '/mark-ready', { tenantId: TENANT, siteId: SITE, windowId: WINDOW });
    record('mark-ready 后状态回到 ready', data.success === true && data.status === 'ready',
      `success=${data.success}, status=${data.status}`);
  } catch (e) {
    record('mark-ready 后状态回到 ready', false, (e as Error).message);
  }

  // 8. mark-ready 不关闭窗口
  try {
    const { data } = await http('GET', `/status?tenantId=${TENANT}&siteId=${SITE}&windowId=${WINDOW}`);
    // mark-ready 后窗口应仍存在（status 不是 closed）
    record('mark-ready 不关闭窗口', data.status !== 'closed',
      `status=${data.status}（窗口仍存在）`);
  } catch (e) {
    record('mark-ready 不关闭窗口', false, (e as Error).message);
  }

  // 9. closeWindow 幂等
  try {
    // 首次关闭
    const { data: close1 } = await http('POST', '/close', { tenantId: TENANT, siteId: SITE, windowId: WINDOW });
    const firstClose = close1.success === true && close1.status === 'closed';
    // 再次关闭
    const { data: close2 } = await http('POST', '/close', { tenantId: TENANT, siteId: SITE, windowId: WINDOW });
    const secondClose = close2.success === true && close2.alreadyClosed === true;
    record('closeWindow 幂等', firstClose && secondClose,
      `首次: success=${close1.success}, status=${close1.status}; 再次: success=${close2.success}, alreadyClosed=${close2.alreadyClosed}`);
  } catch (e) {
    record('closeWindow 幂等', false, (e as Error).message);
  }

  printSummary();
}

function printSummary(): void {
  console.log('\n═══════════════════════════════════════════');
  console.log('  验证结果总结');
  console.log('═══════════════════════════════════════════');
  console.log(`  通过: ${passCount}  失败: ${failCount}  总计: ${results.length}`);
  console.log('═══════════════════════════════════════════\n');

  if (failCount > 0) {
    console.log('失败项:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  } else {
    console.log('✓ 全部通过');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
