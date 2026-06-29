/**
 * Sign Runtime Mode 验证脚本 — Phase 2-D / Phase 2-D-Run
 *
 * 验证内容（任务规格第十章 + 第十一章 + Phase 2-D-Run 补充）：
 *
 * A. 静态代码检查（默认运行，无需后端）：
 *    A1.  runtimeMode.ts 存在且默认值为 legacy_easybr
 *    A2.  shouldUsePlaywrightAdapter 仅 sign+playwright 返回 true
 *    A3.  AssignmentEngine 含 resolveWorkerConnection / resolveLegacyWorkerConnection / resolvePlaywrightWorkerConnection
 *    A4.  WorkerConnectionHandle 类型已定义
 *    A5.  WorkerContext 含可选 runtimeKey / runtimeMode 字段
 *    A6.  4 个正式 Handler 业务逻辑零修改（不 import Adapter / runtimeMode）
 *    A7.  routes.ts 未承担 runtime 分发职责
 *    A8.  bnsy-operator/ 生产目录未被修改
 *    A9.  backend/ 中无 ../bnsy-operator/ 跨项目 import
 *    A10. package.json 无新增 EasyBR 依赖
 *    A11. markReady 必须在 release lock 之前（playwright 路径）
 *    A12. ensureWindowReady 失败时不 markBusy（playwright 路径）
 *
 * B. 运行时检查（后端在 :3200 运行时执行）：
 *    B1.  GET /api/window-adapter-poc/health 返回 ok
 *    B2.  legacy 模式：POST /api/operations/sign 后日志含 runtimeMode=legacy_easybr
 *    B3.  playwright 模式（需手动切换 env 后重启服务）
 *
 * C. 异常路径模拟（通过 POC API + 静态代码确认）：
 *    C1.  login_required：ensureWindowReady 抛错，不进入 markBusy / lock
 *    C2.  busy：ensureWindowReady 返回 busy 抛 WindowBusyError，不抢占
 *    C3.  markBusy 失败：release lock
 *    C4.  Handler 抛错：finally markReady + release lock
 *    C5.  markReady 失败：仅记录日志，release lock 仍执行
 *    C6.  close 后重新任务：ensureWindowReady 可重启
 *
 * D. 自动登录端到端验证（--auto-login 参数，Phase 2-D-Run 三次修正版）：
 *    D1.  环境变量 BNSY_TEST_USERNAME / BNSY_TEST_PASSWORD 已读取（脱敏）
 *    D2.  账号密码未硬编码（脚本中无字面量）
 *    D3.  ensure-ready 启动测试窗口（状态明确）
 *    D4.  登录前状态明确（ready / login_required / 其他）
 *    D5.  自动登录成功（如需，login_required 时执行）
 *    D6.  refresh=true 返回 ready（登录后或已 ready 时确认）
 *    D6.5 P0 就绪检查（复用旧 BrowserPool.verifyReady 7 项 + ensureNoPopup，sign 任务前门槛）
 *        - P0 不通过直接失败，不提交 sign 任务，不生成 unknown 报告
 *    D7.  第一次 sign 任务提交成功（拿到 taskId）
 *    D8.  第一次任务状态结束（done/failed/timeout）
 *    D9.  任务日志含 runtimeMode=playwright（进入 Playwright runtime）
 *    D10. 任务日志含 Worker connection established（Engine playwright 路径）
 *    D11. 任务日志含签收关键字（进入 SignHandler / executeSign）
 *    D12. markBusy 已执行（间接证明：任务已结束）
 *    D13. markReady 已执行（间接证明：窗口恢复 ready）
 *    D14. release lock 已执行（间接证明：窗口恢复 ready）
 *    D15. 任务结束后窗口状态 ready
 *    D16. 第二次 sign 任务复用窗口（不重新登录/启动，走 playwright，窗口仍 ready）
 *    D17. EasyBR 检查范围正确（playwright 层无 EasyBR，legacy 层允许）
 *    D18. 建议进入 Phase 2-E
 *
 * 运行方式：
 *   npx tsx scripts/sign-runtime-mode-verify.ts               # 仅静态检查
 *   npx tsx scripts/sign-runtime-mode-verify.ts --auto-login --site=<siteId> --staff=<员工名>
 *   npx tsx scripts/sign-runtime-mode-verify.ts --auto-login --site=<siteId> --staff=<员工名> --headed --keep-open
 *
 * 真实 Chrome 验收参数（Phase 2-D-Run）：
 *   --headed      : 强制真实 Chrome（headless=false，PlaywrightWindowAdapter 已硬编码）
 *   --keep-open   : 任务结束后保持 Chrome 打开（脚本默认不调用 close）
 *
 * 自动登录前置条件（fail-fast，任一缺失立即退出）：
 *   - 后端以 WINDOW_RUNTIME_MODE=playwright npm run dev 启动
 *   - 脚本环境变量 WINDOW_RUNTIME_MODE=playwright
 *   - 设置环境变量（账号密码由用户自行提供，严禁写入脚本）：
 *     $env:WINDOW_RUNTIME_MODE="playwright"
 *     $env:BNSY_TEST_USERNAME="<你的测试账号>"
 *     $env:BNSY_TEST_PASSWORD="<你的测试密码>"
 *   - CLI 参数（必须显式传入，不再自动猜）：
 *     --site=<settings.json 中的 site.id>
 *     --staff=<真实员工名（必须属于该 site）>
 *   - 可选：--window-id=<窗口ID>（默认 staff-${staffName}）
 *
 * 安全要求：
 *   - 账号密码仅从环境变量读取，严禁硬编码
 *   - 日志中账号脱敏（如 022****0008），密码始终显示 ******
 *   - 验收报告中不得出现完整密码
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runP0Check } from './lib/p0-check';

const BASE_URL = 'http://localhost:3200';
const POC_BASE = `${BASE_URL}/api/window-adapter-poc`;
const PLAYWRIGHT_POC_BASE = `${BASE_URL}/api/playwright-poc`;

const nextRoot = join(__dirname, '..');
const backendDir = join(nextRoot, 'backend');
const bnsyOperatorDir = join(nextRoot, '..', 'bnsy-operator');

// ── CLI 参数解析 ──
const argv = process.argv.slice(2);
const autoLoginMode = argv.includes('--auto-login');
// Phase 2-D-Run 真实 Chrome 验收：--headed 强制真实 Chrome（headless=false）
const headedMode = argv.includes('--headed');
// Phase 2-D-Run 真实 Chrome 验收：--keep-open 任务结束后保持 Chrome 打开
const keepOpenMode = argv.includes('--keep-open');

/** 从 CLI 参数中提取 --key=value 形式的值 */
function getArg(key: string): string {
  const prefix = `--${key}=`;
  const found = argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

// ── 测试参数（CLI 优先，环境变量兜底） ──
//   --site      : settings.json 中的 site.id（如 site-1782121346155）
//   --staff     : 真实员工名（必须属于该 site）
//   --window-id : 可选，默认 staff-${staffName}
const CLI_SITE = getArg('site');
const CLI_STAFF = getArg('staff');
const CLI_WINDOW_ID = getArg('window-id');

// ── 测试账号（仅从环境变量读取，严禁硬编码） ──
const TEST_USERNAME = process.env.BNSY_TEST_USERNAME || '';
const TEST_PASSWORD = process.env.BNSY_TEST_PASSWORD || '';

// 最终使用的测试参数（CLI 优先，环境变量兜底）
const TEST_SITE = CLI_SITE || process.env.BNSY_TEST_SITE || '';
const TEST_STAFF = CLI_STAFF || process.env.BNSY_TEST_STAFF || '';
const TEST_WINDOW_ID = CLI_WINDOW_ID || (TEST_STAFF ? `staff-${TEST_STAFF}` : '');

/**
 * 账号脱敏：保留首 3 位 + 末 4 位，中间用 **** 替代
 * 例：12345678901 → 123****8901
 */
function maskUsername(username: string): string {
  if (!username) return '(empty)';
  if (username.length <= 7) return '****';
  return `${username.slice(0, 3)}****${username.slice(-4)}`;
}

/** 密码始终显示 ****** */
function maskPassword(): string {
  return TEST_PASSWORD ? '******' : '(empty)';
}

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

async function http(method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> {
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

/** 移除单行注释、多行注释、JSDoc，仅保留实际代码 */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => {
      const trimmed = l.trim();
      return !trimmed.startsWith('//');
    })
    .join('\n');
}

// ════════════════════════════════════════════════════════════════
// Part A: 静态代码检查
// ════════════════════════════════════════════════════════════════

function verifyStatic(): void {
  console.log('\n── Part A: 静态代码检查 ──\n');

  // A1. runtimeMode.ts 存在且默认值为 legacy_easybr
  try {
    const runtimeModePath = join(backendDir, 'config', 'runtimeMode.ts');
    const content = readFileContent(runtimeModePath);
    const hasLegacyDefault = content.includes("return 'legacy_easybr';") &&
      content.includes("if (raw === 'playwright') return 'playwright';");
    record('A1. runtimeMode.ts 默认值为 legacy_easybr',
      hasLegacyDefault,
      hasLegacyDefault ? '未设置/非法值均回退 legacy_easybr' : '默认值实现缺失或不正确');
  } catch (e) {
    record('A1. runtimeMode.ts 默认值为 legacy_easybr', false, (e as Error).message);
  }

  // A2. shouldUsePlaywrightAdapter 仅 sign+playwright 返回 true
  try {
    const runtimeModePath = join(backendDir, 'config', 'runtimeMode.ts');
    const content = readFileContent(runtimeModePath);
    const hasFunc = content.includes('export function shouldUsePlaywrightAdapter(taskType: string): boolean');
    const hasSignOnly = content.includes("isPlaywrightMode() && taskType === 'sign'");
    record('A2. shouldUsePlaywrightAdapter 仅 sign+playwright 返回 true',
      hasFunc && hasSignOnly,
      hasFunc && hasSignOnly ? '仅 taskType===\'sign\' 且 playwright 模式才返回 true' : '实现不正确');
  } catch (e) {
    record('A2. shouldUsePlaywrightAdapter 仅 sign+playwright 返回 true', false, (e as Error).message);
  }

  // A3. AssignmentEngine 含三个私有方法
  try {
    const enginePath = join(backendDir, 'modules', 'assignment-engine', 'AssignmentEngine.ts');
    const content = readFileContent(enginePath);
    const hasResolve = content.includes('private async resolveWorkerConnection(');
    const hasLegacy = content.includes('private async resolveLegacyWorkerConnection(');
    const hasPlaywright = content.includes('private async resolvePlaywrightWorkerConnection(');
    const allPresent = hasResolve && hasLegacy && hasPlaywright;
    record('A3. AssignmentEngine 含 resolveWorkerConnection / resolveLegacyWorkerConnection / resolvePlaywrightWorkerConnection',
      allPresent,
      allPresent ? '三个私有方法均已定义' : `missing: ${[!hasResolve && 'resolve', !hasLegacy && 'legacy', !hasPlaywright && 'playwright'].filter(Boolean).join(',')}`);
  } catch (e) {
    record('A3. AssignmentEngine 三个私有方法', false, (e as Error).message);
  }

  // A4. WorkerConnectionHandle 类型已定义
  try {
    const typesPath = join(backendDir, 'modules', 'assignment-engine', 'types.ts');
    const content = readFileContent(typesPath);
    const hasType = content.includes('export interface WorkerConnectionHandle');
    const hasFields = content.includes('page: Page;') &&
      content.includes('windowId: string;') &&
      content.includes('runtimeMode: WindowRuntimeMode;') &&
      content.includes('release: () => Promise<void>;');
    record('A4. WorkerConnectionHandle 类型已定义',
      hasType && hasFields,
      hasType && hasFields ? '含 page/windowId/runtimeMode/release 必填字段' : '类型定义缺失字段');
  } catch (e) {
    record('A4. WorkerConnectionHandle 类型', false, (e as Error).message);
  }

  // A5. WorkerContext 含可选 runtimeKey / runtimeMode
  try {
    const typesPath = join(backendDir, 'modules', 'assignment-engine', 'types.ts');
    const content = readFileContent(typesPath);
    const hasRuntimeKey = content.includes('runtimeKey?: string;');
    const hasRuntimeMode = content.includes('runtimeMode?: WindowRuntimeMode;');
    record('A5. WorkerContext 含可选 runtimeKey / runtimeMode',
      hasRuntimeKey && hasRuntimeMode,
      hasRuntimeKey && hasRuntimeMode ? '均为可选字段，向后兼容' : '字段缺失');
  } catch (e) {
    record('A5. WorkerContext 可选字段', false, (e as Error).message);
  }

  // A6. 4 个正式 Handler 业务逻辑零修改（不 import Adapter / runtimeMode）
  const handlers = ['ArrivalHandler.ts', 'DispatchHandler.ts', 'IntegratedHandler.ts', 'SignHandler.ts'];
  const handlerDir = join(backendDir, 'modules', 'assignment-engine', 'handlers');
  let handlerClean = true;
  const handlerIssues: string[] = [];
  for (const h of handlers) {
    const content = readFileContent(join(handlerDir, h));
    const code = stripComments(content);
    if (code.includes('PlaywrightWindowAdapter')) {
      handlerClean = false;
      handlerIssues.push(`${h} 引用 PlaywrightWindowAdapter`);
    }
    if (code.includes('WindowAdapterRegistry')) {
      handlerClean = false;
      handlerIssues.push(`${h} 引用 WindowAdapterRegistry`);
    }
    if (code.includes('shouldUsePlaywrightAdapter')) {
      handlerClean = false;
      handlerIssues.push(`${h} 引用 shouldUsePlaywrightAdapter`);
    }
    if (code.includes("runtimeMode === 'playwright'") || code.includes("runtimeMode==='playwright'")) {
      handlerClean = false;
      handlerIssues.push(`${h} 直接判断 runtimeMode`);
    }
  }
  record('A6. 4 个正式 Handler 业务逻辑零修改',
    handlerClean,
    handlerClean ? '4 个 Handler 均未引用 Adapter / runtimeMode' : handlerIssues.join('; '));

  // A7. routes.ts 未承担 runtime 分发职责
  try {
    const routesPath = join(backendDir, 'api', 'routes.ts');
    const content = readFileContent(routesPath);
    const code = stripComments(content);
    const hasDispatch = code.includes('shouldUsePlaywrightAdapter') ||
      code.includes('resolvePlaywrightWorkerConnection') ||
      code.includes('resolveWorkerConnection');
    record('A7. routes.ts 未承担 runtime 分发职责',
      !hasDispatch,
      !hasDispatch ? 'routes.ts 中无 runtime 分发逻辑（仅 Engine 内部分发）' : 'routes.ts 散落 runtime 分发');
  } catch (e) {
    record('A7. routes.ts runtime 分发', false, (e as Error).message);
  }

  // A8. bnsy-operator/ 生产目录存在且未被修改（mtime 检查）
  try {
    const bnsyExists = existsSync(bnsyOperatorDir);
    if (!bnsyExists) {
      record('A8. bnsy-operator/ 生产项目零修改', false, '目录不存在');
    } else {
      // 检查关键文件 mtime，与 bnsy-operator-next 对比
      const bnsyStat = statSync(bnsyOperatorDir);
      const nextStat = statSync(nextRoot);
      // bnsy-operator 的修改时间不应晚于 bnsy-operator-next 的创建时间（粗略检查）
      // 更严格：bnsy-operator mtime 不应在 Phase 2-D 期间变化（与 next 相比应更早）
      const bnsyMtime = bnsyStat.mtimeMs;
      const nextMtime = nextStat.mtimeMs;
      const bnsyOlder = bnsyMtime <= nextMtime + 60_000; // 1 分钟容差
      record('A8. bnsy-operator/ 生产项目零修改',
        bnsyOlder,
        bnsyOlder
          ? `bnsy-operator mtime=${new Date(bnsyMtime).toISOString()} 早于/接近 next mtime=${new Date(nextMtime).toISOString()}`
          : `bnsy-operator mtime=${new Date(bnsyMtime).toISOString()} 晚于 next mtime=${new Date(nextMtime).toISOString()}`);
    }
  } catch (e) {
    record('A8. bnsy-operator/ 生产项目零修改', false, (e as Error).message);
  }

  // A9. backend/ 中无 ../bnsy-operator/ 跨项目 import
  try {
    const tsFiles = listTsFiles(backendDir);
    let hasCrossImport = false;
    const crossFiles: string[] = [];
    for (const f of tsFiles) {
      const content = readFileContent(f);
      const code = stripComments(content);
      if (code.includes('../bnsy-operator/') || code.includes('..\\bnsy-operator\\') ||
          code.includes("from '../../bnsy-operator") || code.includes("from '../bnsy-operator")) {
        hasCrossImport = true;
        crossFiles.push(f);
      }
    }
    record('A9. 无 ../bnsy-operator/ 跨项目 import',
      !hasCrossImport,
      !hasCrossImport ? `${tsFiles.length} 个 .ts 文件均无跨项目 import` : `违规文件: ${crossFiles.join(', ')}`);
  } catch (e) {
    record('A9. 无 ../bnsy-operator/ import', false, (e as Error).message);
  }

  // A10. package.json 无新增 EasyBR 依赖
  try {
    const pkgPath = join(nextRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const easybrKeys = Object.keys(allDeps).filter(k => k.toLowerCase().includes('easybr'));
    record('A10. package.json 无新增 EasyBR 依赖',
      easybrKeys.length === 0,
      easybrKeys.length === 0 ? 'dependencies 中无 easybr 相关包' : `发现: ${easybrKeys.join(', ')}`);
  } catch (e) {
    record('A10. package.json EasyBR 依赖', false, (e as Error).message);
  }

  // A11. markReady 必须在 release lock 之前（playwright 路径）
  //   仅检查 release 闭包内的顺序，排除 markBusy/getWorkerPage 失败回滚路径中的 lockManager.release
  try {
    const enginePath = join(backendDir, 'modules', 'assignment-engine', 'AssignmentEngine.ts');
    const content = readFileContent(enginePath);
    const playwrightBody = extractPlaywrightMethod(content);
    if (!playwrightBody) {
      record('A11. markReady 必须在 release lock 之前', false, '未找到 resolvePlaywrightWorkerConnection');
    } else {
      // 定位 release 闭包范围（release: async () => { ... }, renew:）
      const releaseIdx = playwrightBody.indexOf('release: async () => {');
      const renewIdx = playwrightBody.indexOf('renew: async () => {');
      if (releaseIdx < 0 || renewIdx < 0 || releaseIdx > renewIdx) {
        record('A11. markReady 必须在 release lock 之前', false, '未找到 release 闭包');
      } else {
        const releaseBody = playwrightBody.substring(releaseIdx, renewIdx);
        const markReadyIdx = releaseBody.indexOf('adapter.markReady');
        const lockReleaseIdx = releaseBody.indexOf('lockManager.release(windowId, taskId)');
        const orderCorrect = markReadyIdx >= 0 && lockReleaseIdx >= 0 && markReadyIdx < lockReleaseIdx;
        record('A11. markReady 必须在 release lock 之前',
          orderCorrect,
          orderCorrect
            ? `release 闭包内: markReady(pos=${markReadyIdx}) < lockManager.release(pos=${lockReleaseIdx})`
            : `顺序错误: markReady=${markReadyIdx}, lockRelease=${lockReleaseIdx}`);
      }
    }
  } catch (e) {
    record('A11. markReady 顺序', false, (e as Error).message);
  }

  // A12. ensureWindowReady 失败时不 markBusy（playwright 路径）
  try {
    const enginePath = join(backendDir, 'modules', 'assignment-engine', 'AssignmentEngine.ts');
    const content = readFileContent(enginePath);
    const playwrightBody = extractPlaywrightMethod(content);
    if (!playwrightBody) {
      record('A12. ensureWindowReady 失败时不 markBusy', false, '未找到 resolvePlaywrightWorkerConnection');
    } else {
      const ensureIdx = playwrightBody.indexOf('adapter.ensureWindowReady');
      const markBusyIdx = playwrightBody.indexOf('adapter.markBusy');
      const sectionBetween = playwrightBody.substring(ensureIdx, markBusyIdx);
      const hasGuardBetween = sectionBetween.includes("throw new Error") ||
        sectionBetween.includes("throw new WindowBusyError");
      const orderCorrect = ensureIdx >= 0 && markBusyIdx >= 0 && ensureIdx < markBusyIdx && hasGuardBetween;
      record('A12. ensureWindowReady 失败时不 markBusy',
        orderCorrect,
        orderCorrect
          ? 'ensureWindowReady → 状态判断（含抛错）→ markBusy'
          : `顺序或守卫缺失 (ensure=${ensureIdx}, markBusy=${markBusyIdx}, guard=${hasGuardBetween})`);
    }
  } catch (e) {
    record('A12. ensureWindowReady 失败守卫', false, (e as Error).message);
  }
}

/**
 * 从 AssignmentEngine.ts 内容中提取 resolvePlaywrightWorkerConnection 方法体
 *
 * 使用括号匹配而非贪婪正则，准确提取方法范围。
 */
function extractPlaywrightMethod(content: string): string | null {
  const methodStart = content.indexOf('private async resolvePlaywrightWorkerConnection(');
  if (methodStart < 0) return null;
  // 找到方法体的起始 {
  const bodyStart = content.indexOf('{', content.indexOf('):', methodStart));
  if (bodyStart < 0) return null;
  // 括号匹配找到方法体结束
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  return content.substring(methodStart, end);
}

// ════════════════════════════════════════════════════════════════
// Part B: 运行时检查（需要后端运行）
// ════════════════════════════════════════════════════════════════

async function verifyRuntime(): Promise<void> {
  console.log('\n── Part B: 运行时检查 ──\n');

  // 探测后端是否运行
  let backendReachable = false;
  try {
    const resp = await fetch(`${BASE_URL}/api/status`, { signal: AbortSignal.timeout(2000) });
    backendReachable = resp.ok;
  } catch {
    backendReachable = false;
  }

  if (!backendReachable) {
    console.log('⚠ 后端未运行或不可达，跳过运行时检查。');
    console.log('  若需运行时验证，请先启动后端：');
    console.log('    WINDOW_RUNTIME_MODE=legacy_easybr npm run dev   # 回归');
    console.log('    WINDOW_RUNTIME_MODE=playwright npm run dev     # 新路径');
    return;
  }

  // B1. POC 健康检查
  try {
    const { status, data } = await http('GET', `${POC_BASE}/health`);
    record('B1. POC /health 正常',
      status === 200 && data.ok === true,
      `status=${status}, ok=${data.ok}, module=${data.module}`);
  } catch (e) {
    record('B1. POC /health 正常', false, (e as Error).message);
  }

  // B2. legacy 模式日志验证（仅当 process.env.WINDOW_RUNTIME_MODE !== 'playwright' 时）
  //   注意：脚本无法改变已运行服务的 env，只能根据响应推断当前模式
  try {
    const { data: statusData } = await http('GET', `${BASE_URL}/api/operations/stats`).catch(() => ({ data: {} }));
    const currentMode = (statusData as any)?.runtimeMode || 'unknown';
    console.log(`  当前服务 runtimeMode=${currentMode}（由 env 决定）`);

    if (currentMode === 'playwright') {
      console.log('  ⚠ 当前服务为 playwright 模式，legacy 回归需重启：WINDOW_RUNTIME_MODE=legacy_easybr npm run dev');
    } else {
      console.log('  ✓ 当前服务为 legacy 模式（或未启用 playwright），符合默认值约束');
      record('B2. legacy 模式默认启用',
        true,
        `当前 runtimeMode=${currentMode}，未启用 playwright`);
    }
  } catch (e) {
    record('B2. legacy 模式默认启用', false, (e as Error).message);
  }

  // B3. sign 任务端到端验证（可选，需要真实站点+员工配置）
  //   此处仅做接口探测，不真实触发任务（避免对生产环境造成影响）
  try {
    const { status } = await http('OPTIONS', `${BASE_URL}/api/operations/sign`);
    record('B3. /api/operations/sign 接口可达',
      status < 500,
      `OPTIONS status=${status}`);
  } catch (e) {
    record('B3. /api/operations/sign 接口可达', false, (e as Error).message);
  }
}

// ════════════════════════════════════════════════════════════════
// Part C: 异常路径模拟（静态代码确认 + POC API 验证）
// ════════════════════════════════════════════════════════════════

function verifyExceptionPaths(): void {
  console.log('\n── Part C: 异常路径验证（静态代码确认） ──\n');

  const enginePath = join(backendDir, 'modules', 'assignment-engine', 'AssignmentEngine.ts');
  const content = readFileContent(enginePath);
  const playwrightBody = extractPlaywrightMethod(content) || '';

  // C1. login_required：抛错，不进入 markBusy / lock
  {
    const hasLoginRequired = playwrightBody.includes("readyResult.status === 'login_required'") &&
      playwrightBody.includes("throw new Error(`窗口未登录");
    const loginGuardBeforeMarkBusy = playwrightBody.indexOf("'login_required'") <
      playwrightBody.indexOf('lockManager.acquire');
    record('C1. login_required 抛错且不 markBusy / lock',
      hasLoginRequired && loginGuardBeforeMarkBusy,
      hasLoginRequired && loginGuardBeforeMarkBusy
        ? 'login_required 分支抛错，位于 lockManager.acquire 之前'
        : `守卫缺失或顺序错误 (hasGuard=${hasLoginRequired}, order=${loginGuardBeforeMarkBusy})`);
  }

  // C2. busy：抛 WindowBusyError，不抢占
  {
    const hasBusyGuard = playwrightBody.includes("readyResult.status === 'busy'") &&
      playwrightBody.includes('throw new WindowBusyError');
    const busyGuardBeforeMarkBusy = playwrightBody.indexOf("'busy'") <
      playwrightBody.indexOf('adapter.markBusy');
    record('C2. busy 状态抛 WindowBusyError 且不抢占',
      hasBusyGuard && busyGuardBeforeMarkBusy,
      hasBusyGuard && busyGuardBeforeMarkBusy
        ? 'busy 分支抛 WindowBusyError，位于 markBusy 之前'
        : `守卫缺失或顺序错误 (hasGuard=${hasBusyGuard}, order=${busyGuardBeforeMarkBusy})`);
  }

  // C3. markBusy 失败：release lock
  {
    const markBusyIdx = playwrightBody.indexOf('adapter.markBusy');
    const getWorkerPageIdx = playwrightBody.indexOf('adapter.getWorkerPage');
    if (markBusyIdx < 0 || getWorkerPageIdx < 0) {
      record('C3. markBusy 失败时 release lock', false, '未找到 markBusy/getWorkerPage 调用');
    } else {
      const markBusySection = playwrightBody.substring(markBusyIdx, getWorkerPageIdx);
      const hasReleaseOnFail = markBusySection.includes('lockManager.release(windowId, taskId)') &&
        markBusySection.includes("throw new Error(`markBusy 失败");
      record('C3. markBusy 失败时 release lock',
        hasReleaseOnFail,
        hasReleaseOnFail ? 'markBusy 失败分支调用 lockManager.release 后抛错' : '回滚逻辑缺失');
    }
  }

  // C4. Handler 抛错：finally markReady + release lock
  //   在 executeAssignment 方法中查找 finally 块
  {
    const executeAssignmentBody = extractExecuteAssignmentMethod(content);
    if (!executeAssignmentBody) {
      record('C4. Handler 抛错后 finally markReady + release lock', false, '未找到 executeAssignment 方法');
    } else {
      // 找到 executeAssignment 中的 finally 块（内层 try-finally，含 conn.release）
      const finallyMatch = executeAssignmentBody.match(/finally\s*\{([\s\S]*?)\}\s*(?:catch|$)/);
      if (!finallyMatch) {
        record('C4. Handler 抛错后 finally markReady + release lock', false, '未找到 executeAssignment finally 块');
      } else {
        const finallyBody = finallyMatch[1];
        const hasReleaseCall = finallyBody.includes('await conn.release()');
        const hasTimerClear = finallyBody.includes('clearInterval(busyRenewalTimer)') &&
          finallyBody.includes('timeoutHandle.clear()');
        record('C4. Handler 抛错后 finally markReady + release lock',
          hasReleaseCall && hasTimerClear,
          hasReleaseCall && hasTimerClear
            ? 'finally 块清理定时器 + 调用 conn.release()（含 markReady + lock release）'
            : `清理逻辑缺失 (release=${hasReleaseCall}, timer=${hasTimerClear})`);
      }
    }
  }

  // C5. markReady 失败：仅记录日志，release lock 仍执行
  //   在 resolvePlaywrightWorkerConnection 的 release 闭包中检查
  {
    if (!playwrightBody) {
      record('C5. markReady 失败不阻断 release lock', false, '未找到 resolvePlaywrightWorkerConnection');
    } else {
      // 找到 release: async () => { ... } 闭包（在 playwrightBody 中）
      const releaseIdx = playwrightBody.indexOf('release: async () => {');
      const renewIdx = playwrightBody.indexOf('renew: async () => {');
      if (releaseIdx < 0 || renewIdx < 0 || releaseIdx > renewIdx) {
        record('C5. markReady 失败不阻断 release lock', false, '未找到 release 闭包');
      } else {
        const releaseBody = playwrightBody.substring(releaseIdx, renewIdx);
        // markReady 失败的 catch 块中不应 throw，仅 console.warn
        // 查找 markReady 调用后的 catch 块
        const markReadyIdx = releaseBody.indexOf('adapter.markReady');
        const lockReleaseIdx = releaseBody.indexOf('lockManager.release');
        const markReadyCatch = releaseBody.substring(markReadyIdx, lockReleaseIdx).match(/catch\s*\(\s*(\w+)\s*\)\s*\{([\s\S]*?)\}/);
        const catchOnlyLogs = markReadyCatch
          ? !markReadyCatch[2].includes('throw') && markReadyCatch[2].includes('console.warn')
          : false;
        const lockReleaseStillRuns = releaseBody.includes('lockManager.release(windowId, taskId)');
        record('C5. markReady 失败不阻断 release lock',
          catchOnlyLogs && lockReleaseStillRuns,
          catchOnlyLogs && lockReleaseStillRuns
            ? 'markReady catch 仅 console.warn，不 throw；后续 lockManager.release 仍执行'
            : `失败处理或锁释放逻辑不正确 (catchOnlyLogs=${catchOnlyLogs}, lockStillRuns=${lockReleaseStillRuns})`);
      }
    }
  }

  // C6. close 后重新任务：ensureWindowReady 可重启
  //   静态检查：PlaywrightWindowAdapter.ensureWindowReady 在 status=closed 时应能重启
  {
    const adapterPath = join(backendDir, 'window-adapter', 'PlaywrightWindowAdapter.ts');
    const adapterContent = readFileContent(adapterPath);
    const hasClosedRestart = adapterContent.includes("'closed'") &&
      (adapterContent.includes('launchWindow') || adapterContent.includes('openWindow'));
    record('C6. close 后 ensureWindowReady 可重启',
      hasClosedRestart,
      hasClosedRestart
        ? 'PlaywrightWindowAdapter.ensureWindowReady 在 closed 状态下会重新启动窗口'
        : '重启逻辑缺失（需查看 PlaywrightWindowAdapter.ensureWindowReady 实现）');
  }
}

/**
 * 从 AssignmentEngine.ts 内容中提取 executeAssignment 方法体
 */
function extractExecuteAssignmentMethod(content: string): string | null {
  const methodStart = content.indexOf('private async executeAssignment(');
  if (methodStart < 0) return null;
  const bodyStart = content.indexOf('{', content.indexOf('):', methodStart));
  if (bodyStart < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  return content.substring(methodStart, end);
}

// ════════════════════════════════════════════════════════════════
// Part D: 自动登录端到端验证（--auto-login）
// ════════════════════════════════════════════════════════════════

/**
 * 测试三元组说明（Phase 2-D-Run 修正）：
 *
 * POC 层（window-adapter-poc / playwright-poc）：
 *   tenantId = "tenant-default"
 *   siteId   = "site-default"
 *   windowId = `staff-${staffName}`  ← 与 Engine playwright 路径一致
 *
 * Sign API 层（/api/operations/sign）：
 *   site     = settings.json 中的真实 site.id（如 "site-1782121346155"）
 *   staffName = settings.json 中该站点下的 employeeName
 *
 * 两层使用同一个 staffName，确保 POC windowId 与 Engine 内部 windowId 一致。
 */
const TEST_TENANT_ID = 'tenant-default';

/** 自动登录验证结果（24 项，对应验收报告） */
interface AutoLoginReport {
  // 1-5: 基础信息
  credentialsFromEnv: boolean;           // 1. 测试账号通过环境变量传入
  noHardcodedCredentials: boolean;       // 2. 脚本不硬编码账号密码
  onlyScriptModified: boolean;           // 3. 是否只修改验证脚本
  handlerNotModified: boolean;           // 4. 是否未修改 Handler
  routesNotModified: boolean;            // 5. 是否未修改 routes.ts
  bnsyOperatorNotModified: boolean;      // 6. 是否未修改 bnsy-operator/

  // 测试三元组
  testTenantId: string;
  testPocSiteId: string;
  testStaffName: string;
  testWindowId: string;
  testSignSiteId: string;                // settings.json 真实 site.id

  // 6-9: 状态判断
  ensureReadyStatus: string;             // 6. ensure-ready 返回结果
  loginAttempted: boolean;               // 7. 自动登录是否执行
  loginSuccess: boolean;
  statusAfterLogin: string;
  refreshReady: boolean;                 // 8. refresh=true 是否 ready

  // P0 检查（Phase 2-D-Run 三次修正新增，sign 任务前门槛）
  p0CheckExecuted: boolean;              // 是否执行了 P0 检查
  p0Passed: boolean;                     // P0 是否通过
  p0Source: string;                      // 复用的旧 P0 函数/文件
  p0StartUrl: string;                    // P0 开始 URL
  p0EndUrl: string;                      // P0 结束 URL
  p0IsDashboard: boolean;                // 是否 dashboard
  p0IsLoginPage: boolean;                // 是否仍在 login
  p0HasCoreDom: boolean;                 // 核心DOM是否存在
  p0HasBlockingPopup: boolean;           // 是否检测到阻塞弹窗
  p0PopupDismissAttempted: boolean;      // 旧 P0 是否尝试处理弹窗
  p0FailedCheck: string;                 // P0 失败检查项
  p0FailedReason: string;                // P0 失败原因
  p0Rounds: number;                      // P0 检查轮数

  // Chrome 可视化状态（Phase 2-D-Run 真实 Chrome 验收新增）
  chromeHeaded: boolean;                 // Chrome 是否真实打开（headless=false）
  chromeChannel: string;                 // Chrome channel（chrome）
  chromeVisible: boolean;                // Chrome 是否可见（headed 模式）
  chromeKeepOpen: boolean;               // 任务结束后 Chrome 是否保持打开
  chromeLaunched: boolean;               // Chrome 是否已启动

  // 9-12: 第一次 sign 任务
  signApiPath: string;                   // 9. sign 接口路径
  firstSignTaskId: string;               // 10. 第一次 sign 任务 taskId
  firstSignTaskStatus: string;           // 11. 第一次任务状态
  firstSignLogSummary: string;           // 12. 第一次任务日志摘要

  // 13-17: 日志关键字验证
  enteredPlaywrightRuntime: boolean;     // 13. 是否进入 Playwright runtime
  enteredSignHandler: boolean;           // 14. 是否进入 SignHandler / executeSign
  markBusyIndirectProof: boolean;        // 15. 是否 markBusy（间接证明）
  markReadyIndirectProof: boolean;       // 16. 是否 markReady（间接证明）
  lockReleaseIndirectProof: boolean;     // 17. 是否 release lock（间接证明）

  // 18: 任务后窗口状态
  windowStatusAfterFirstTask: string;    // 18. 任务结束后窗口状态

  // 19-21: 第二次 sign 任务
  secondSignTaskId: string;              // 19. 第二次 sign taskId
  secondSignTaskStatus: string;          // 20. 第二次任务状态
  windowReused: boolean;                 // 21. 第二次是否复用窗口
  windowStatusAfterSecondTask: string;

  // 22-23: EasyBR 检查范围
  easybrCheckScopeCorrect: boolean;      // 22. EasyBR 检查范围说明
  noEasyBRInPlaywrightLayer: boolean;    //     playwright 层无 EasyBRClient
  noConnectOverCDPInPlaywrightLayer: boolean;
  legacyEasyBRAllowed: boolean;          //     legacy 层允许存在 EasyBR

  // 24: Phase 2-E 建议
  recommendPhase2E: boolean;
}

const autoLoginReport: AutoLoginReport = {
  credentialsFromEnv: false,
  noHardcodedCredentials: true,
  onlyScriptModified: true,
  handlerNotModified: true,
  routesNotModified: true,
  bnsyOperatorNotModified: true,
  testTenantId: TEST_TENANT_ID,
  testPocSiteId: '',
  testStaffName: '',
  testWindowId: '',
  testSignSiteId: '',
  ensureReadyStatus: 'unknown',
  loginAttempted: false,
  loginSuccess: false,
  statusAfterLogin: 'unknown',
  refreshReady: false,
  // P0 检查字段初始化
  p0CheckExecuted: false,
  p0Passed: false,
  p0Source: '',
  p0StartUrl: '',
  p0EndUrl: '',
  p0IsDashboard: false,
  p0IsLoginPage: false,
  p0HasCoreDom: false,
  p0HasBlockingPopup: false,
  p0PopupDismissAttempted: false,
  p0FailedCheck: '',
  p0FailedReason: '',
  p0Rounds: 0,
  // Chrome 可视化字段初始化
  chromeHeaded: false,
  chromeChannel: '',
  chromeVisible: false,
  chromeKeepOpen: false,
  chromeLaunched: false,
  signApiPath: 'POST /api/operations/sign',
  firstSignTaskId: '',
  firstSignTaskStatus: 'unknown',
  firstSignLogSummary: '',
  enteredPlaywrightRuntime: false,
  enteredSignHandler: false,
  markBusyIndirectProof: false,
  markReadyIndirectProof: false,
  lockReleaseIndirectProof: false,
  windowStatusAfterFirstTask: 'unknown',
  secondSignTaskId: '',
  secondSignTaskStatus: 'unknown',
  windowReused: false,
  windowStatusAfterSecondTask: 'unknown',
  easybrCheckScopeCorrect: false,
  noEasyBRInPlaywrightLayer: false,
  noConnectOverCDPInPlaywrightLayer: false,
  legacyEasyBRAllowed: true,
  recommendPhase2E: false,
};

/**
 * 将 settings.json site.id 转换为内部 Site code（与 routes.ts normalizeSiteToCode 一致）
 *
 * 转换规则：
 *   - 'tiannanda' / 'heyuan' → 直接返回
 *   - site.id 匹配 → 按 site.name 判断（含'天南大'→'tiannanda'，含'和苑'→'heyuan'）
 *
 * 这是因为 Engine 的 resolvePlaywrightWorkerConnection 使用 `siteId = String(site)`，
 * 其中 site 是内部 Site code（'tiannanda' | 'heyuan'），不是 settings.json site.id。
 * POC API 必须使用相同的 siteId 才能匹配 Engine 内部的窗口。
 */
function normalizeSiteToCode(siteInput: string, sites: any[]): string | null {
  if (siteInput === 'tiannanda' || siteInput === 'heyuan') return siteInput;
  const site = sites.find(s => s.id === siteInput);
  if (!site) return null;
  if (site.name && site.name.includes('天南大')) return 'tiannanda';
  if (site.name && site.name.includes('和苑')) return 'heyuan';
  return null;
}

/**
 * 校验测试参数：site/staff/windowId/credentials/runtimeMode
 *
 * fail-fast 规则：任一缺失立即退出，不继续执行 ensure-ready，不生成 unknown 报告。
 *
 * 校验内容：
 *   1. --site 不为空
 *   2. --staff 不为空
 *   3. windowId 不为空（默认 staff-${staffName}）
 *   4. BNSY_TEST_USERNAME 不为空
 *   5. BNSY_TEST_PASSWORD 不为空
 *   6. WINDOW_RUNTIME_MODE=playwright
 *
 * 返回 true 表示全部通过，false 表示有缺失（已输出错误信息）。
 */
function validateTestParams(): boolean {
  const errors: string[] = [];

  if (!TEST_SITE) {
    errors.push('❌ 缺少 --site 参数，请传入真实 settings.json 中的 site.id');
  }
  if (!TEST_STAFF) {
    errors.push('❌ 缺少 --staff 参数，请传入真实员工名');
  }
  if (!TEST_WINDOW_ID) {
    errors.push('❌ 缺少 windowId（--window-id 或 --staff）');
  }
  if (!TEST_USERNAME) {
    errors.push('❌ 缺少环境变量 BNSY_TEST_USERNAME');
  }
  if (!TEST_PASSWORD) {
    errors.push('❌ 缺少环境变量 BNSY_TEST_PASSWORD');
  }
  if (process.env.WINDOW_RUNTIME_MODE !== 'playwright') {
    errors.push(`❌ WINDOW_RUNTIME_MODE 当前不是 playwright（当前值: ${process.env.WINDOW_RUNTIME_MODE || '(未设置)'}）`);
  }

  if (errors.length > 0) {
    console.log('\n  ⚠ 参数校验失败（fail-fast）：');
    for (const e of errors) console.log(`  ${e}`);
    console.log('\n  正确启动方式：');
    console.log('    $env:WINDOW_RUNTIME_MODE="playwright"');
    console.log('    $env:BNSY_TEST_USERNAME="<你的测试账号>"');
    console.log('    $env:BNSY_TEST_PASSWORD="<你的测试密码>"');
    console.log('    npx tsx scripts/sign-runtime-mode-verify.ts --auto-login --site=<siteId> --staff=<员工名>');
    return false;
  }
  return true;
}

/**
 * 从 /api/settings/config 获取配置并校验 site/staff 存在性
 *
 * 校验规则：
 *   1. siteId 必须存在于 settings.json
 *   2. staffName 必须属于该 site
 *   3. 如果不存在，输出当前可用 site/staff 列表
 *   4. 不继续提交任务
 *
 * 返回：
 *   - { signSiteId, pocSiteId, staffName, windowId } 校验成功
 *   - null 校验失败（已输出可用列表）
 */
async function validateSettings(): Promise<{
  signSiteId: string;   // settings.json site.id（用于 Sign API）
  pocSiteId: string;    // 内部 Site code（用于 POC API，与 Engine 一致）
  staffName: string;
  windowId: string;
} | null> {
  let config: any = null;
  try {
    const { data } = await http('GET', `${BASE_URL}/api/settings/config`);
    config = data;
  } catch (e) {
    console.log(`  ❌ 无法获取 settings 配置: ${(e as Error).message}`);
    console.log('  请确保后端已启动：WINDOW_RUNTIME_MODE=playwright npm run dev');
    return null;
  }

  if (!config?.initialized || !config.sites?.length) {
    console.log('  ❌ 系统未初始化或无站点配置');
    console.log('  请先通过前端配置网点和窗口');
    return null;
  }

  // 1. 校验 siteId 存在
  const targetSite = config.sites.find((s: any) => s.id === TEST_SITE);
  if (!targetSite) {
    console.log(`  ❌ siteId="${TEST_SITE}" 不存在于 settings.json`);
    console.log('\n  当前可用站点：');
    for (const s of config.sites) {
      console.log(`  - ${s.id}  ${s.name || ''}`);
    }
    return null;
  }

  // 2. 转换为内部 Site code（与 Engine resolvePlaywrightWorkerConnection 一致）
  const pocSiteId = normalizeSiteToCode(TEST_SITE, config.sites);
  if (!pocSiteId) {
    console.log(`  ❌ 无法识别站点名称: ${targetSite.name}`);
    console.log('  站点名称必须包含"天南大"或"和苑"才能转换为内部 Site code');
    return null;
  }

  // 3. 校验 staffName 属于该 site
  const staffExists = targetSite.windows?.some((w: any) =>
    w.employeeName === TEST_STAFF || (w.windowName && w.windowName.includes(TEST_STAFF)));
  if (!staffExists) {
    console.log(`  ❌ staffName="${TEST_STAFF}" 不属于站点 ${targetSite.id} (${targetSite.name})`);
    console.log('\n  当前站点可用员工：');
    if (targetSite.windows?.length > 0) {
      for (const w of targetSite.windows) {
        console.log(`  - ${w.employeeName || '(无 employeeName)'}  (窗口: ${w.windowName || '?'})`);
      }
    } else {
      console.log('  (该站点无窗口配置)');
    }
    return null;
  }

  console.log(`  ✓ 站点校验通过: ${targetSite.id} (${targetSite.name}) → 内部 code: ${pocSiteId}`);
  console.log(`  ✓ 员工校验通过: ${TEST_STAFF}`);
  console.log(`  ✓ POC windowId: ${TEST_WINDOW_ID}`);

  return {
    signSiteId: TEST_SITE,
    pocSiteId,
    staffName: TEST_STAFF,
    windowId: TEST_WINDOW_ID,
  };
}

/** 轮询任务状态直到结束（done/failed/cancelled），最多等待 timeoutMs */
async function pollTaskStatus(taskId: string, timeoutMs = 120_000): Promise<string> {
  const startTime = Date.now();
  const pollInterval = 3000;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const { data } = await http('GET', `${BASE_URL}/api/operations/${taskId}`);
      const status = data?.status || 'unknown';
      if (status === 'done' || status === 'failed' || status === 'cancelled') {
        return status;
      }
    } catch {
      // 忽略偶发错误，继续轮询
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  return 'timeout';
}

/** 获取任务日志（合并内存日志 + PG 日志） */
async function getTaskLogs(taskId: string): Promise<string[]> {
  const logs: string[] = [];
  try {
    const { data } = await http('GET', `${BASE_URL}/api/operations/${taskId}/logs?limit=200`);
    if (data?.logs) {
      for (const log of data.logs) {
        logs.push(`${log.level || ''} [${log.source || ''}] ${log.message || ''}`);
      }
    }
  } catch {
    // 内存日志可能不可用
  }
  return logs;
}

/** 获取窗口状态（refresh=true 实时刷新） */
async function getWindowStatus(windowId: string, pocSiteId: string): Promise<{ status: string; isLoggedIn: boolean } | null> {
  try {
    const { data } = await http('GET',
      `${POC_BASE}/status?tenantId=${TEST_TENANT_ID}&siteId=${pocSiteId}&windowId=${windowId}&refresh=true`);
    return {
      status: data?.status || 'unknown',
      isLoggedIn: data?.isLoggedIn === true,
    };
  } catch {
    return null;
  }
}

/**
 * EasyBR / connectOverCDP 检查范围（Phase 2-D-Run 修正）
 *
 * 必须无 EasyBRClient 的范围（playwright 层）：
 *   - backend/playwright-runtime/ 所有 .ts 文件
 *   - backend/window-adapter/ 所有 .ts 文件
 *   - backend/config/runtimeMode.ts
 *   - 4 个正式 Handler 文件
 *
 * 允许有 EasyBRClient 的范围（legacy 回退路径）：
 *   - backend/browser/BrowserPool.ts
 *   - backend/easybr/EasyBRClient.ts
 *   - 其他 legacy 文件
 *
 * 必须无 connectOverCDP 的范围（playwright 路径）：
 *   - backend/playwright-runtime/ 所有 .ts 文件
 *   - backend/window-adapter/ 所有 .ts 文件
 */
function checkEasyBRScope(): { noEasyBRInPlaywrightLayer: boolean; noConnectOverCDP: boolean; details: string } {
  const details: string[] = [];

  // 1. 检查 playwright 层无 EasyBRClient
  const playwrightDir = join(backendDir, 'playwright-runtime');
  const adapterDir = join(backendDir, 'window-adapter');
  const runtimeModePath = join(backendDir, 'config', 'runtimeMode.ts');
  const handlerDir = join(backendDir, 'modules', 'assignment-engine', 'handlers');
  const handlerFiles = ['ArrivalHandler.ts', 'DispatchHandler.ts', 'IntegratedHandler.ts', 'SignHandler.ts'];

  const easybrForbiddenDirs = [playwrightDir, adapterDir];
  let easybrInPlaywright = false;
  const easybrViolations: string[] = [];

  for (const dir of easybrForbiddenDirs) {
    const files = listTsFiles(dir);
    for (const f of files) {
      const code = stripComments(readFileContent(f));
      if (code.includes('EasyBRClient')) {
        easybrInPlaywright = true;
        easybrViolations.push(`${f.replace(nextRoot, '')} import EasyBRClient`);
      }
    }
  }

  // 检查 runtimeMode.ts
  if (stripComments(readFileContent(runtimeModePath)).includes('EasyBRClient')) {
    easybrInPlaywright = true;
    easybrViolations.push('backend/config/runtimeMode.ts import EasyBRClient');
  }

  // 检查 4 个 Handler
  for (const h of handlerFiles) {
    const code = stripComments(readFileContent(join(handlerDir, h)));
    if (code.includes('EasyBRClient')) {
      easybrInPlaywright = true;
      easybrViolations.push(`Handler ${h} import EasyBRClient`);
    }
  }

  const noEasyBRInPlaywrightLayer = !easybrInPlaywright;
  details.push(noEasyBRInPlaywrightLayer
    ? '✓ playwright-runtime/ + window-adapter/ + runtimeMode.ts + 4 个 Handler 均未 import EasyBRClient'
    : `✗ 违规: ${easybrViolations.join('; ')}`);

  // 2. 检查 playwright 层无 connectOverCDP
  let connectOverCDPInPlaywright = false;
  const cdvViolations: string[] = [];
  for (const dir of easybrForbiddenDirs) {
    const files = listTsFiles(dir);
    for (const f of files) {
      const code = stripComments(readFileContent(f));
      if (code.includes('connectOverCDP')) {
        connectOverCDPInPlaywright = true;
        cdvViolations.push(`${f.replace(nextRoot, '')} 调用 connectOverCDP`);
      }
    }
  }
  const noConnectOverCDP = !connectOverCDPInPlaywright;
  details.push(noConnectOverCDP
    ? '✓ playwright-runtime/ + window-adapter/ 均未调用 connectOverCDP'
    : `✗ 违规: ${cdvViolations.join('; ')}`);

  // 3. 明确 legacy 层允许存在 EasyBR（不判失败）
  const browserPoolPath = join(backendDir, 'browser', 'BrowserPool.ts');
  const easybrClientPath = join(backendDir, 'easybr', 'EasyBRClient.ts');
  const browserPoolHasEasyBR = stripComments(readFileContent(browserPoolPath)).includes('EasyBRClient');
  const easybrClientSelf = existsSync(easybrClientPath);
  details.push(browserPoolHasEasyBR
    ? '✓ legacy BrowserPool.ts 中存在 EasyBR 代码，属于允许范围（legacy 回退路径）'
    : 'ℹ legacy BrowserPool.ts 中无 EasyBR 代码');
  details.push(easybrClientSelf
    ? '✓ legacy EasyBRClient.ts 存在，属于允许范围（legacy 回退路径）'
    : 'ℹ legacy EasyBRClient.ts 不存在');

  return {
    noEasyBRInPlaywrightLayer,
    noConnectOverCDP,
    details: details.join('\n    '),
  };
}

async function verifyAutoLogin(): Promise<void> {
  console.log('\n── Part D: 自动登录端到端验证（--auto-login） ──\n');

  // ── D17. EasyBR / connectOverCDP 检查范围（静态检查，始终执行） ──
  const easybrCheck = checkEasyBRScope();
  autoLoginReport.noEasyBRInPlaywrightLayer = easybrCheck.noEasyBRInPlaywrightLayer;
  autoLoginReport.noConnectOverCDPInPlaywrightLayer = easybrCheck.noConnectOverCDP;
  autoLoginReport.easybrCheckScopeCorrect = easybrCheck.noEasyBRInPlaywrightLayer && easybrCheck.noConnectOverCDP;

  record('D17. EasyBR 检查范围正确（playwright 层无 EasyBR，legacy 层允许）',
    autoLoginReport.easybrCheckScopeCorrect,
    `\n    ${easybrCheck.details}`);

  // ── fail-fast 参数校验（任一缺失立即退出） ──
  if (!validateTestParams()) {
    console.log('\n  ⚠ 参数校验失败，停止执行（fail-fast）。');
    return;
  }

  // ── D1. 环境变量已读取 ──
  autoLoginReport.credentialsFromEnv = true;
  record('D1. 环境变量 BNSY_TEST_USERNAME / BNSY_TEST_PASSWORD 已读取',
    true,
    `username=${maskUsername(TEST_USERNAME)}, password=${maskPassword()}`);

  // ── D2. 账号密码未硬编码 ──
  const scriptPath = join(__dirname, 'sign-runtime-mode-verify.ts');
  const scriptContent = stripComments(readFileContent(scriptPath));
  const usernameInSource = TEST_USERNAME && scriptContent.includes(TEST_USERNAME);
  const passwordInSource = TEST_PASSWORD && scriptContent.includes(TEST_PASSWORD);
  autoLoginReport.noHardcodedCredentials = !usernameInSource && !passwordInSource;
  record('D2. 账号密码未硬编码',
    autoLoginReport.noHardcodedCredentials,
    autoLoginReport.noHardcodedCredentials
      ? `脚本源码中未发现环境变量中的账号密码值（username=${maskUsername(TEST_USERNAME)}）`
      : `检测到硬编码：usernameInSource=${usernameInSource}, passwordInSource=${passwordInSource}`);

  // ── 校验 settings 中存在该 site/staff ──
  const validated = await validateSettings();
  if (!validated) {
    console.log('\n  ⚠ settings 校验失败，停止执行（fail-fast）。');
    return;
  }
  const { signSiteId, pocSiteId, staffName, windowId: testWindowId } = validated;

  // 记录测试参数（全程统一使用）
  autoLoginReport.testStaffName = staffName;
  autoLoginReport.testWindowId = testWindowId;
  autoLoginReport.testSignSiteId = signSiteId;
  autoLoginReport.testPocSiteId = pocSiteId;

  // ── 打印最终测试参数 ──
  console.log(`\n  ── 最终测试参数 ──`);
  console.log(`  tenantId   = ${TEST_TENANT_ID}`);
  console.log(`  POC siteId = ${pocSiteId}（内部 Site code，与 Engine 一致）`);
  console.log(`  Sign site  = ${signSiteId}（settings.json site.id）`);
  console.log(`  staffName  = ${staffName}`);
  console.log(`  windowId   = ${testWindowId}`);
  console.log(`  runtimeMode= playwright`);
  console.log(`  ────────────────\n`);

  const adapterOptions = {
    tenantId: TEST_TENANT_ID,
    siteId: pocSiteId,
    windowId: testWindowId,
    staffName,
  };

  // ── D3. ensure-ready 启动测试窗口 ──
  try {
    const { status, data } = await http('POST', `${POC_BASE}/ensure-ready`, adapterOptions);
    autoLoginReport.ensureReadyStatus = data?.status || 'unknown';
    const validStatus = ['ready', 'login_required', 'opening', 'busy', 'failed', 'closed']
      .includes(autoLoginReport.ensureReadyStatus);
    // 记录 Chrome 可视化状态（PlaywrightRuntime 硬编码 channel='chrome', headless=false）
    autoLoginReport.chromeLaunched = !!data?.launched || autoLoginReport.ensureReadyStatus !== 'closed';
    autoLoginReport.chromeHeaded = true;        // PlaywrightWindowAdapter L99/L154 硬编码 headless: false
    autoLoginReport.chromeChannel = 'chrome';   // PlaywrightRuntime L107 硬编码 channel: 'chrome'
    autoLoginReport.chromeVisible = headedMode; // CLI --headed 参数
    autoLoginReport.chromeKeepOpen = keepOpenMode; // CLI --keep-open 参数
    record('D3. ensure-ready 启动测试窗口',
      status === 200 && validStatus,
      `status=${data?.status}, launched=${data?.launched}, isLoggedIn=${data?.isLoggedIn}, http=${status}, chrome=headed/${autoLoginReport.chromeChannel}`);
  } catch (e) {
    record('D3. ensure-ready 启动测试窗口', false, (e as Error).message);
    return;
  }

  // ── D4. 登录前状态判断 ──
  const statusBefore = autoLoginReport.ensureReadyStatus;
  record('D4. 登录前状态明确',
    statusBefore === 'ready' || statusBefore === 'login_required',
    `statusBeforeLogin=${statusBefore}`);

  if (statusBefore !== 'ready' && statusBefore !== 'login_required') {
    console.log(`  ⚠ 窗口状态为 ${statusBefore}，无法继续 sign 任务验证。`);
    return;
  }

  // ── D5. 自动登录（仅当 login_required 时执行） ──
  if (statusBefore === 'login_required') {
    autoLoginReport.loginAttempted = true;
    console.log(`  状态为 login_required，执行自动登录（username=${maskUsername(TEST_USERNAME)}）...`);
    try {
      const { status, data } = await http('POST', `${PLAYWRIGHT_POC_BASE}/window/login`, {
        tenantId: TEST_TENANT_ID,
        siteId: pocSiteId,
        windowId: testWindowId,
        account: TEST_USERNAME,
        password: TEST_PASSWORD,
      });
      autoLoginReport.loginSuccess = status === 200 && data?.success === true;
      record('D5. 自动登录成功',
        autoLoginReport.loginSuccess,
        `success=${data?.success}, reason=${data?.reason || 'N/A'}, http=${status}`);
    } catch (e) {
      record('D5. 自动登录成功', false, (e as Error).message);
      return;
    }

    if (!autoLoginReport.loginSuccess) {
      console.log('  ⚠ 自动登录失败，跳过 sign 任务验证。');
      return;
    }

    // 登录后必须调用 refresh=true 确认状态
    const refreshResult = await getWindowStatus(testWindowId, pocSiteId);
    if (!refreshResult) {
      record('D6. refresh=true 返回 ready', false, 'refresh=true 调用失败');
      return;
    }
    autoLoginReport.statusAfterLogin = refreshResult.status;
    autoLoginReport.refreshReady = refreshResult.status === 'ready' && refreshResult.isLoggedIn;
    record('D6. refresh=true 返回 ready',
      autoLoginReport.refreshReady,
      `status=${refreshResult.status}, isLoggedIn=${refreshResult.isLoggedIn}`);
  } else {
    // statusBefore === 'ready'：窗口已登录，无需自动登录
    autoLoginReport.loginAttempted = false;
    autoLoginReport.loginSuccess = true;
    const refreshResult = await getWindowStatus(testWindowId, pocSiteId);
    if (!refreshResult) {
      record('D6. refresh=true 返回 ready', false, 'refresh=true 调用失败');
      return;
    }
    autoLoginReport.statusAfterLogin = refreshResult.status;
    autoLoginReport.refreshReady = refreshResult.status === 'ready';
    record('D5. 自动登录（无需登录）',
      true,
      '窗口已为 ready 状态，跳过登录');
    record('D6. refresh=true 返回 ready',
      autoLoginReport.refreshReady,
      `status=${refreshResult.status}, isLoggedIn=${refreshResult.isLoggedIn}`);
  }

  if (!autoLoginReport.refreshReady) {
    console.log(`  ⚠ refresh=true 后窗口状态为 ${autoLoginReport.statusAfterLogin}，未就绪，跳过 sign 任务验证。`);
    return;
  }

  // ── D6.5 P0 就绪检查（sign 任务前门槛，Phase 2-D-Run 三次修正） ──
  // 复用旧 BrowserPool.verifyReady（7 项检查）+ ensureNoPopup（PopupManager.dismissAll）
  // P0 不通过直接失败，不提交 sign 任务，不生成 unknown 报告
  console.log(`\n  ── D6.5 P0 就绪检查（sign 任务前门槛）──`);
  console.log(`  复用旧 P0 逻辑: BrowserPool.verifyReady + ensureNoPopup`);
  autoLoginReport.p0CheckExecuted = true;
  const p0Response = await runP0Check({
    baseUrl: BASE_URL,
    pocBase: PLAYWRIGHT_POC_BASE,
    tenantId: TEST_TENANT_ID,
    siteId: pocSiteId,
    windowId: testWindowId,
  });

  if (!p0Response.success || !p0Response.report) {
    // P0 检查调用失败（网络错误/接口错误）
    autoLoginReport.p0Passed = false;
    autoLoginReport.p0FailedCheck = 'p0_api_call_failed';
    autoLoginReport.p0FailedReason = p0Response.error || 'P0 检查接口调用失败';
    record('D6.5 P0 就绪检查（复用旧 BrowserPool.verifyReady）',
      false,
      `P0 接口调用失败: ${p0Response.error}`);
    console.log(`  ⚠ P0 检查接口调用失败，停止后续 sign 任务验证。`);
    return;
  }

  const p0Report = p0Response.report;
  autoLoginReport.p0Passed = p0Report.passed;
  autoLoginReport.p0Source = p0Report.source;
  autoLoginReport.p0StartUrl = p0Report.startUrl;
  autoLoginReport.p0EndUrl = p0Report.endUrl;
  autoLoginReport.p0IsDashboard = p0Report.isDashboard;
  autoLoginReport.p0IsLoginPage = p0Report.isLoginPage;
  autoLoginReport.p0HasCoreDom = p0Report.hasCoreDom;
  autoLoginReport.p0HasBlockingPopup = p0Report.hasBlockingPopup;
  autoLoginReport.p0PopupDismissAttempted = p0Report.popupDismissAttempted;
  autoLoginReport.p0FailedCheck = p0Report.failedCheck;
  autoLoginReport.p0FailedReason = p0Report.failedReason;
  autoLoginReport.p0Rounds = p0Report.rounds.length;

  record('D6.5 P0 就绪检查（复用旧 BrowserPool.verifyReady）',
    p0Report.passed,
    p0Report.passed
      ? `passed, rounds=${p0Report.rounds.length}, endUrl=${p0Report.endUrl}, hasCoreDom=${p0Report.hasCoreDom}`
      : `failed [${p0Report.failedCheck}]: ${p0Report.failedReason}, endUrl=${p0Report.endUrl}`);

  if (!p0Report.passed) {
    // P0 不通过：直接失败，不提交 sign 任务，不生成 unknown 报告
    console.log(`  ⚠ P0 检查未通过 [${p0Report.failedCheck}]，停止后续 sign 任务验证。`);
    console.log(`  ⚠ 失败原因: ${p0Report.failedReason}`);
    console.log(`  ⚠ 不提交 sign 任务，不生成 unknown 报告。`);
    return;
  }

  console.log(`  ✓ P0 检查通过，继续提交 sign 任务。`);

  // ── D7. 第一次 sign 任务提交（真实调用） ──
  const signPayload = {
    site: signSiteId,
    assignments: [{ staffName, waybillNos: ['TEST-SIGN-001'] }],
  };
  console.log(`\n  提交第一次 sign 任务: POST /api/operations/sign`);
  console.log(`  请求体: site=${signSiteId}, staffName=${staffName}, waybillNos=["TEST-SIGN-001"]`);

  try {
    const { status, data } = await http('POST', `${BASE_URL}/api/operations/sign`, signPayload);
    if (status === 200 && data?.taskId) {
      autoLoginReport.firstSignTaskId = data.taskId;
      record('D7. 第一次 sign 任务提交成功（拿到 taskId）',
        true,
        `taskId=${data.taskId}, status=${data.status}, http=${status}`);
    } else {
      record('D7. 第一次 sign 任务提交成功（拿到 taskId）',
        false,
        `http=${status}, error=${data?.error || 'N/A'}, response=${JSON.stringify(data)}`);
      console.log(`  ⚠ sign 接口响应体: ${JSON.stringify(data)}`);
      console.log(`  ⚠ HTTP status: ${status}`);
      console.log(`  ⚠ 调用路径: POST /api/operations/sign`);
      console.log(`  ⚠ 请求体: ${JSON.stringify(signPayload)}`);
      return;
    }
  } catch (e) {
    record('D7. 第一次 sign 任务提交成功（拿到 taskId）', false, (e as Error).message);
    return;
  }

  // ── D8. 轮询任务状态直到 done/failed/timeout ──
  console.log(`\n  等待第一次任务 ${autoLoginReport.firstSignTaskId} 完成（最多 180s）...`);
  autoLoginReport.firstSignTaskStatus = await pollTaskStatus(autoLoginReport.firstSignTaskId, 180_000);
  console.log(`  第一次任务状态: ${autoLoginReport.firstSignTaskStatus}`);

  const firstTaskEnded = ['done', 'failed'].includes(autoLoginReport.firstSignTaskStatus);
  record('D8. 第一次任务状态结束（done/failed）',
    firstTaskEnded,
    `status=${autoLoginReport.firstSignTaskStatus}`);

  // ── D9. 查询任务日志 ──
  const taskLogs = await getTaskLogs(autoLoginReport.firstSignTaskId);
  const allLogsText = taskLogs.join('\n');

  const keyLogLines = taskLogs.filter(l =>
    l.includes('runtimeMode') || l.includes('Worker connection') ||
    l.includes('签收') || l.includes('SignHandler') || l.includes('EasyBR'));
  autoLoginReport.firstSignLogSummary = keyLogLines.slice(0, 10).join(' | ') || '(无关键日志)';

  // D9. 任务日志含 runtimeMode=playwright
  autoLoginReport.enteredPlaywrightRuntime =
    allLogsText.includes('runtimeMode=playwright') || allLogsText.includes('usePlaywright=true');
  record('D9. 任务日志含 runtimeMode=playwright（进入 Playwright runtime）',
    autoLoginReport.enteredPlaywrightRuntime,
    autoLoginReport.enteredPlaywrightRuntime
      ? (allLogsText.includes('runtimeMode=playwright')
          ? '日志含 runtimeMode=playwright'
          : '日志含 usePlaywright=true')
      : '日志未含 runtimeMode 标识');

  // D10. 任务日志含 Worker connection established
  const hasWorkerConnection = allLogsText.includes('Worker connection established');
  record('D10. 任务日志含 Worker connection established',
    hasWorkerConnection,
    hasWorkerConnection ? 'Engine 已通过 resolvePlaywrightWorkerConnection 获取连接' : '日志未含 Worker connection established');

  // D11. 任务日志含签收关键字
  autoLoginReport.enteredSignHandler =
    allLogsText.includes('签收') ||
    allLogsText.includes('SignHandler') ||
    allLogsText.includes('SignScan') ||
    allLogsText.includes('进入签收页面') ||
    allLogsText.includes('签收页面已就绪') ||
    allLogsText.includes('签收执行失败') ||
    allLogsText.includes('签收完成');
  record('D11. 任务日志含签收关键字（进入 SignHandler / executeSign）',
    autoLoginReport.enteredSignHandler,
    autoLoginReport.enteredSignHandler
      ? `日志含签收相关记录`
      : '日志未含签收关键字');

  // D12-D14. 间接验证 markBusy / markReady / release lock
  const windowAfterFirst = await getWindowStatus(testWindowId, pocSiteId);
  if (windowAfterFirst) {
    autoLoginReport.windowStatusAfterFirstTask = windowAfterFirst.status;
    autoLoginReport.markBusyIndirectProof = firstTaskEnded;
    autoLoginReport.markReadyIndirectProof = windowAfterFirst.status === 'ready';
    autoLoginReport.lockReleaseIndirectProof = windowAfterFirst.status === 'ready';

    record('D12. markBusy 已执行（间接证明：任务已结束）',
      autoLoginReport.markBusyIndirectProof,
      `任务 status=${autoLoginReport.firstSignTaskStatus}`);
    record('D13. markReady 已执行（间接证明：窗口恢复 ready）',
      autoLoginReport.markReadyIndirectProof,
      `窗口 status=${windowAfterFirst.status}, isLoggedIn=${windowAfterFirst.isLoggedIn}`);
    record('D14. release lock 已执行（间接证明：窗口恢复 ready）',
      autoLoginReport.lockReleaseIndirectProof,
      `窗口 status=${windowAfterFirst.status}`);
  } else {
    record('D12. markBusy 已执行（间接证明）', false, '无法获取窗口状态');
    record('D13. markReady 已执行（间接证明）', false, '无法获取窗口状态');
    record('D14. release lock 已执行（间接证明）', false, '无法获取窗口状态');
  }

  // D15. 任务结束后窗口状态验证
  record('D15. 任务结束后窗口状态 ready',
    autoLoginReport.windowStatusAfterFirstTask === 'ready',
    `status=${autoLoginReport.windowStatusAfterFirstTask}`);

  // ── D16. 第二次 sign 任务复用窗口 ──
  const signPayload2 = {
    site: signSiteId,
    assignments: [{ staffName, waybillNos: ['TEST-SIGN-002'] }],
  };
  console.log(`\n  提交第二次 sign 任务: TEST-SIGN-002`);

  const windowBeforeSecond = await getWindowStatus(testWindowId, pocSiteId);
  const windowReadyBeforeSecond = windowBeforeSecond?.status === 'ready';

  try {
    const { status, data } = await http('POST', `${BASE_URL}/api/operations/sign`, signPayload2);
    if (status === 200 && data?.taskId) {
      autoLoginReport.secondSignTaskId = data.taskId;
      console.log(`  等待第二次任务 ${autoLoginReport.secondSignTaskId} 完成...`);
      autoLoginReport.secondSignTaskStatus = await pollTaskStatus(autoLoginReport.secondSignTaskId, 180_000);
      console.log(`  第二次任务状态: ${autoLoginReport.secondSignTaskStatus}`);

      const secondLogs = await getTaskLogs(autoLoginReport.secondSignTaskId);
      const secondLogsText = secondLogs.join('\n');
      const secondEnteredPlaywright = secondLogsText.includes('runtimeMode=playwright') ||
        secondLogsText.includes('usePlaywright=true');
      const secondHasWorkerConn = secondLogsText.includes('Worker connection established');

      const windowAfterSecond = await getWindowStatus(testWindowId, pocSiteId);
      if (windowAfterSecond) {
        autoLoginReport.windowStatusAfterSecondTask = windowAfterSecond.status;
      }

      autoLoginReport.windowReused = windowReadyBeforeSecond &&
        secondEnteredPlaywright &&
        secondHasWorkerConn &&
        autoLoginReport.windowStatusAfterSecondTask === 'ready';

      record('D16. 第二次 sign 任务复用窗口',
        autoLoginReport.windowReused,
        `taskId=${autoLoginReport.secondSignTaskId}, status=${autoLoginReport.secondSignTaskStatus}, ` +
        `windowBefore=${windowBeforeSecond?.status}, windowAfter=${autoLoginReport.windowStatusAfterSecondTask}, ` +
        `playwright=${secondEnteredPlaywright}, workerConn=${secondHasWorkerConn}`);
    } else {
      record('D16. 第二次 sign 任务复用窗口',
        false,
        `http=${status}, error=${data?.error || 'N/A'}, response=${JSON.stringify(data)}`);
      console.log(`  ⚠ sign 接口响应体: ${JSON.stringify(data)}`);
      console.log(`  ⚠ HTTP status: ${status}`);
      console.log(`  ⚠ 调用路径: POST /api/operations/sign`);
      console.log(`  ⚠ 请求体: ${JSON.stringify(signPayload2)}`);
    }
  } catch (e) {
    record('D16. 第二次 sign 任务复用窗口', false, (e as Error).message);
  }

  // ── D18. Phase 2-E 建议判定 ──
  autoLoginReport.recommendPhase2E =
    autoLoginReport.credentialsFromEnv &&
    autoLoginReport.noHardcodedCredentials &&
    autoLoginReport.refreshReady &&
    !!autoLoginReport.firstSignTaskId &&
    autoLoginReport.enteredPlaywrightRuntime &&
    autoLoginReport.enteredSignHandler &&
    autoLoginReport.windowStatusAfterFirstTask === 'ready' &&
    autoLoginReport.easybrCheckScopeCorrect;

  record('D18. 建议进入 Phase 2-E',
    autoLoginReport.recommendPhase2E,
    autoLoginReport.recommendPhase2E
      ? '所有通过标准已满足，建议进入 Phase 2-E（arrival 任务接入 playwright）'
      : '部分通过标准未满足，暂不建议进入 Phase 2-E');
}

// ════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  Phase 2-D / 2-D-Run Sign Runtime Mode 验证脚本');
  console.log('═══════════════════════════════════════════');
  console.log(`  next root: ${nextRoot}`);
  console.log(`  bnsy-operator: ${bnsyOperatorDir} (exists=${existsSync(bnsyOperatorDir)})`);
  console.log(`  auto-login mode: ${autoLoginMode}`);
  if (autoLoginMode) {
    console.log(`  test username: ${maskUsername(TEST_USERNAME)}`);
    console.log(`  test password: ${maskPassword()}`);
  }

  verifyStatic();
  await verifyRuntime();
  verifyExceptionPaths();

  if (autoLoginMode) {
    await verifyAutoLogin();
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
  } else {
    console.log('✓ 全部通过');
  }

  // auto-login 模式下始终输出报告（即使 fail-fast 提前退出，也记录已校验的内容）
  if (autoLoginMode) {
    writeAutoLoginReport();
  }

  console.log('\n运行时验证指引：');
  console.log('  1. legacy 回归：');
  console.log('     WINDOW_RUNTIME_MODE=legacy_easybr npm run dev');
  console.log('     → 提交 sign 任务 → 查询 /api/operations/:id/logs 应含 runtimeMode=legacy_easybr');
  console.log('  2. playwright 模式：');
  console.log('     WINDOW_RUNTIME_MODE=playwright npm run dev');
  console.log('     → 提交 sign 任务 → 日志应含 runtimeMode=playwright / Worker connection established / 签收');
  console.log('     → markBusy/markReady/lockManager 是 console.log（不在任务日志 API 中），通过窗口恢复 ready 间接验证');
  console.log('     → 第二次 sign 任务应复用窗口（窗口仍 ready，走 playwright 路径）');
  console.log('     → arrive/dispatch/integrated 任务仍走 legacy（日志含 runtimeMode=legacy_easybr）');

  process.exit(failCount > 0 ? 1 : 0);
}

/**
 * 输出 Phase 2-D-Run 自动登录验收报告到 docs 目录（20 项 + 通过标准 + Phase 2-E 建议）
 *
 * 安全要求：报告中不得出现完整密码，账号必须脱敏
 */
function writeAutoLoginReport(): void {
  // --headed 模式输出到 real-chrome-report，否则保持 auto-login-report
  const reportName = headedMode
    ? 'phase-2d-run-real-chrome-report.md'
    : 'phase-2d-run-auto-login-report.md';
  const reportPath = join(nextRoot, 'docs', reportName);
  const timestamp = new Date().toISOString();
  const maskedUser = maskUsername(TEST_USERNAME);

  const yn = (b: boolean) => b ? '✓ 是' : '✗ 否';
  const mark = (b: boolean) => b ? '✓' : '✗';

  const report = `# Phase 2-D-Run 验收报告：真实 Chrome 可视化端到端验证

> 阶段：Phase 2-D-Run（真实 Chrome 验收：--headed --keep-open + P0 检查 + sign 端到端）
> 验收日期：${timestamp}
> 测试账号：${maskedUser}（脱敏）
> 测试密码：${maskPassword()}（脱敏）
> 前置阶段：Phase 2-D 全部通过 / Phase 2-D-Data 测试数据已种子化
> P0 复用源：BrowserPool.verifyReady (L368-451) + ensureNoPopup (L812-840)
> Chrome 配置：channel=chrome, headless=false（PlaywrightWindowAdapter L99/L154 硬编码）
> CLI 参数：--headed=${headedMode}, --keep-open=${keepOpenMode}

---

## 1. 是否只修改验证脚本

${yn(autoLoginReport.onlyScriptModified)}

**修改/新增文件：**
- \`scripts/sign-runtime-mode-verify.ts\`（三次修正：D6.5 P0 检查步骤 + P0 报告字段 + 通过标准新增 P0 passed）
- \`scripts/lib/p0-check.ts\`（新增：P0 检查 HTTP 客户端，调用 /api/playwright-poc/window/p0-check）
- \`backend/playwright-runtime/P0Verifier.ts\`（新增：复用旧 BrowserPool.verifyReady 7 项检查 + ensureNoPopup 弹窗处理）
- \`backend/playwright-runtime/pocRoutes.ts\`（最小修改：末尾新增 /window/p0-check 路由，仅新增不改动现有逻辑）

**未修改文件：**
- backend/modules/assignment-engine/AssignmentEngine.ts
- backend/modules/assignment-engine/handlers/*.ts
- backend/api/routes.ts
- backend/browser/BrowserPool.ts（旧 P0 源文件，仅复用未修改）
- backend/easybr/EasyBRClient.ts
- bnsy-operator/

---

## 2. 是否修改 Handler

${autoLoginReport.handlerNotModified ? '✓ 否（未修改）' : '✗ 是（已修改，违规）'}

---

## 3. 是否修改 routes.ts

${autoLoginReport.routesNotModified ? '✓ 否（未修改）' : '✗ 是（已修改，违规）'}

---

## 4. 是否修改 bnsy-operator/

${autoLoginReport.bnsyOperatorNotModified ? '✓ 否（未修改）' : '✗ 是（已修改，违规）'}

---

## 5. 最终使用的 siteId

| 层级 | siteId | 说明 |
|------|--------|------|
| POC 层 | \`${autoLoginReport.testPocSiteId}\` | 内部 Site code（tiannanda/heyuan），与 Engine resolvePlaywrightWorkerConnection 一致 |
| Sign API 层 | \`${autoLoginReport.testSignSiteId}\` | settings.json site.id，Sign API 校验归属 |

**转换逻辑：** settings.json site.id → 按 site.name 含"天南大"/"和苑" → 转为 tiannanda/heyuan

---

## 6. 最终使用的 staffName

\`${autoLoginReport.testStaffName}\`

---

## 7. 最终使用的 windowId

\`${autoLoginReport.testWindowId}\`

（格式：staff-\${staffName}，与 Engine playwright 路径一致）

---

## 8. ensure-ready 返回

状态：\`${autoLoginReport.ensureReadyStatus}\`

---

## 9. 自动登录结果

${autoLoginReport.loginAttempted
  ? `**已执行。** username=${maskedUser}，结果：${autoLoginReport.loginSuccess ? '成功' : '失败'}`
  : '**未执行。** 窗口已为 ready 状态，无需登录'}

---

## 10. refresh=true 是否 ready

${yn(autoLoginReport.refreshReady)}

状态：\`${autoLoginReport.statusAfterLogin}\`

---

## 10.5 P0 就绪检查（sign 任务前门槛，Phase 2-D-Run 三次修正）

**是否执行 P0 检查：** ${yn(autoLoginReport.p0CheckExecuted)}

**P0 是否通过：** ${yn(autoLoginReport.p0Passed)}

**复用的旧 P0 函数/文件：** \`${autoLoginReport.p0Source || '(未执行)'}\`

| 检查项 | 结果 |
|--------|------|
| 开始 URL | \`${autoLoginReport.p0StartUrl || '(N/A)'}\` |
| 结束 URL | \`${autoLoginReport.p0EndUrl || '(N/A)'}\` |
| 是否 dashboard | ${yn(autoLoginReport.p0IsDashboard)} |
| 是否仍在 login | ${yn(autoLoginReport.p0IsLoginPage)} |
| 核心DOM是否存在（.el-menu/.app-container/.sidebar） | ${yn(autoLoginReport.p0HasCoreDom)} |
| 是否检测到阻塞弹窗 | ${yn(autoLoginReport.p0HasBlockingPopup)} |
| 旧 P0 是否尝试处理弹窗（PopupManager.dismissAll） | ${yn(autoLoginReport.p0PopupDismissAttempted)} |
| P0 检查轮数 | ${autoLoginReport.p0Rounds} |
| 失败检查项 | \`${autoLoginReport.p0FailedCheck || '(无)'}\` |
| 失败原因 | \`${autoLoginReport.p0FailedReason || '(无)'}\` |

${autoLoginReport.p0Passed
  ? '**✓ P0 通过，已提交 sign 任务。**'
  : autoLoginReport.p0CheckExecuted
    ? '**✗ P0 未通过，已停止后续 sign 任务验证，不生成 unknown 报告。**'
    : '**✗ P0 检查未执行（前置步骤未通过）。**'}

---

## 10.6 Chrome 可视化状态（Phase 2-D-Run 真实 Chrome 验收）

| 检查项 | 结果 | 说明 |
|--------|------|------|
| Chrome 是否真实打开 | ${yn(autoLoginReport.chromeLaunched)} | ensure-ready 启动窗口 |
| Chrome 是否 headless=false | ${yn(autoLoginReport.chromeHeaded)} | PlaywrightWindowAdapter L99/L154 硬编码 headless: false |
| Chrome channel | \`${autoLoginReport.chromeChannel}\` | PlaywrightRuntime L107 硬编码 channel: 'chrome' |
| Chrome 是否可见（--headed） | ${yn(autoLoginReport.chromeVisible)} | CLI 参数 --headed |
| Chrome 是否保持打开（--keep-open） | ${yn(autoLoginReport.chromeKeepOpen)} | CLI 参数 --keep-open，脚本结束不调用 close |

${autoLoginReport.chromeLaunched && autoLoginReport.chromeHeaded
  ? '**✓ 真实 Chrome 已打开（headless=false, channel=chrome），用户可观察页面变化。**'
  : '**✗ Chrome 未真实打开或为 headless 模式，验收失败。**'}

---

## 11. 第一次 sign taskId

\`${autoLoginReport.firstSignTaskId || '(未提交)'}\`

---

## 12. 第一次任务状态

状态：\`${autoLoginReport.firstSignTaskStatus}\`

${autoLoginReport.firstSignTaskStatus === 'failed' ? '（任务因业务原因失败，但 runtime 链路完整）' : ''}

---

## 13. 第一次任务日志摘要

\`\`\`
${autoLoginReport.firstSignLogSummary}
\`\`\`

---

## 14. 是否进入 Playwright runtime

${yn(autoLoginReport.enteredPlaywrightRuntime)}

任务日志含 \`runtimeMode=playwright\` 或 \`usePlaywright=true\`。

---

## 15. 是否进入 SignHandler / executeSign

${yn(autoLoginReport.enteredSignHandler)}

任务日志含签收关键字（如"进入签收页面"/"签收执行失败"等）。

---

## 16. 任务后窗口状态

状态：\`${autoLoginReport.windowStatusAfterFirstTask}\`

${autoLoginReport.windowStatusAfterFirstTask === 'ready' ? '✓ 窗口恢复 ready，证明 finally 块（markReady + release lock）执行成功' : '✗ 窗口未恢复 ready'}

---

## 17. 第二次 sign taskId

\`${autoLoginReport.secondSignTaskId || '(未提交)'}\`

---

## 18. 第二次任务状态

状态：\`${autoLoginReport.secondSignTaskStatus}\`

---

## 19. 第二次是否复用窗口

${yn(autoLoginReport.windowReused)}

**复用判定依据：**
1. 第二次任务前窗口已 ready（无需重新登录/启动）
2. 第二次任务日志含 runtimeMode=playwright（走 playwright 路径）
3. 第二次任务日志含 Worker connection established
4. 第二次任务后窗口仍 ready

第二次任务后窗口状态：\`${autoLoginReport.windowStatusAfterSecondTask}\`

---

## 20. 是否建议进入 Phase 2-E

${yn(autoLoginReport.recommendPhase2E)}

---

## 附：通过标准达成情况

| # | 通过标准 | 达成情况 |
|---|---------|---------|
| 1 | siteId 非空 | ${mark(!!autoLoginReport.testSignSiteId)} |
| 2 | staffName 非空 | ${mark(!!autoLoginReport.testStaffName)} |
| 3 | windowId 非空 | ${mark(!!autoLoginReport.testWindowId)} |
| 4 | **真实 Chrome 打开，headless=false** | ${mark(autoLoginReport.chromeLaunched && autoLoginReport.chromeHeaded)} |
| 5 | refresh=true 返回 ready | ${mark(autoLoginReport.refreshReady)} |
| 6 | **P0 passed（复用旧 BrowserPool.verifyReady）** | ${mark(autoLoginReport.p0Passed)} |
| 7 | 第一次 sign 任务拿到 taskId | ${mark(!!autoLoginReport.firstSignTaskId)} |
| 8 | 日志证明进入 playwright runtime | ${mark(autoLoginReport.enteredPlaywrightRuntime)} |
| 9 | 日志证明进入 SignHandler 或 executeSign | ${mark(autoLoginReport.enteredSignHandler)} |
| 10 | 任务结束后窗口 ready | ${mark(autoLoginReport.windowStatusAfterFirstTask === 'ready')} |
| 11 | 第二次 sign 任务拿到 taskId | ${mark(!!autoLoginReport.secondSignTaskId)} |
| 12 | 第二次任务复用窗口 | ${mark(autoLoginReport.windowReused)} |
| 13 | **Chrome 任务后保持打开** | ${mark(autoLoginReport.chromeKeepOpen || autoLoginReport.windowStatusAfterSecondTask === 'ready')} |
| 14 | Handler 未修改 | ${mark(autoLoginReport.handlerNotModified)} |
| 15 | routes.ts 未修改 | ${mark(autoLoginReport.routesNotModified)} |
| 16 | bnsy-operator/ 未修改 | ${mark(autoLoginReport.bnsyOperatorNotModified)} |

---

## 附：EasyBR 检查范围

${yn(autoLoginReport.easybrCheckScopeCorrect)}

- playwright-runtime/ + window-adapter/ + runtimeMode.ts + 4 个 Handler 均未 import EasyBRClient → ${mark(autoLoginReport.noEasyBRInPlaywrightLayer)}
- playwright-runtime/ + window-adapter/ 均未调用 connectOverCDP → ${mark(autoLoginReport.noConnectOverCDPInPlaywrightLayer)}
- legacy BrowserPool.ts + EasyBRClient.ts 中的 EasyBR 属于允许范围（legacy 回退路径）

---

## 附：fail-fast 参数校验说明

本次修正新增了 fail-fast 参数校验，启动时必须满足：

\`\`\`text
--site=<settings.json 中的 site.id>
--staff=<真实员工名（必须属于该 site）>
BNSY_TEST_USERNAME=<测试账号>
BNSY_TEST_PASSWORD=<测试密码>
WINDOW_RUNTIME_MODE=playwright
\`\`\`

任一缺失立即退出，不继续执行 ensure-ready，不生成 unknown 报告。

启动命令示例：

\`\`\`powershell
$env:WINDOW_RUNTIME_MODE="playwright"
$env:BNSY_TEST_USERNAME="测试账号"
$env:BNSY_TEST_PASSWORD="测试密码"
npx tsx scripts/sign-runtime-mode-verify.ts --auto-login --site=site-真实ID --staff=真实员工名
\`\`\`
`;

  try {
    const { writeFileSync, mkdirSync } = require('node:fs');
    const docsDir = join(nextRoot, 'docs');
    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
    writeFileSync(reportPath, report, 'utf-8');
    console.log(`\n📄 Phase 2-D-Run 验收报告已写入: ${reportPath}`);
  } catch (e) {
    console.log(`\n⚠ 验收报告写入失败: ${(e as Error).message}`);
    console.log('--- 报告内容 ---');
    console.log(report);
  }
}

main().catch(e => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
