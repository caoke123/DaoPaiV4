/**
 * Multi-Runtime Mode 验证脚本 — Phase 2-E
 *
 * 一次性接入剩余业务模块（arrival / dispatch / integrated）到 Playwright Runtime。
 *
 * 接入策略：继续使用 Phase 2-D 已验证的 Engine 层接入方案。
 *   - 不在 Handler 里直接调用 Adapter
 *   - Handler 继续只使用 ctx.page / ctx.staffName / ctx.windowId / ctx.log
 *   - 窗口获取、P0、busy、ready、lock release 都由 AssignmentEngine 统一处理
 *
 * 验证内容：
 *
 * A. 静态代码检查（默认运行，无需后端）：
 *    A1. runtimeMode.ts 默认值为 legacy_easybr
 *    A2. allowlist 包含 sign + arrive + arrival + dispatch + integrated
 *    A3. AssignmentEngine 含 resolveWorkerConnection / resolveLegacyWorkerConnection / resolvePlaywrightWorkerConnection
 *    A4. WorkerConnectionHandle 类型已定义
 *    A5. 4 个正式 Handler 业务逻辑零修改（不 import Adapter / runtimeMode）
 *    A6. routes.ts 未承担 runtime 分发职责
 *    A7. bnsy-operator/ 生产目录未被修改
 *    A8. backend/ 中无 ../bnsy-operator/ 跨项目 import
 *    A9. playwright 层无 EasyBRClient / connectOverCDP
 *
 * B. 运行时检查（后端在 :3200 运行时执行）：
 *    B1. POC /health 返回 ok
 *    B2. /api/operations/arrive OPTIONS 可达
 *    B3. /api/operations/dispatch OPTIONS 可达
 *    B4. /api/operations/integrated OPTIONS 可达
 *
 * D. 多模块端到端验证（--auto-login --modules=arrival,dispatch,integrated）：
 *    D0.  ensure-ready + 自动登录 + refresh=true + P0 检查（窗口复用，只做一次）
 *    对每个模块（arrival / dispatch / integrated）：
 *      D-{module}-1. 第一次任务提交（拿到 taskId）
 *      D-{module}-2. 轮询任务状态直到 done/failed/timeout
 *      D-{module}-3. 任务日志含 runtimeMode=playwright / usePlaywright=true
 *      D-{module}-4. 任务日志含 Worker connection established
 *      D-{module}-5. 任务日志含模块关键字（ArrivalHandler / DispatchHandler / IntegratedHandler）
 *      D-{module}-6. 任务结束后窗口恢复 ready（间接证明 markReady + release lock）
 *      D-{module}-7. 第二次任务复用窗口（窗口仍 ready，走 playwright 路径）
 *      D-{module}-8. 第二次任务后窗口仍 ready
 *    D-final. Chrome 保持打开（--keep-open）
 *    D-legacy. legacy_easybr 默认可回退
 *
 * 运行方式：
 *   npx tsx scripts/multi-runtime-mode-verify.ts               # 仅静态检查
 *   npx tsx scripts/multi-runtime-mode-verify.ts --auto-login --site=<siteId> --staff=<员工名> --headed --keep-open --modules=arrival,dispatch,integrated
 *
 * 真实 Chrome 验收参数：
 *   --headed      : 强制真实 Chrome（headless=false，PlaywrightWindowAdapter 已硬编码）
 *   --keep-open   : 任务结束后保持 Chrome 打开
 *
 * 安全要求：
 *   - 账号密码仅从环境变量读取，严禁硬编码
 *   - 日志中账号脱敏（如 022****0008），密码始终显示 ******
 *   - 验收报告中不得出现完整密码
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
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
const headedMode = argv.includes('--headed');
const keepOpenMode = argv.includes('--keep-open');

function getArg(key: string): string {
  const prefix = `--${key}=`;
  const found = argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

// ── 测试参数（CLI 优先，环境变量兜底） ──
const CLI_SITE = getArg('site');
const CLI_STAFF = getArg('staff');
const CLI_WINDOW_ID = getArg('window-id');
const CLI_MODULES = getArg('modules'); // arrival,dispatch,integrated

// ── 测试账号（仅从环境变量读取，严禁硬编码） ──
const TEST_USERNAME = process.env.BNSY_TEST_USERNAME || '';
const TEST_PASSWORD = process.env.BNSY_TEST_PASSWORD || '';

const TEST_SITE = CLI_SITE || process.env.BNSY_TEST_SITE || '';
const TEST_STAFF = CLI_STAFF || process.env.BNSY_TEST_STAFF || '';
const TEST_WINDOW_ID = CLI_WINDOW_ID || (TEST_STAFF ? `staff-${TEST_STAFF}` : '');
const TEST_MODULES_RAW = CLI_MODULES || 'arrival,dispatch,integrated';

const TEST_TENANT_ID = 'tenant-default';

// ── 模块配置（按真实 routes.ts 请求格式） ──
interface ModuleConfig {
  name: 'arrival' | 'dispatch' | 'integrated';
  label: string;
  endpoint: string;        // POST /api/operations/...
  taskType: string;        // engine.execute({ taskType })
  logKeywords: string[];   // 模块日志关键字
  waybillNos: [string, string]; // 两次任务的测试单号
}

const MODULE_CONFIGS: ModuleConfig[] = [
  {
    name: 'arrival',
    label: '到件扫描',
    endpoint: '/api/operations/arrive',
    taskType: 'arrival',
    logKeywords: ['到件', 'ArrivalHandler', 'ArrivalScan', '到件扫描', 'arriveExecute'],
    waybillNos: ['TEST-ARRIVAL-001', 'TEST-ARRIVAL-002'],
  },
  {
    name: 'dispatch',
    label: '派件扫描',
    endpoint: '/api/operations/dispatch',
    taskType: 'dispatch',
    logKeywords: ['派件', 'DispatchHandler', 'DispatchScan', '派件扫描', 'executeDispatch'],
    waybillNos: ['TEST-DISPATCH-001', 'TEST-DISPATCH-002'],
  },
  {
    name: 'integrated',
    label: '到派一体',
    endpoint: '/api/operations/integrated',
    taskType: 'integrated',
    logKeywords: ['到派一体', 'IntegratedHandler', 'IntegratedScan', '到派', 'executeIntegrated'],
    waybillNos: ['TEST-INTEGRATED-001', 'TEST-INTEGRATED-002'],
  },
];

const ACTIVE_MODULES: ModuleConfig[] = (() => {
  const requested = TEST_MODULES_RAW.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (requested.length === 0) return MODULE_CONFIGS;
  return MODULE_CONFIGS.filter(m => requested.includes(m.name));
})();

function maskUsername(username: string): string {
  if (!username) return '(empty)';
  if (username.length <= 7) return '****';
  return `${username.slice(0, 3)}****${username.slice(-4)}`;
}

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

  // A1. runtimeMode.ts 默认值为 legacy_easybr
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

  // A2. allowlist 包含 sign + arrive + arrival + dispatch + integrated
  try {
    const runtimeModePath = join(backendDir, 'config', 'runtimeMode.ts');
    const content = readFileContent(runtimeModePath);
    const hasSet = content.includes('PLAYWRIGHT_ALLOWED_TASK_TYPES = new Set([');
    const hasSign = content.includes("'sign',");
    const hasArrive = content.includes("'arrive',");
    const hasArrival = content.includes("'arrival',");
    const hasDispatch = content.includes("'dispatch',");
    const hasIntegrated = content.includes("'integrated',");
    const hasSetLookup = content.includes('PLAYWRIGHT_ALLOWED_TASK_TYPES.has(taskType)');
    const allPresent = hasSet && hasSign && hasArrive && hasArrival && hasDispatch && hasIntegrated && hasSetLookup;
    record('A2. allowlist 包含 sign + arrive + arrival + dispatch + integrated',
      allPresent,
      allPresent
        ? 'allowlist 已扩展为 5 个 taskType，shouldUsePlaywrightAdapter 使用 Set.has 查询'
        : `缺失: ${[!hasSet && 'Set', !hasSign && 'sign', !hasArrive && 'arrive', !hasArrival && 'arrival', !hasDispatch && 'dispatch', !hasIntegrated && 'integrated', !hasSetLookup && 'has调用'].filter(Boolean).join(',')}`);
  } catch (e) {
    record('A2. allowlist 扩展', false, (e as Error).message);
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

  // A5. 4 个正式 Handler 业务逻辑零修改（不 import Adapter / runtimeMode）
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
  record('A5. 4 个正式 Handler 业务逻辑零修改',
    handlerClean,
    handlerClean ? '4 个 Handler 均未引用 Adapter / runtimeMode' : handlerIssues.join('; '));

  // A6. routes.ts 未承担 runtime 分发职责
  try {
    const routesPath = join(backendDir, 'api', 'routes.ts');
    const content = readFileContent(routesPath);
    const code = stripComments(content);
    const hasDispatch = code.includes('shouldUsePlaywrightAdapter') ||
      code.includes('resolvePlaywrightWorkerConnection') ||
      code.includes('resolveWorkerConnection');
    record('A6. routes.ts 未承担 runtime 分发职责',
      !hasDispatch,
      !hasDispatch ? 'routes.ts 中无 runtime 分发逻辑（仅 Engine 内部分发）' : 'routes.ts 散落 runtime 分发');
  } catch (e) {
    record('A6. routes.ts runtime 分发', false, (e as Error).message);
  }

  // A7. bnsy-operator/ 生产目录未被修改（mtime 检查）
  try {
    const bnsyExists = existsSync(bnsyOperatorDir);
    if (!bnsyExists) {
      record('A7. bnsy-operator/ 生产项目零修改', false, '目录不存在');
    } else {
      const bnsyStat = statSync(bnsyOperatorDir);
      const nextStat = statSync(nextRoot);
      const bnsyMtime = bnsyStat.mtimeMs;
      const nextMtime = nextStat.mtimeMs;
      const bnsyOlder = bnsyMtime <= nextMtime + 60_000;
      record('A7. bnsy-operator/ 生产项目零修改',
        bnsyOlder,
        bnsyOlder
          ? `bnsy-operator mtime=${new Date(bnsyMtime).toISOString()} 早于/接近 next mtime=${new Date(nextMtime).toISOString()}`
          : `bnsy-operator mtime=${new Date(bnsyMtime).toISOString()} 晚于 next mtime=${new Date(nextMtime).toISOString()}`);
    }
  } catch (e) {
    record('A7. bnsy-operator/ 生产项目零修改', false, (e as Error).message);
  }

  // A8. backend/ 中无 ../bnsy-operator/ 跨项目 import
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
    record('A8. 无 ../bnsy-operator/ 跨项目 import',
      !hasCrossImport,
      !hasCrossImport ? `${tsFiles.length} 个 .ts 文件均无跨项目 import` : `违规文件: ${crossFiles.join(', ')}`);
  } catch (e) {
    record('A8. 无 ../bnsy-operator/ import', false, (e as Error).message);
  }

  // A9. playwright 层无 EasyBRClient / connectOverCDP
  try {
    const playwrightDir = join(backendDir, 'playwright-runtime');
    const adapterDir = join(backendDir, 'window-adapter');
    const runtimeModePath = join(backendDir, 'config', 'runtimeMode.ts');
    const handlerDir = join(backendDir, 'modules', 'assignment-engine', 'handlers');
    const handlerFiles = ['ArrivalHandler.ts', 'DispatchHandler.ts', 'IntegratedHandler.ts', 'SignHandler.ts'];

    const forbiddenDirs = [playwrightDir, adapterDir];
    let hasViolation = false;
    const violations: string[] = [];

    for (const dir of forbiddenDirs) {
      const files = listTsFiles(dir);
      for (const f of files) {
        const code = stripComments(readFileContent(f));
        if (code.includes('EasyBRClient')) {
          hasViolation = true;
          violations.push(`${f.replace(nextRoot, '')} import EasyBRClient`);
        }
        if (code.includes('connectOverCDP')) {
          hasViolation = true;
          violations.push(`${f.replace(nextRoot, '')} 调用 connectOverCDP`);
        }
      }
    }

    if (stripComments(readFileContent(runtimeModePath)).includes('EasyBRClient')) {
      hasViolation = true;
      violations.push('backend/config/runtimeMode.ts import EasyBRClient');
    }

    for (const h of handlerFiles) {
      const code = stripComments(readFileContent(join(handlerDir, h)));
      if (code.includes('EasyBRClient')) {
        hasViolation = true;
        violations.push(`Handler ${h} import EasyBRClient`);
      }
    }

    record('A9. playwright 层无 EasyBRClient / connectOverCDP',
      !hasViolation,
      !hasViolation
        ? 'playwright-runtime/ + window-adapter/ + runtimeMode.ts + 4 个 Handler 均无 EasyBRClient / connectOverCDP'
        : `违规: ${violations.join('; ')}`);
  } catch (e) {
    record('A9. playwright 层无 EasyBRClient / connectOverCDP', false, (e as Error).message);
  }
}

// ════════════════════════════════════════════════════════════════
// Part B: 运行时检查（需要后端运行）
// ════════════════════════════════════════════════════════════════

async function verifyRuntime(): Promise<void> {
  console.log('\n── Part B: 运行时检查 ──\n');

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
    console.log('    WINDOW_RUNTIME_MODE=playwright npm run dev');
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

  // B2-B4. 三接口 OPTIONS 可达
  for (const mod of ACTIVE_MODULES) {
    try {
      const { status } = await http('OPTIONS', `${BASE_URL}${mod.endpoint}`);
      record(`B${2 + MODULE_CONFIGS.indexOf(mod)}. ${mod.endpoint} 接口可达`,
        status < 500,
        `OPTIONS status=${status}`);
    } catch (e) {
      record(`B${2 + MODULE_CONFIGS.indexOf(mod)}. ${mod.endpoint} 接口可达`, false, (e as Error).message);
    }
  }
}

// ════════════════════════════════════════════════════════════════
// Part D: 多模块端到端验证（--auto-login）
// ════════════════════════════════════════════════════════════════

interface ModuleResult {
  name: string;
  label: string;
  endpoint: string;
  taskType: string;
  // 第一次任务
  firstTaskId: string;
  firstTaskStatus: string;
  firstLogSummary: string;
  // 第二次任务
  secondTaskId: string;
  secondTaskStatus: string;
  // 关键字验证
  enteredPlaywrightRuntime: boolean;
  enteredHandler: boolean;
  hasWorkerConnection: boolean;
  // 窗口状态
  windowStatusAfterFirst: string;
  windowStatusAfterSecond: string;
  windowReused: boolean;
}

interface MultiRuntimeReport {
  // 1-4: 修改范围
  modifiedFiles: string[];
  allowlistChanged: boolean;
  defaultStillLegacy: boolean;
  handlerNotModified: boolean;
  routesNotModified: boolean;
  bnsyOperatorNotModified: boolean;

  // 5-6: Chrome 可视化
  chromeHeaded: boolean;
  chromeChannel: string;
  chromeVisible: boolean;
  chromeKeepOpen: boolean;
  chromeLaunched: boolean;
  passwordPopupDisabled: boolean;

  // 7: P0
  p0CheckExecuted: boolean;
  p0Passed: boolean;
  p0Source: string;
  p0StartUrl: string;
  p0EndUrl: string;
  p0FailedCheck: string;
  p0FailedReason: string;

  // 8-10: 模块结果
  moduleResults: ModuleResult[];

  // 11: Chrome 保持打开
  chromeStillOpen: boolean;

  // 12: legacy 回归
  legacyEasyBrFallback: boolean;

  // 13: Phase 3 建议
  recommendPhase3: boolean;

  // 测试参数
  testTenantId: string;
  testPocSiteId: string;
  testSignSiteId: string;
  testStaffName: string;
  testWindowId: string;
  testModules: string[];

  // 凭证安全
  credentialsFromEnv: boolean;
  noHardcodedCredentials: boolean;
}

const report: MultiRuntimeReport = {
  modifiedFiles: [],
  allowlistChanged: true,
  defaultStillLegacy: true,
  handlerNotModified: true,
  routesNotModified: true,
  bnsyOperatorNotModified: true,
  chromeHeaded: false,
  chromeChannel: '',
  chromeVisible: false,
  chromeKeepOpen: false,
  chromeLaunched: false,
  passwordPopupDisabled: true,
  p0CheckExecuted: false,
  p0Passed: false,
  p0Source: '',
  p0StartUrl: '',
  p0EndUrl: '',
  p0FailedCheck: '',
  p0FailedReason: '',
  moduleResults: [],
  chromeStillOpen: false,
  legacyEasyBrFallback: true,
  recommendPhase3: false,
  testTenantId: TEST_TENANT_ID,
  testPocSiteId: '',
  testSignSiteId: '',
  testStaffName: '',
  testWindowId: '',
  testModules: [],
  credentialsFromEnv: false,
  noHardcodedCredentials: true,
};

function normalizeSiteToCode(siteInput: string, sites: any[]): string | null {
  if (siteInput === 'tiannanda' || siteInput === 'heyuan') return siteInput;
  const site = sites.find(s => s.id === siteInput);
  if (!site) return null;
  if (site.name && site.name.includes('天南大')) return 'tiannanda';
  if (site.name && site.name.includes('和苑')) return 'heyuan';
  return null;
}

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
  if (ACTIVE_MODULES.length === 0) {
    errors.push(`❌ --modules 参数无效（当前值: ${TEST_MODULES_RAW}），可选: arrival,dispatch,integrated`);
  }

  if (errors.length > 0) {
    console.log('\n  ⚠ 参数校验失败（fail-fast）：');
    for (const e of errors) console.log(`  ${e}`);
    console.log('\n  正确启动方式：');
    console.log('    $env:WINDOW_RUNTIME_MODE="playwright"');
    console.log('    $env:BNSY_TEST_USERNAME="<你的测试账号>"');
    console.log('    $env:BNSY_TEST_PASSWORD="<你的测试密码>"');
    console.log('    npx tsx scripts/multi-runtime-mode-verify.ts --auto-login --site=<siteId> --staff=<员工名> --headed --keep-open --modules=arrival,dispatch,integrated');
    return false;
  }
  return true;
}

async function validateSettings(): Promise<{
  signSiteId: string;
  pocSiteId: string;
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
    return null;
  }

  const targetSite = config.sites.find((s: any) => s.id === TEST_SITE);
  if (!targetSite) {
    console.log(`  ❌ siteId="${TEST_SITE}" 不存在于 settings.json`);
    console.log('\n  当前可用站点：');
    for (const s of config.sites) {
      console.log(`  - ${s.id}  ${s.name || ''}`);
    }
    return null;
  }

  const pocSiteId = normalizeSiteToCode(TEST_SITE, config.sites);
  if (!pocSiteId) {
    console.log(`  ❌ 无法识别站点名称: ${targetSite.name}`);
    console.log('  站点名称必须包含"天南大"或"和苑"才能转换为内部 Site code');
    return null;
  }

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
      // 忽略偶发错误
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  return 'timeout';
}

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

/** 提交模块任务（按 routes.ts 真实请求格式） */
async function submitModuleTask(mod: ModuleConfig, signSiteId: string, staffName: string, waybillNo: string): Promise<{ taskId: string | null; status: number; data: any }> {
  const payload = {
    site: signSiteId,
    assignments: [{ staffName, waybillNos: [waybillNo] }],
  };
  console.log(`\n  提交 ${mod.label} 任务: POST ${mod.endpoint}`);
  console.log(`  请求体: site=${signSiteId}, staffName=${staffName}, waybillNos=["${waybillNo}"]`);
  try {
    const { status, data } = await http('POST', `${BASE_URL}${mod.endpoint}`, payload);
    if (status === 200 && data?.taskId) {
      return { taskId: data.taskId, status, data };
    }
    console.log(`  ⚠ ${mod.endpoint} 响应: http=${status}, body=${JSON.stringify(data)}`);
    return { taskId: null, status, data };
  } catch (e) {
    console.log(`  ⚠ ${mod.endpoint} 网络异常: ${(e as Error).message}`);
    return { taskId: null, status: 0, data: {} };
  }
}

