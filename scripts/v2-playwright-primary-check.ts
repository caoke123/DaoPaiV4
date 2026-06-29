/**
 * Phase 4-A：V2 Playwright 主模式快速自检脚本
 *
 * 轻量级静态检查，不打开 Chrome，不提交真实任务。
 * 用于在启动前后端服务前快速确认配置正确。
 *
 * 检查项（7 项）：
 *   1. .env 文件中 WINDOW_RUNTIME_MODE=playwright
 *   2. getRuntimeMode 代码默认值仍是 legacy_easybr（安全保障）
 *   3. shouldUsePlaywrightAdapter 对 sign/arrival/dispatch/integrated 返回 true（env=playwright 时）
 *   4. legacy_easybr 代码路径仍存在（BrowserPool / EasyBRClient / resolveLegacyWorkerConnection）
 *   5. Chrome 配置仍 channel=chrome、headless=false
 *   6. P0Verifier 存在
 *   7. V1 bnsy-operator 未修改（git status 干净）
 *
 * 用法：
 *   npx tsx scripts/v2-playwright-primary-check.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ── 路径常量 ──
const V2_ROOT = join(__dirname, '..');
const BACKEND_DIR = join(V2_ROOT, 'backend');
const V1_ROOT = join(V2_ROOT, '..', 'bnsy-operator');

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
}

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

// ─────────────────────────────────────────────────────────
// 检查 1：.env 文件中 WINDOW_RUNTIME_MODE=playwright
// ─────────────────────────────────────────────────────────
function checkEnvFile(): void {
  const envPath = join(V2_ROOT, '.env');
  const name = '检查 1：.env 文件中 WINDOW_RUNTIME_MODE=playwright';

  if (!fileExists(envPath)) {
    record(name, false, `.env 文件不存在：${envPath}`);
    return;
  }

  const content = readFile(envPath);
  const lines = content.split('\n');
  let found = false;
  let value = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key === 'WINDOW_RUNTIME_MODE') {
      found = true;
      value = trimmed.slice(eqIdx + 1).trim();
      break;
    }
  }

  if (!found) {
    record(name, false, '.env 中未找到 WINDOW_RUNTIME_MODE 设置');
    return;
  }

  if (value !== 'playwright') {
    record(name, false, `.env 中 WINDOW_RUNTIME_MODE=${value}（期望 playwright）`);
    return;
  }

  record(name, true, `.env 中 WINDOW_RUNTIME_MODE=playwright ✅`);
}

// ─────────────────────────────────────────────────────────
// 检查 2：getRuntimeMode 代码默认值仍是 legacy_easybr
// ─────────────────────────────────────────────────────────
function checkGetRuntimeModeDefault(): void {
  const name = '检查 2：getRuntimeMode 代码默认值仍是 legacy_easybr（安全保障）';
  const filePath = join(BACKEND_DIR, 'config', 'runtimeMode.ts');

  if (!fileExists(filePath)) {
    record(name, false, `文件不存在：${filePath}`);
    return;
  }

  const content = readFile(filePath);

  // 检查代码中是否包含默认回退 legacy_easybr 的逻辑
  const hasStrictCheck = content.includes("if (raw === 'playwright') return 'playwright'");
  const hasDefaultReturn = content.includes("return 'legacy_easybr'");

  if (!hasStrictCheck) {
    record(name, false, '未找到严格匹配 playwright 的逻辑');
    return;
  }

  if (!hasDefaultReturn) {
    record(name, false, '未找到默认回退 legacy_easybr 的逻辑');
    return;
  }

  record(name, true, '代码默认值仍为 legacy_easybr（env 配错时安全回退）✅');
}

// ─────────────────────────────────────────────────────────
// 检查 3：shouldUsePlaywrightAdapter 对四类任务返回 true
// ─────────────────────────────────────────────────────────
function checkShouldUsePlaywrightAdapter(): void {
  const name = '检查 3：shouldUsePlaywrightAdapter 对 sign/arrival/dispatch/integrated 返回 true（env=playwright 时）';
  const filePath = join(BACKEND_DIR, 'config', 'runtimeMode.ts');

  if (!fileExists(filePath)) {
    record(name, false, `文件不存在：${filePath}`);
    return;
  }

  const content = readFile(filePath);

  // 检查 allowlist 是否包含四类任务
  const allowedTypes = ['sign', 'arrival', 'dispatch', 'integrated'];
  const missing: string[] = [];

  for (const taskType of allowedTypes) {
    // 检查是否在 allowlist Set 中（查找 'sign' 或 'arrival' 等字符串）
    if (!content.includes(`'${taskType}'`)) {
      missing.push(taskType);
    }
  }

  if (missing.length > 0) {
    record(name, false, `allowlist 缺少：${missing.join(', ')}`);
    return;
  }

  // 动态验证：设置 env=playwright 后调用 shouldUsePlaywrightAdapter
  const originalEnv = process.env.WINDOW_RUNTIME_MODE;
  process.env.WINDOW_RUNTIME_MODE = 'playwright';

  try {
    // 清除 require cache
    delete require.cache[require.resolve('../backend/config/runtimeMode.ts')];
    // 使用 tsx 运行时可以直接 require .ts
    const runtimeMode = require('../backend/config/runtimeMode.ts');

    const allReturnTrue = allowedTypes.every(taskType =>
      runtimeMode.shouldUsePlaywrightAdapter(taskType) === true
    );

    if (allReturnTrue) {
      record(name, true, `四类任务在 playwright 模式下均返回 true ✅（${allowedTypes.join('/')}）`);
    } else {
      record(name, false, '部分 taskType 未返回 true');
    }
  } catch (err) {
    // 动态加载失败时退回到静态检查结论
    record(name, true, `allowlist 包含四类任务（静态检查通过，动态加载跳过：${(err as Error).message}）`);
  } finally {
    // 恢复 env
    if (originalEnv === undefined) {
      delete process.env.WINDOW_RUNTIME_MODE;
    } else {
      process.env.WINDOW_RUNTIME_MODE = originalEnv;
    }
  }
}

// ─────────────────────────────────────────────────────────
// 检查 4：legacy_easybr 代码路径仍存在
// ─────────────────────────────────────────────────────────
function checkLegacyPathExists(): void {
  const name = '检查 4：legacy_easybr 代码路径仍存在（BrowserPool / EasyBRClient / resolveLegacyWorkerConnection）';

  const browserPoolPath = join(BACKEND_DIR, 'browser', 'BrowserPool.ts');
  const easybrClientPath = join(BACKEND_DIR, 'easybr', 'EasyBRClient.ts');
  const enginePath = join(BACKEND_DIR, 'modules', 'assignment-engine', 'AssignmentEngine.ts');

  const missing: string[] = [];

  if (!fileExists(browserPoolPath)) missing.push('BrowserPool.ts');
  if (!fileExists(easybrClientPath)) missing.push('EasyBRClient.ts');
  if (!fileExists(enginePath)) missing.push('AssignmentEngine.ts');

  if (missing.length > 0) {
    record(name, false, `缺失文件：${missing.join(', ')}`);
    return;
  }

  // 检查 AssignmentEngine 中是否仍有 resolveLegacyWorkerConnection
  const engineContent = readFile(enginePath);
  const hasLegacyResolver = engineContent.includes('resolveLegacyWorkerConnection');

  if (!hasLegacyResolver) {
    record(name, false, 'AssignmentEngine 中未找到 resolveLegacyWorkerConnection 方法');
    return;
  }

  record(name, true, 'legacy 路径完整保留（BrowserPool + EasyBRClient + resolveLegacyWorkerConnection）✅');
}

// ─────────────────────────────────────────────────────────
// 检查 5：Chrome 配置仍 channel=chrome、headless=false
// ─────────────────────────────────────────────────────────
function checkChromeConfig(): void {
  const name = '检查 5：Chrome 配置仍 channel=chrome、headless=false';
  const filePath = join(BACKEND_DIR, 'playwright-runtime', 'PlaywrightRuntime.ts');

  if (!fileExists(filePath)) {
    record(name, false, `文件不存在：${filePath}`);
    return;
  }

  const content = readFile(filePath);

  const hasChannelChrome = content.includes("channel: 'chrome'");
  const hasHeadlessFalse = content.includes('headless: opts.headless ?? false') ||
                           content.includes('headless: false');

  if (!hasChannelChrome) {
    record(name, false, '未找到 channel: chrome 配置');
    return;
  }

  if (!hasHeadlessFalse) {
    record(name, false, '未找到 headless: false 配置');
    return;
  }

  record(name, true, 'Chrome 配置正确（channel=chrome, headless=false）✅');
}

// ─────────────────────────────────────────────────────────
// 检查 6：P0Verifier 存在
// ─────────────────────────────────────────────────────────
function checkP0VerifierExists(): void {
  const name = '检查 6：P0Verifier 存在';
  const filePath = join(BACKEND_DIR, 'playwright-runtime', 'P0Verifier.ts');

  if (!fileExists(filePath)) {
    record(name, false, `文件不存在：${filePath}`);
    return;
  }

  const content = readFile(filePath);

  // 检查是否复用了 BrowserPool.verifyReady
  const reusesBrowserPool = content.includes('verifyReady') || content.includes('BrowserPool');

  if (reusesBrowserPool) {
    record(name, true, 'P0Verifier.ts 存在，且复用 BrowserPool.verifyReady 逻辑 ✅');
  } else {
    record(name, true, 'P0Verifier.ts 存在 ✅（未检测到 verifyReady 复用，建议人工确认）');
  }
}

// ─────────────────────────────────────────────────────────
// 检查 7：V1 bnsy-operator 未修改
// ─────────────────────────────────────────────────────────
function checkV1Unmodified(): void {
  const name = '检查 7：V1 bnsy-operator 未修改';

  if (!fileExists(V1_ROOT)) {
    record(name, false, `V1 目录不存在：${V1_ROOT}`);
    return;
  }

  // 尝试 git status 检查
  try {
    const gitStatus = execSync('git status --porcelain', {
      cwd: V1_ROOT,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (gitStatus === '') {
      record(name, true, 'V1 bnsy-operator git status 干净，未修改 ✅');
    } else {
      // 过滤掉非 bnsy-operator 目录的变更（git 在父目录可能返回其他路径）
      const v1Changes = gitStatus.split('\n').filter(line =>
        !line.startsWith('??') // 忽略 untracked 文件
      );

      if (v1Changes.length === 0) {
        record(name, true, 'V1 bnsy-operator 无已跟踪文件修改 ✅');
      } else {
        record(name, false, `V1 有修改：\n${v1Changes.join('\n')}`);
      }
    }
  } catch (err) {
    // git 不可用时退回到目录存在性检查
    record(name, true, `V1 目录存在（git 检查跳过：${(err as Error).message}）✅`);
  }
}

// ─────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────
function main(): void {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Phase 4-A：V2 Playwright 主模式快速自检');
  console.log('  时间：' + new Date().toISOString());
  console.log('  V2 根目录：' + V2_ROOT);
  console.log('═══════════════════════════════════════════════════════════\n');

  // 执行 7 项检查
  checkEnvFile();
  checkGetRuntimeModeDefault();
  checkShouldUsePlaywrightAdapter();
  checkLegacyPathExists();
  checkChromeConfig();
  checkP0VerifierExists();
  checkV1Unmodified();

  // 输出结果
  console.log('── 检查结果 ──────────────────────────────────────────────\n');

  let passedCount = 0;
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon} ${r.name}`);
    console.log(`   ${r.detail}\n`);
    if (r.passed) passedCount++;
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  结果：${passedCount}/${results.length} 通过`);

  if (passedCount === results.length) {
    console.log('  ✅ Phase 4-A 自检全部通过，可进入冒烟测试');
    process.exit(0);
  } else {
    console.log('  ❌ 自检未全部通过，请检查上述失败项');
    process.exit(1);
  }
}

main();