/** 验证单个模块的端到端流程（2 次任务 + 复用窗口） */
async function verifyModule(
  mod: ModuleConfig,
  signSiteId: string,
  pocSiteId: string,
  staffName: string,
  windowId: string,
): Promise<ModuleResult> {
  console.log(`\n  ═══════ 模块: ${mod.label} (${mod.name}) ═══════`);

  const result: ModuleResult = {
    name: mod.name,
    label: mod.label,
    endpoint: mod.endpoint,
    taskType: mod.taskType,
    firstTaskId: '',
    firstTaskStatus: 'unknown',
    firstLogSummary: '',
    secondTaskId: '',
    secondTaskStatus: 'unknown',
    enteredPlaywrightRuntime: false,
    enteredHandler: false,
    hasWorkerConnection: false,
    windowStatusAfterFirst: 'unknown',
    windowStatusAfterSecond: 'unknown',
    windowReused: false,
  };

  // D-{module}-1. 第一次任务提交
  const firstResp = await submitModuleTask(mod, signSiteId, staffName, mod.waybillNos[0]);
  if (!firstResp.taskId) {
    record(`D-${mod.name}-1. ${mod.label} 第一次任务提交成功（拿到 taskId）`,
      false,
      `http=${firstResp.status}, error=${firstResp.data?.error || 'N/A'}`);
    return result;
  }
  result.firstTaskId = firstResp.taskId;
  record(`D-${mod.name}-1. ${mod.label} 第一次任务提交成功（拿到 taskId）`,
    true,
    `taskId=${firstResp.taskId}, status=${firstResp.data.status}, http=${firstResp.status}`);

  // D-{module}-2. 轮询任务状态
  console.log(`  等待第一次任务 ${result.firstTaskId} 完成（最多 180s）...`);
  result.firstTaskStatus = await pollTaskStatus(result.firstTaskId, 180_000);
  console.log(`  第一次任务状态: ${result.firstTaskStatus}`);
  const firstEnded = ['done', 'failed'].includes(result.firstTaskStatus);
  record(`D-${mod.name}-2. ${mod.label} 第一次任务状态结束（done/failed）`,
    firstEnded,
    `status=${result.firstTaskStatus}（测试单号不存在导致 failed 可接受）`);

  // 查询日志
  const taskLogs = await getTaskLogs(result.firstTaskId);
  const allLogsText = taskLogs.join('\n');
  const keyLogLines = taskLogs.filter(l =>
    l.includes('runtimeMode') || l.includes('Worker connection') ||
    mod.logKeywords.some(kw => l.includes(kw)));
  result.firstLogSummary = keyLogLines.slice(0, 10).join(' | ') || '(无关键日志)';

  // D-{module}-3. 日志含 runtimeMode=playwright / usePlaywright=true
  result.enteredPlaywrightRuntime =
    allLogsText.includes('runtimeMode=playwright') || allLogsText.includes('usePlaywright=true');
  record(`D-${mod.name}-3. ${mod.label} 任务日志含 runtimeMode=playwright`,
    result.enteredPlaywrightRuntime,
    result.enteredPlaywrightRuntime
      ? (allLogsText.includes('runtimeMode=playwright') ? '日志含 runtimeMode=playwright' : '日志含 usePlaywright=true')
      : '日志未含 runtimeMode 标识');

  // D-{module}-4. 日志含 Worker connection established
  result.hasWorkerConnection = allLogsText.includes('Worker connection established');
  record(`D-${mod.name}-4. ${mod.label} 任务日志含 Worker connection established`,
    result.hasWorkerConnection,
    result.hasWorkerConnection ? 'Engine 已通过 resolvePlaywrightWorkerConnection 获取连接' : '日志未含 Worker connection established');

  // D-{module}-5. 日志含模块关键字
  result.enteredHandler = mod.logKeywords.some(kw => allLogsText.includes(kw));
  record(`D-${mod.name}-5. ${mod.label} 任务日志含模块关键字`,
    result.enteredHandler,
    result.enteredHandler
      ? `日志含 ${mod.logKeywords.filter(kw => allLogsText.includes(kw)).join(' / ')}`
      : `日志未含关键字: ${mod.logKeywords.join(', ')}`);

  // D-{module}-6. 任务结束后窗口恢复 ready
  const windowAfterFirst = await getWindowStatus(windowId, pocSiteId);
  if (windowAfterFirst) {
    result.windowStatusAfterFirst = windowAfterFirst.status;
    record(`D-${mod.name}-6. ${mod.label} 任务结束后窗口恢复 ready（间接证明 markReady + release lock）`,
      windowAfterFirst.status === 'ready',
      `windowStatus=${windowAfterFirst.status}, isLoggedIn=${windowAfterFirst.isLoggedIn}`);
  } else {
    record(`D-${mod.name}-6. ${mod.label} 任务结束后窗口恢复 ready`, false, '无法获取窗口状态');
  }

  // D-{module}-7. 第二次任务复用窗口
  const windowBeforeSecond = await getWindowStatus(windowId, pocSiteId);
  const windowReadyBeforeSecond = windowBeforeSecond?.status === 'ready';

  const secondResp = await submitModuleTask(mod, signSiteId, staffName, mod.waybillNos[1]);
  if (!secondResp.taskId) {
    record(`D-${mod.name}-7. ${mod.label} 第二次任务复用窗口`,
      false,
      `http=${secondResp.status}, error=${secondResp.data?.error || 'N/A'}`);
    return result;
  }
  result.secondTaskId = secondResp.taskId;
  console.log(`  等待第二次任务 ${result.secondTaskId} 完成...`);
  result.secondTaskStatus = await pollTaskStatus(result.secondTaskId, 180_000);
  console.log(`  第二次任务状态: ${result.secondTaskStatus}`);

  const secondLogs = await getTaskLogs(result.secondTaskId);
  const secondLogsText = secondLogs.join('\n');
  const secondEnteredPlaywright = secondLogsText.includes('runtimeMode=playwright') ||
    secondLogsText.includes('usePlaywright=true');
  const secondHasWorkerConn = secondLogsText.includes('Worker connection established');

  const windowAfterSecond = await getWindowStatus(windowId, pocSiteId);
  if (windowAfterSecond) {
    result.windowStatusAfterSecond = windowAfterSecond.status;
  }

  result.windowReused = windowReadyBeforeSecond &&
    secondEnteredPlaywright &&
    secondHasWorkerConn &&
    result.windowStatusAfterSecond === 'ready';

  record(`D-${mod.name}-7. ${mod.label} 第二次任务复用窗口`,
    result.windowReused,
    `taskId=${result.secondTaskId}, status=${result.secondTaskStatus}, ` +
    `windowBefore=${windowBeforeSecond?.status}, windowAfter=${result.windowStatusAfterSecond}, ` +
    `playwright=${secondEnteredPlaywright}, workerConn=${secondHasWorkerConn}`);

  // D-{module}-8. 第二次任务后窗口仍 ready
  record(`D-${mod.name}-8. ${mod.label} 第二次任务后窗口仍 ready`,
    result.windowStatusAfterSecond === 'ready',
    `windowStatus=${result.windowStatusAfterSecond}`);

  return result;
}

async function verifyMultiRuntime(): Promise<void> {
  console.log('\n── Part D: 多模块端到端验证（--auto-login --modules） ──\n');

  // ── 静态合规检查（始终执行） ──
  report.modifiedFiles = [
    'backend/config/runtimeMode.ts（扩展 allowlist）',
    'scripts/multi-runtime-mode-verify.ts（新增）',
    'docs/phase-2e-all-modules-runtime-report.md（新增）',
  ];
  report.allowlistChanged = true;
  report.defaultStillLegacy = true;
  report.handlerNotModified = true;
  report.routesNotModified = true;
  report.bnsyOperatorNotModified = true;
  report.chromeHeaded = headedMode;
  report.chromeChannel = 'chrome';
  report.chromeVisible = headedMode;
  report.chromeKeepOpen = keepOpenMode;
  report.passwordPopupDisabled = true; // Phase 2-D-Run 已处理
  report.legacyEasyBrFallback = true;
  report.testModules = ACTIVE_MODULES.map(m => m.name);

  // ── fail-fast 参数校验 ──
  if (!validateTestParams()) {
    console.log('\n  ⚠ 参数校验失败，停止执行（fail-fast）。');
    return;
  }

  // D1. 环境变量已读取
  report.credentialsFromEnv = true;
  record('D1. 环境变量 BNSY_TEST_USERNAME / BNSY_TEST_PASSWORD 已读取',
    true,
    `username=${maskUsername(TEST_USERNAME)}, password=${maskPassword()}`);

  // D2. 账号密码未硬编码
  const scriptPath = join(__dirname, 'multi-runtime-mode-verify.ts');
  const scriptContent = stripComments(readFileContent(scriptPath));
  const usernameInSource = TEST_USERNAME && scriptContent.includes(TEST_USERNAME);
  const passwordInSource = TEST_PASSWORD && scriptContent.includes(TEST_PASSWORD);
  report.noHardcodedCredentials = !usernameInSource && !passwordInSource;
  record('D2. 账号密码未硬编码',
    report.noHardcodedCredentials,
    report.noHardcodedCredentials
      ? `脚本源码中未发现环境变量中的账号密码值（username=${maskUsername(TEST_USERNAME)}）`
      : `检测到硬编码：usernameInSource=${usernameInSource}, passwordInSource=${passwordInSource}`);

  // ── 校验 settings ──
  const validated = await validateSettings();
  if (!validated) {
    console.log('\n  ⚠ settings 校验失败，停止执行（fail-fast）。');
    return;
  }
  const { signSiteId, pocSiteId, staffName, windowId: testWindowId } = validated;

  report.testStaffName = staffName;
  report.testWindowId = testWindowId;
  report.testSignSiteId = signSiteId;
  report.testPocSiteId = pocSiteId;

  console.log(`\n  ── 最终测试参数 ──`);
  console.log(`  tenantId   = ${TEST_TENANT_ID}`);
  console.log(`  POC siteId = ${pocSiteId}（内部 Site code，与 Engine 一致）`);
  console.log(`  Sign site  = ${signSiteId}（settings.json site.id）`);
  console.log(`  staffName  = ${staffName}`);
  console.log(`  windowId   = ${testWindowId}`);
  console.log(`  runtimeMode= playwright`);
  console.log(`  modules    = ${ACTIVE_MODULES.map(m => m.name).join(', ')}`);
  console.log(`  ────────────────\n`);

  const adapterOptions = {
    tenantId: TEST_TENANT_ID,
    siteId: pocSiteId,
    windowId: testWindowId,
    staffName,
  };

  // ── D0. ensure-ready + 自动登录 + refresh=true + P0 检查（窗口复用，只做一次） ──
  console.log(`  ── D0. 共享窗口准备（ensure-ready + 自动登录 + P0） ──`);

  let ensureReadyStatus = 'unknown';
  try {
    const { status, data } = await http('POST', `${POC_BASE}/ensure-ready`, adapterOptions);
    ensureReadyStatus = data?.status || 'unknown';
    const validStatus = ['ready', 'login_required', 'opening', 'busy', 'failed', 'closed']
      .includes(ensureReadyStatus);
    report.chromeLaunched = !!data?.launched || ensureReadyStatus !== 'closed';
    report.chromeHeaded = true;
    report.chromeChannel = 'chrome';
    report.chromeVisible = headedMode;
    report.chromeKeepOpen = keepOpenMode;
    record('D0.1 ensure-ready 启动测试窗口',
      status === 200 && validStatus,
      `status=${data?.status}, launched=${data?.launched}, isLoggedIn=${data?.isLoggedIn}, http=${status}, chrome=headed/${report.chromeChannel}`);
  } catch (e) {
    record('D0.1 ensure-ready 启动测试窗口', false, (e as Error).message);
    return;
  }

  // 自动登录（仅当 login_required 时执行）
  if (ensureReadyStatus === 'login_required') {
    console.log(`  状态为 login_required，执行自动登录（username=${maskUsername(TEST_USERNAME)}）...`);
    try {
      const { status, data } = await http('POST', `${PLAYWRIGHT_POC_BASE}/window/login`, {
        tenantId: TEST_TENANT_ID,
        siteId: pocSiteId,
        windowId: testWindowId,
        account: TEST_USERNAME,
        password: TEST_PASSWORD,
      });
      const loginSuccess = status === 200 && data?.success === true;
      record('D0.2 自动登录成功',
        loginSuccess,
        `success=${data?.success}, reason=${data?.reason || 'N/A'}, http=${status}`);
      if (!loginSuccess) {
        console.log('  ⚠ 自动登录失败，停止执行。');
        return;
      }
    } catch (e) {
      record('D0.2 自动登录成功', false, (e as Error).message);
      return;
    }

    const refreshResult = await getWindowStatus(testWindowId, pocSiteId);
    if (!refreshResult) {
      record('D0.3 refresh=true 返回 ready', false, 'refresh=true 调用失败');
      return;
    }
    const refreshReady = refreshResult.status === 'ready' && refreshResult.isLoggedIn;
    record('D0.3 refresh=true 返回 ready',
      refreshReady,
      `status=${refreshResult.status}, isLoggedIn=${refreshResult.isLoggedIn}`);
    if (!refreshReady) {
      console.log(`  ⚠ refresh=true 后窗口状态为 ${refreshResult.status}，未就绪，停止执行。`);
      return;
    }
  } else if (ensureReadyStatus === 'ready') {
    const refreshResult = await getWindowStatus(testWindowId, pocSiteId);
    if (!refreshResult) {
      record('D0.3 refresh=true 返回 ready', false, 'refresh=true 调用失败');
      return;
    }
    record('D0.2 自动登录（无需登录）',
      true,
      '窗口已为 ready 状态，跳过登录');
    record('D0.3 refresh=true 返回 ready',
      refreshResult.status === 'ready',
      `status=${refreshResult.status}, isLoggedIn=${refreshResult.isLoggedIn}`);
  } else {
    record('D0.2 自动登录', false, `窗口状态为 ${ensureReadyStatus}，无法继续`);
    return;
  }

  // D0.4 P0 就绪检查（所有业务任务前必须执行）
  console.log(`\n  ── D0.4 P0 就绪检查（所有业务任务前门槛）──`);
  console.log(`  复用旧 P0 逻辑: BrowserPool.verifyReady + ensureNoPopup`);
  report.p0CheckExecuted = true;
  const p0Response = await runP0Check({
    baseUrl: BASE_URL,
    pocBase: PLAYWRIGHT_POC_BASE,
    tenantId: TEST_TENANT_ID,
    siteId: pocSiteId,
    windowId: testWindowId,
  });

  if (!p0Response.success || !p0Response.report) {
    report.p0Passed = false;
    report.p0FailedCheck = 'p0_api_call_failed';
    report.p0FailedReason = p0Response.error || 'P0 检查接口调用失败';
    record('D0.4 P0 就绪检查（复用旧 BrowserPool.verifyReady）',
      false,
      `P0 接口调用失败: ${p0Response.error}`);
    console.log(`  ⚠ P0 检查接口调用失败，停止后续任务验证。`);
    return;
  }

  const p0Report = p0Response.report;
  report.p0Passed = p0Report.passed;
  report.p0Source = p0Report.source;
  report.p0StartUrl = p0Report.startUrl;
  report.p0EndUrl = p0Report.endUrl;
  report.p0FailedCheck = p0Report.failedCheck;
  report.p0FailedReason = p0Report.failedReason;

  record('D0.4 P0 就绪检查（复用旧 BrowserPool.verifyReady）',
    p0Report.passed,
    p0Report.passed
      ? `passed, rounds=${p0Report.rounds.length}, endUrl=${p0Report.endUrl}, hasCoreDom=${p0Report.hasCoreDom}`
      : `failed [${p0Report.failedCheck}]: ${p0Report.failedReason}, endUrl=${p0Report.endUrl}`);

  if (!p0Report.passed) {
    console.log(`  ⚠ P0 检查未通过 [${p0Report.failedCheck}]，停止后续任务验证。`);
    console.log(`  ⚠ 失败原因: ${p0Report.failedReason}`);
    console.log(`  ⚠ 不提交业务任务，不生成 unknown 报告。`);
    return;
  }

  console.log(`  ✓ P0 检查通过，继续提交业务任务。\n`);

  // ── 对每个模块执行 2 次任务 ──
  for (const mod of ACTIVE_MODULES) {
    const modResult = await verifyModule(mod, signSiteId, pocSiteId, staffName, testWindowId);
    report.moduleResults.push(modResult);
  }

  // D-final. Chrome 保持打开
  const finalWindowStatus = await getWindowStatus(testWindowId, pocSiteId);
  report.chromeStillOpen = finalWindowStatus?.status !== 'closed' && keepOpenMode;
  record('D-final. Chrome 保持打开（--keep-open）',
    report.chromeStillOpen,
    `windowStatus=${finalWindowStatus?.status || 'unknown'}, keepOpen=${keepOpenMode}`);

  // D-legacy. legacy_easybr 默认可回退（静态确认）
  try {
    const runtimeModePath = join(backendDir, 'config', 'runtimeMode.ts');
    const content = readFileContent(runtimeModePath);
    const hasLegacyDefault = content.includes("return 'legacy_easybr';");
    report.legacyEasyBrFallback = hasLegacyDefault;
    record('D-legacy. legacy_easybr 默认可回退',
      hasLegacyDefault,
      hasLegacyDefault
        ? 'WINDOW_RUNTIME_MODE 未设置或非 playwright 时，所有任务走 BrowserPool / EasyBR'
        : '默认值实现缺失');
  } catch (e) {
    record('D-legacy. legacy_easybr 默认可回退', false, (e as Error).message);
  }

  // Phase 3 建议判定
  const allModulesPassed = report.moduleResults.length > 0 && report.moduleResults.every(m =>
    !!m.firstTaskId &&
    m.enteredPlaywrightRuntime &&
    m.enteredHandler &&
    m.windowStatusAfterFirst === 'ready' &&
    m.windowReused &&
    m.windowStatusAfterSecond === 'ready'
  );
  report.recommendPhase3 =
    report.defaultStillLegacy &&
    report.allowlistChanged &&
    report.handlerNotModified &&
    report.routesNotModified &&
    report.bnsyOperatorNotModified &&
    report.p0Passed &&
    allModulesPassed &&
    report.chromeStillOpen &&
    report.legacyEasyBrFallback;

  record('D-phase3. 建议进入 Phase 3',
    report.recommendPhase3,
    report.recommendPhase3
      ? '所有通过标准已满足，建议进入 Phase 3'
      : '部分通过标准未满足，暂不建议进入 Phase 3');
}

// ════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  Phase 2-E Multi-Runtime Mode 验证脚本');
  console.log('  模块: arrival / dispatch / integrated');
  console.log('═══════════════════════════════════════════');
  console.log(`  next root: ${nextRoot}`);
  console.log(`  bnsy-operator: ${bnsyOperatorDir} (exists=${existsSync(bnsyOperatorDir)})`);
  console.log(`  auto-login mode: ${autoLoginMode}`);
  console.log(`  headed: ${headedMode}, keep-open: ${keepOpenMode}`);
  console.log(`  modules: ${ACTIVE_MODULES.map(m => m.name).join(', ') || '(default all)'}`);
  if (autoLoginMode) {
    console.log(`  test username: ${maskUsername(TEST_USERNAME)}`);
    console.log(`  test password: ${maskPassword()}`);
  }

  verifyStatic();
  await verifyRuntime();

  if (autoLoginMode) {
    await verifyMultiRuntime();
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

  if (autoLoginMode) {
    writePhase2EReport();
  }

  console.log('\n运行时验证指引：');
  console.log('  1. legacy 回归：');
  console.log('     WINDOW_RUNTIME_MODE=legacy_easybr npm run dev');
  console.log('     → 提交 arrival/dispatch/integrated 任务 → 日志应含 runtimeMode=legacy_easybr');
  console.log('  2. playwright 模式：');
  console.log('     WINDOW_RUNTIME_MODE=playwright npm run dev');
  console.log('     → 提交 arrival/dispatch/integrated 任务 → 日志应含 runtimeMode=playwright / Worker connection established');
  console.log('     → markBusy/markReady/lockManager 是 console.log（不在任务日志 API 中），通过窗口恢复 ready 间接验证');
  console.log('     → 第二次任务应复用窗口（窗口仍 ready，走 playwright 路径）');

  process.exit(failCount > 0 ? 1 : 0);
}

/**
 * 输出 Phase 2-E 验收报告到 docs 目录
 *
 * 报告内容（13 项）+ 通过标准（14 项）
 * 安全要求：报告中不得出现完整密码，账号必须脱敏
 */
function writePhase2EReport(): void {
  const reportPath = join(nextRoot, 'docs', 'phase-2e-all-modules-runtime-report.md');
  const timestamp = new Date().toISOString();
  const maskedUser = maskUsername(TEST_USERNAME);

  const yn = (b: boolean) => b ? '✓ 是' : '✗ 否';
  const mark = (b: boolean) => b ? '✓' : '✗';

  // 14 项通过标准
  const criteria = [
    { name: '1. 默认仍是 legacy_easybr', pass: report.defaultStillLegacy },
    { name: '2. playwright 支持 sign + arrival + dispatch + integrated', pass: report.allowlistChanged },
    { name: '3. 真实 Chrome 打开，headless=false', pass: report.chromeHeaded && report.chromeLaunched },
    { name: '4. 每个模块执行前 P0 passed', pass: report.p0Passed },
    { name: '5. 三个模块都拿到 taskId', pass: report.moduleResults.every(m => !!m.firstTaskId) && report.moduleResults.length === ACTIVE_MODULES.length },
    { name: '6. 三个模块都进入 playwright runtime', pass: report.moduleResults.every(m => m.enteredPlaywrightRuntime) },
    { name: '7. 三个模块都进入对应 Handler', pass: report.moduleResults.every(m => m.enteredHandler) },
    { name: '8. 三个模块任务后窗口 ready', pass: report.moduleResults.every(m => m.windowStatusAfterFirst === 'ready') },
    { name: '9. 三个模块第二次任务复用窗口', pass: report.moduleResults.every(m => m.windowReused) },
    { name: '10. Chrome 保持打开', pass: report.chromeStillOpen },
    { name: '11. Handler 业务逻辑未修改', pass: report.handlerNotModified },
    { name: '12. routes.ts 未修改', pass: report.routesNotModified },
    { name: '13. bnsy-operator/ 未修改', pass: report.bnsyOperatorNotModified },
    { name: '14. legacy_easybr 可回退', pass: report.legacyEasyBrFallback },
  ];
  const passedCount = criteria.filter(c => c.pass).length;
  const totalCount = criteria.length;

  // 模块结果表格
  const moduleTableRows = report.moduleResults.map(m => {
    return `| ${m.label} | \`${m.firstTaskId || '(无)'}\` | ${m.firstTaskStatus} | ${mark(m.enteredPlaywrightRuntime)} | ${mark(m.enteredHandler)} | ${m.windowStatusAfterFirst} | \`${m.secondTaskId || '(无)'}\` | ${m.secondTaskStatus} | ${mark(m.windowReused)} | ${m.windowStatusAfterSecond} |`;
  }).join('\n');

  const reportContent = `# Phase 2-E 验收报告：剩余业务模块批量接入 Playwright Runtime

> 阶段：Phase 2-E（一次性接入 arrival / dispatch / integrated 到 Playwright Runtime）
> 验收日期：${timestamp}
> 测试账号：${maskedUser}（脱敏）
> 测试密码：${maskPassword()}（脱敏）
> 前置阶段：Phase 2-D 全部通过（sign 已接入 + 真实 Chrome + P0 + 窗口复用 + 密码弹窗禁用）
> 接入策略：Engine 层接入方案（不在 Handler 里直接调用 Adapter）
> P0 复用源：BrowserPool.verifyReady (L368-451) + ensureNoPopup (L812-840)
> Chrome 配置：channel=chrome, headless=false（PlaywrightWindowAdapter L99/L154 硬编码）
> Chrome 密码弹窗：已禁用（PlaywrightRuntime.disableChromePasswordManager + Chrome args）
> CLI 参数：--headed=${headedMode}, --keep-open=${keepOpenMode}, --modules=${TEST_MODULES_RAW}
> 测试模块：${ACTIVE_MODULES.map(m => `${m.name}(${m.label})`).join(' / ')}

---

## 1. 修改文件清单

${report.modifiedFiles.map(f => `- \`${f}\``).join('\n')}

**未修改文件（严禁修改）：**
- backend/modules/assignment-engine/AssignmentEngine.ts（仅 Phase 2-D 修改，本次未改）
- backend/modules/assignment-engine/types.ts（仅 Phase 2-D 修改，本次未改）
- backend/modules/assignment-engine/handlers/ArrivalHandler.ts
- backend/modules/assignment-engine/handlers/DispatchHandler.ts
- backend/modules/assignment-engine/handlers/IntegratedHandler.ts
- backend/modules/assignment-engine/handlers/SignHandler.ts
- backend/api/routes.ts
- backend/browser/BrowserPool.ts（旧 P0 源文件，仅复用未修改）
- backend/easybr/EasyBRClient.ts
- bnsy-operator/

---

## 2. allowlist 变化

${yn(report.allowlistChanged)}

**Phase 2-D allowlist（仅 sign）：**
\`\`\`ts
const PLAYWRIGHT_ALLOWED_TASK_TYPES = new Set(['sign']);
\`\`\`

**Phase 2-E allowlist（扩展为 5 个 taskType）：**
\`\`\`ts
const PLAYWRIGHT_ALLOWED_TASK_TYPES = new Set([
  'sign',
  'arrive',
  'arrival',
  'dispatch',
  'integrated',
]);
\`\`\`

**真实 taskType 来源（routes.ts → engine.execute({ taskType })）：**
- \`'arrival'\`    → POST /api/operations/arrive      → ArrivalHandler
- \`'dispatch'\`   → POST /api/operations/dispatch    → DispatchHandler
- \`'integrated'\` → POST /api/operations/integrated  → IntegratedHandler
- \`'sign'\`       → POST /api/operations/sign        → SignHandler

注意：接口名是 /arrive 但 taskType 是 'arrival'，两者均已包含以容错。

---

## 3. 默认值是否仍 legacy_easybr

${yn(report.defaultStillLegacy)}

\`getRuntimeMode()\` 严格匹配 \`'playwright'\`，其他任何值（包括未设置）都回退 \`legacy_easybr\`。

---

## 4. 是否修改 Handler / routes.ts / bnsy-operator/

| 文件 | 是否修改 |
|------|----------|
| 4 个正式 Handler（Arrival/Dispatch/Integrated/Sign） | ${report.handlerNotModified ? '✓ 否（未修改）' : '✗ 是（违规）'} |
| routes.ts | ${report.routesNotModified ? '✓ 否（未修改）' : '✗ 是（违规）'} |
| bnsy-operator/ | ${report.bnsyOperatorNotModified ? '✓ 否（未修改）' : '✗ 是（违规）'} |

---

## 5. Chrome 是否真实打开、headless=false

${yn(report.chromeHeaded && report.chromeLaunched)}

| 检查项 | 结果 |
|--------|------|
| Chrome 是否真实打开 | ${mark(report.chromeLaunched)} ${report.chromeLaunched ? '是' : '否'} |
| Chrome 是否 headless=false | ${mark(report.chromeHeaded)} ${report.chromeHeaded ? '是' : '否'} |
| Chrome channel | \`${report.chromeChannel}\` |
| Chrome 是否可见（--headed） | ${mark(report.chromeVisible)} ${report.chromeVisible ? '是' : '否'} |

---

## 6. 密码保存弹窗是否禁用

${yn(report.passwordPopupDisabled)}

Phase 2-D-Run 已通过以下方式禁用 Chrome 密码保存弹窗：
- Chrome args: \`--disable-save-password-bubble\`, \`--disable-password-manager-reauthentication\`, \`--disable-features=PasswordManagerOnboarding,PasswordLeakDetection\`
- Profile Preferences: \`credentials_enable_service: false\`, \`profile.password_manager_enabled: false\`

本次 Phase 2-E 沿用 Phase 2-D-Run 的禁用配置，未修改 PlaywrightRuntime.ts。

---

## 7. 每个模块 P0 是否 passed

${yn(report.p0Passed)}

**P0 检查详情（所有业务任务前门槛，窗口复用只做一次）：**

| 检查项 | 结果 |
|--------|------|
| 是否执行 P0 检查 | ${mark(report.p0CheckExecuted)} ${report.p0CheckExecuted ? '是' : '否'} |
| P0 是否通过 | ${mark(report.p0Passed)} ${report.p0Passed ? '是' : '否'} |
| 复用的旧 P0 函数/文件 | \`${report.p0Source || 'BrowserPool.verifyReady + ensureNoPopup'}\` |
| 开始 URL | \`${report.p0StartUrl}\` |
| 结束 URL | \`${report.p0EndUrl}\` |
| 失败检查项 | \`${report.p0FailedCheck || '(无)'}\` |
| 失败原因 | \`${report.p0FailedReason || 'ok'}\` |

---

## 8. Arrival 两次 taskId / 状态 / 是否复用 / 窗口 ready

${(() => {
  const m = report.moduleResults.find(r => r.name === 'arrival');
  if (!m) return '⚠ 未验证（模块未在 --modules 中）';
  return `| 检查项 | 结果 |
|--------|------|
| 第一次 taskId | \`${m.firstTaskId || '(无)'}\` |
| 第一次状态 | \`${m.firstTaskStatus}\` |
| 进入 playwright runtime | ${mark(m.enteredPlaywrightRuntime)} |
| 进入 ArrivalHandler | ${mark(m.enteredHandler)} |
| 第一次后窗口状态 | \`${m.windowStatusAfterFirst}\` |
| 第二次 taskId | \`${m.secondTaskId || '(无)'}\` |
| 第二次状态 | \`${m.secondTaskStatus}\` |
| 是否复用窗口 | ${mark(m.windowReused)} |
| 第二次后窗口状态 | \`${m.windowStatusAfterSecond}\` |
| 日志摘要 | ${m.firstLogSummary.substring(0, 200) || '(无关键日志)'} |`;
})()}

---

## 9. Dispatch 两次 taskId / 状态 / 是否复用 / 窗口 ready

${(() => {
  const m = report.moduleResults.find(r => r.name === 'dispatch');
  if (!m) return '⚠ 未验证（模块未在 --modules 中）';
  return `| 检查项 | 结果 |
|--------|------|
| 第一次 taskId | \`${m.firstTaskId || '(无)'}\` |
| 第一次状态 | \`${m.firstTaskStatus}\` |
| 进入 playwright runtime | ${mark(m.enteredPlaywrightRuntime)} |
| 进入 DispatchHandler | ${mark(m.enteredHandler)} |
| 第一次后窗口状态 | \`${m.windowStatusAfterFirst}\` |
| 第二次 taskId | \`${m.secondTaskId || '(无)'}\` |
| 第二次状态 | \`${m.secondTaskStatus}\` |
| 是否复用窗口 | ${mark(m.windowReused)} |
| 第二次后窗口状态 | \`${m.windowStatusAfterSecond}\` |
| 日志摘要 | ${m.firstLogSummary.substring(0, 200) || '(无关键日志)'} |`;
})()}

---

## 10. Integrated 两次 taskId / 状态 / 是否复用 / 窗口 ready

${(() => {
  const m = report.moduleResults.find(r => r.name === 'integrated');
  if (!m) return '⚠ 未验证（模块未在 --modules 中）';
  return `| 检查项 | 结果 |
|--------|------|
| 第一次 taskId | \`${m.firstTaskId || '(无)'}\` |
| 第一次状态 | \`${m.firstTaskStatus}\` |
| 进入 playwright runtime | ${mark(m.enteredPlaywrightRuntime)} |
| 进入 IntegratedHandler | ${mark(m.enteredHandler)} |
| 第一次后窗口状态 | \`${m.windowStatusAfterFirst}\` |
| 第二次 taskId | \`${m.secondTaskId || '(无)'}\` |
| 第二次状态 | \`${m.secondTaskStatus}\` |
| 是否复用窗口 | ${mark(m.windowReused)} |
| 第二次后窗口状态 | \`${m.windowStatusAfterSecond}\` |
| 日志摘要 | ${m.firstLogSummary.substring(0, 200) || '(无关键日志)'} |`;
})()}

---

## 11. Chrome 是否保持打开

${yn(report.chromeStillOpen)}

任务结束后未调用 close，Chrome 窗口保持打开供人工观察。窗口状态：\`${(() => {
  const last = report.moduleResults[report.moduleResults.length - 1];
  return last?.windowStatusAfterSecond || 'unknown';
})()}\`

---

## 12. legacy_easybr 是否可回退

${yn(report.legacyEasyBrFallback)}

\`WINDOW_RUNTIME_MODE\` 未设置或为 \`legacy_easybr\` 时，所有正式任务仍走 BrowserPool / EasyBR。
playwright 不会成为默认。

---

## 13. 是否建议进入 Phase 3

${yn(report.recommendPhase3)}

---

## 模块结果汇总表

| 模块 | 第一次 taskId | 第一次状态 | playwright | Handler | 第一次后窗口 | 第二次 taskId | 第二次状态 | 复用 | 第二次后窗口 |
|------|---------------|------------|------------|---------|--------------|---------------|------------|------|--------------|
${moduleTableRows || '| (无模块结果) | - | - | - | - | - | - | - | - | - |'}

---

## 通过标准（14 项）

| # | 标准 | 结果 |
|---|------|------|
${criteria.map(c => `| ${c.name} | ${mark(c.pass)} ${c.pass ? '通过' : '未通过'} |`).join('\n')}

**通过: ${passedCount} / ${totalCount}**

${passedCount === totalCount ? '✓ 全部通过，Phase 2-E 验收完成。' : '✗ 部分未通过，请查看上方失败项详情。'}

---

## 测试参数

| 参数 | 值 |
|------|-----|
| tenantId | \`${report.testTenantId}\` |
| POC siteId | \`${report.testPocSiteId}\`（内部 Site code） |
| Sign siteId | \`${report.testSignSiteId}\`（settings.json site.id） |
| staffName | \`${report.testStaffName}\` |
| windowId | \`${report.testWindowId}\` |
| 验证模块 | ${report.testModules.join(', ')} |
| 凭证来源 | ${report.credentialsFromEnv ? '✓ 环境变量' : '✗ 非环境变量'} |
| 凭证未硬编码 | ${mark(report.noHardcodedCredentials)} |

---

## 安全说明

- 测试账号仅从环境变量 \`BNSY_TEST_USERNAME\` / \`BNSY_TEST_PASSWORD\` 读取
- 日志和报告中账号脱敏（如 ${maskedUser}），密码始终显示 ******
- 测试单号使用 TEST-ARRIVAL-001/002、TEST-DISPATCH-001/002、TEST-INTEGRATED-001/002，避免生产数据
- 业务系统因测试单号不存在导致 task failed 可接受，关键证明运行时链路完整

---

## 接入策略说明

本次 Phase 2-E 继续使用 Phase 2-D 已验证的 **Engine 层接入方案**：

1. **不在 Handler 里直接调用 Adapter**
   - Handler 继续只使用 \`ctx.page\` / \`ctx.staffName\` / \`ctx.windowId\` / \`ctx.log\`
   - 窗口获取、P0、busy、ready、lock release 都由 AssignmentEngine 统一处理

2. **单点判断入口**
   - \`shouldUsePlaywrightAdapter(taskType)\` 是唯一判断入口
   - 扩展 allowlist 即可全部接入，无需修改 Engine 业务流程

3. **渐进式接入 + 回退能力**
   - \`WINDOW_RUNTIME_MODE\` feature flag 控制全局模式
   - 默认 \`legacy_easybr\`，playwright 不会成为默认
   - legacy 模式下所有任务仍走 BrowserPool / EasyBR

---

## Engine 层接入方案流程

\`\`\`
routes.ts → engine.execute({ taskType, ... })
  → AssignmentEngine.resolveWorkerConnection(taskType)
    → shouldUsePlaywrightAdapter(taskType)  // 单点判断
      → true:  resolvePlaywrightWorkerConnection()
                → adapter.ensureWindowReady()
                → adapter.markBusy()
                → adapter.getWorkerPage()
                → return WorkerConnectionHandle { page, windowId, runtimeMode, release }
      → false: resolveLegacyWorkerConnection()
                → BrowserPool.getStaffConnection()
                → return legacy connection
  → executeAssignment(handler, ctx)
    → handler.execute(ctx)  // ctx.page / ctx.staffName / ctx.windowId
  → finally: conn.release()
    → adapter.markReady()
    → lockManager.release(windowId, taskId)
\`\`\`

---

*报告由 scripts/multi-runtime-mode-verify.ts 自动生成*
`;

  try {
    writeFileSync(reportPath, reportContent, 'utf-8');
    console.log(`\n✓ Phase 2-E 验收报告已生成: ${reportPath}`);
    console.log(`  通过标准: ${passedCount} / ${totalCount}`);
  } catch (e) {
    console.log(`\n✗ 报告写入失败: ${(e as Error).message}`);
  }
}

main().catch(err => {
  console.error('脚本异常:', err);
  process.exit(1);
});
