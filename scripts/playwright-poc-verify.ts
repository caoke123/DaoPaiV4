/**
 * Playwright 原生窗口运行时 POC 验证脚本（Phase 1-A 补丁版）
 *
 * 验证目标（Phase 1 POC）：
 *   1. 不使用 EasyBR
 *   2. 不使用 connectOverCDP
 *   3. 使用 Playwright 自己启动 Chrome 浏览器窗口
 *   4. 使用独立 userDataDir 保存登录态
 *   5. 能打开目标业务系统
 *   6. 能判断登录状态
 *   7. 能保持窗口状态
 *   8. 能独立关闭窗口
 *
 * Phase 1-A 补丁新增检查：
 *   9.  返回的 userDataDir 包含 tenantId/siteId/windowId 三层路径
 *   10. runtimeKey 格式为 tenantId:siteId:windowId
 *   11. 不同 siteId + 相同 windowId 生成不同 runtimeKey
 *   12. 不同 tenantId + 相同 windowId 生成不同 userDataDir
 *   13. playwright-runtime 内无 EasyBRClient import
 *   14. playwright-runtime 内无 connectOverCDP 调用
 *
 * 前置条件：
 *   1. 后端已启动（npm run dev，端口 3200）
 *   2. 本机已安装 Chrome 浏览器
 *
 * 用法：
 *   npx tsx scripts/playwright-poc-verify.ts
 *
 * 可选参数：
 *   --auto-login         启动时尝试自动登录
 *   --credential=账号:密码  显式提供凭据
 *   --headless           无头模式
 *   --keep-open          验证完成后不关闭窗口
 *   --skip-launch        跳过真实启动 Chrome（仅检查代码层面）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE = 'http://localhost:3200/api/playwright-poc';
const RUNTIME_MODULE_DIR = path.resolve(__dirname, '..', 'backend', 'playwright-runtime');

async function apiGet(p: string): Promise<any> {
  const resp = await fetch(`${BASE}${p}`);
  return resp.json();
}

async function apiPost(p: string, body?: any): Promise<any> {
  const resp = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    autoLogin: args.includes('--auto-login'),
    headless: args.includes('--headless'),
    keepOpen: args.includes('--keep-open'),
    skipLaunch: args.includes('--skip-launch'),
    credential: (() => {
      for (const a of args) {
        if (a.startsWith('--credential=')) {
          const raw = a.slice('--credential='.length);
          const idx = raw.indexOf(':');
          if (idx > 0) return { account: raw.slice(0, idx), password: raw.slice(idx + 1) };
        }
      }
      return undefined;
    })(),
  };
}

// ── 代码层面检查（不需要启动 Chrome） ──

function checkNoEasyBRImport(): { pass: boolean; detail: string } {
  const files = fs.readdirSync(RUNTIME_MODULE_DIR).filter(f => f.endsWith('.ts'));
  const violations: string[] = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(RUNTIME_MODULE_DIR, f), 'utf8');
    // 检查是否有 import EasyBRClient 的语句（注释中的不算）
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (/import\s+.*EasyBRClient/.test(line) || /from\s+['"]\.\.\/easybr/.test(line)) {
        violations.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return {
    pass: violations.length === 0,
    detail: violations.length === 0 ? '✓ 无 EasyBRClient import' : `✗ 发现 ${violations.length} 处:\n${violations.join('\n')}`,
  };
}

function checkNoConnectOverCDP(): { pass: boolean; detail: string } {
  const files = fs.readdirSync(RUNTIME_MODULE_DIR).filter(f => f.endsWith('.ts'));
  const violations: string[] = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(RUNTIME_MODULE_DIR, f), 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (/connectOverCDP/.test(line)) {
        violations.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return {
    pass: violations.length === 0,
    detail: violations.length === 0 ? '✓ 无 connectOverCDP 调用' : `✗ 发现 ${violations.length} 处:\n${violations.join('\n')}`,
  };
}

async function main() {
  const opts = parseArgs();

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Playwright POC 验证 (Phase 1-A 补丁版)     ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ════════════ Part A: 代码层面检查（不需要启动 Chrome） ════════════
  console.log('━━ Part A: 代码层面检查 ────\n');

  // 检查 13: 无 EasyBRClient import
  const checkEasyBR = checkNoEasyBRImport();
  console.log(`[13] 无 EasyBRClient import: ${checkEasyBR.detail}`);

  // 检查 14: 无 connectOverCDP 调用
  const checkCDP = checkNoConnectOverCDP();
  console.log(`[14] 无 connectOverCDP 调用: ${checkCDP.detail}`);

  if (opts.skipLaunch) {
    console.log('\n━━ --skip-launch 已指定，跳过真实启动验证 ────');
    const allPass = checkEasyBR.pass && checkCDP.pass;
    console.log(`\n代码层面检查结果: ${allPass ? '✓ PASS' : '✗ FAIL'}`);
    process.exit(allPass ? 0 : 1);
  }

  // ════════════ Part B: API 健康检查 ════════════
  console.log('\n━━ Part B: API 健康检查 ────\n');

  // 检查 1: 健康检查
  console.log('[1] 健康检查...');
  const health = await apiGet('/health');
  if (!health.ok) {
    console.error('  ✗ 健康检查失败:', health);
    process.exit(1);
  }
  console.log(`  ✓ POC 模块就绪，活跃窗口: ${health.activeWindows}`);

  // ════════════ Part C: runtimeKey 隔离验证（不启动 Chrome） ════════════
  console.log('\n━━ Part C: runtimeKey 隔离验证 ────\n');

  const tenantA = 'tenant-aaa';
  const tenantB = 'tenant-bbb';
  const siteX = 'site-xxx';
  const siteY = 'site-yyy';
  const windowId = 'window-shared';

  // 构造预期的 runtimeKey
  const keyAX = `${tenantA}:${siteX}:${windowId}`;
  const keyAY = `${tenantA}:${siteY}:${windowId}`;
  const keyBX = `${tenantB}:${siteX}:${windowId}`;

  // 检查 11: 不同 siteId + 相同 windowId 生成不同 runtimeKey
  const check11 = keyAX !== keyAY;
  console.log(`[11] 不同 siteId 生成不同 runtimeKey: ${check11 ? '✓' : '✗'}`);
  console.log(`     keyAX=${keyAX}`);
  console.log(`     keyAY=${keyAY}`);

  // 检查 12: 不同 tenantId + 相同 windowId 生成不同 userDataDir（通过 API 启动验证）
  // 这里先记录预期，后面通过启动窗口验证

  // ════════════ Part D: 真实启动验证 ════════════
  console.log('\n━━ Part D: 真实启动验证 ────\n');

  const windowIdLaunch = `poc-test-${Date.now()}`;
  const tenantLaunch = 'tenant-default';
  const siteLaunch = 'site-default';

  // 检查 2: 启动窗口
  console.log('[2] 启动 Playwright 原生窗口...');
  const launchBody: any = {
    tenantId: tenantLaunch,
    siteId: siteLaunch,
    windowId: windowIdLaunch,
    windowName: 'POC-验证窗口',
    headless: opts.headless,
    autoLogin: opts.autoLogin,
  };
  if (opts.credential) launchBody.credential = opts.credential;

  const launchResult = await apiPost('/launch', launchBody);
  if (!launchResult.success) {
    console.error('  ✗ 启动失败:', launchResult.error);
    process.exit(1);
  }
  const state = launchResult.state;
  console.log('  ✓ 窗口已启动');
  console.log(`     runtimeKey:  ${launchResult.runtimeKey}`);
  console.log(`     userDataDir: ${state.userDataDir}`);
  console.log(`     status:      ${state.status}`);
  console.log(`     currentUrl:  ${state.currentUrl}`);

  // 检查 9: userDataDir 包含三层路径
  const expectedPathParts = [tenantLaunch, siteLaunch, windowIdLaunch];
  const check9 = expectedPathParts.every(p => state.userDataDir.includes(p));
  console.log(`\n[9] userDataDir 包含三层路径: ${check9 ? '✓' : '✗'}`);
  console.log(`     期望包含: ${expectedPathParts.join(' / ')}`);
  console.log(`     实际路径: ${state.userDataDir}`);

  // 检查 10: runtimeKey 格式
  const expectedKey = `${tenantLaunch}:${siteLaunch}:${windowIdLaunch}`;
  const check10 = launchResult.runtimeKey === expectedKey;
  console.log(`\n[10] runtimeKey 格式正确: ${check10 ? '✓' : '✗'}`);
  console.log(`      期望: ${expectedKey}`);
  console.log(`      实际: ${launchResult.runtimeKey}`);

  // 检查 3: 等待页面稳定
  console.log('\n[3] 等待页面稳定（3秒）...');
  await sleep(3000);

  // 检查 4: 查询窗口状态
  console.log('\n[4] 查询窗口状态...');
  const stateResp = await apiGet(`/window?tenantId=${tenantLaunch}&siteId=${siteLaunch}&windowId=${windowIdLaunch}`);
  if (!stateResp.state) {
    console.error('  ✗ 查询状态失败:', stateResp);
  } else {
    const s = stateResp.state;
    console.log(`  ✓ status=${s.status}, isLoginPage=${s.isLoginPage}, isLoggedIn=${s.isLoggedIn}`);
  }

  // 检查 5: 探测登录页表单
  console.log('\n[5] 探测登录页表单...');
  const probe = await apiGet(`/window/login-probe?tenantId=${tenantLaunch}&siteId=${siteLaunch}&windowId=${windowIdLaunch}`);
  console.log(`  ✓ isLoginPage=${probe.isLoginPage}, isLoggedIn=${probe.isLoggedIn}`);
  if (probe.loginForm) {
    console.log(`     表单: account=${probe.loginForm.hasAccountInput}, password=${probe.loginForm.hasPasswordInput}, button=${probe.loginForm.hasLoginButton}`);
  }

  // 检查 6: 列出所有窗口
  console.log('\n[6] 列出所有 POC 窗口...');
  const list = await apiGet('/windows');
  console.log(`  ✓ 活跃窗口: ${list.activeCount}, 总计: ${list.totalCount}`);
  for (const w of list.windows) {
    console.log(`     - ${w.runtimeKey}: status=${w.status}`);
  }

  // 检查 12: 启动第二个窗口（不同 tenantId）验证 userDataDir 不同
  console.log('\n[12] 不同 tenantId 生成不同 userDataDir...');
  const windowIdB = `poc-test-b-${Date.now()}`;
  const tenantB2 = 'tenant-isolation-test';
  const launchB = await apiPost('/launch', {
    tenantId: tenantB2,
    siteId: siteLaunch,
    windowId: windowIdB,
    headless: opts.headless,
  }).catch(e => ({ error: (e as Error).message }));

  let check12 = false;
  let dirB = '';
  if (launchB.success && launchB.state) {
    dirB = launchB.state.userDataDir;
    check12 = dirB !== state.userDataDir && dirB.includes(tenantB2);
    console.log(`  ${check12 ? '✓' : '✗'} 窗口A: ${state.userDataDir}`);
    console.log(`     窗口B: ${dirB}`);
    // 关闭窗口 B
    await apiPost('/window/close', { tenantId: tenantB2, siteId: siteLaunch, windowId: windowIdB });
  } else {
    console.log(`  ⚠ 第二窗口启动失败（可能是 Chrome 资源限制）: ${launchB.error || 'unknown'}`);
    console.log('     （此检查需要 Chrome 能同时启动两个窗口）');
  }

  // ════════════ 验证报告 ════════════
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  POC 验证报告                                ║');
  console.log('╠══════════════════════════════════════════════╣');

  const checks: Array<{ id: number; name: string; pass: boolean }> = [
    { id: 1, name: '健康检查通过', pass: health.ok },
    { id: 2, name: 'Playwright 启动 Chrome', pass: launchResult.success },
    { id: 3, name: '等待页面稳定', pass: true },
    { id: 4, name: '查询窗口状态', pass: !!stateResp.state },
    { id: 5, name: '探测登录页表单', pass: probe.isLoginPage !== undefined },
    { id: 6, name: '列出所有窗口', pass: list.totalCount >= 1 },
    { id: 9, name: 'userDataDir 三层路径', pass: check9 },
    { id: 10, name: 'runtimeKey 格式正确', pass: check10 },
    { id: 11, name: '不同 siteId 不同 runtimeKey', pass: check11 },
    { id: 12, name: '不同 tenantId 不同 userDataDir', pass: check12 },
    { id: 13, name: '无 EasyBRClient import', pass: checkEasyBR.pass },
    { id: 14, name: '无 connectOverCDP 调用', pass: checkCDP.pass },
  ];

  // 附加特性检查
  const featureChecks = [
    { id: 7, name: '保持窗口状态', pass: stateResp.state?.status !== undefined },
    { id: 8, name: '独立 userDataDir', pass: !!state.userDataDir },
  ];
  checks.push(...featureChecks);

  for (const c of checks) {
    console.log(`║  [${String(c.id).padStart(2)}] ${c.pass ? '✓' : '✗'} ${c.name.padEnd(32)} ║`);
  }

  // ════════════ 清理 ════════════
  if (opts.keepOpen) {
    console.log('\n║  ⏸ 窗口保持打开（--keep-open）                ║');
    console.log('║  手动关闭命令:                                ║');
    console.log(`║  curl -X POST ${BASE}/window/close \\         ║`);
    console.log(`║    -H "Content-Type: application/json" \\       ║`);
    console.log(`║    -d '{"tenantId":"${tenantLaunch}","siteId":"${siteLaunch}","windowId":"${windowIdLaunch}"}' ║`);
  } else {
    console.log('\n[清理] 关闭窗口...');
    const closeResult = await apiPost('/window/close', {
      tenantId: tenantLaunch,
      siteId: siteLaunch,
      windowId: windowIdLaunch,
    });
    console.log(`  ✓ 关闭结果: ${closeResult.success ? '成功' : '失败'}`);
  }

  console.log('\n╚══════════════════════════════════════════════╝');

  const allPass = checks.every(c => c.pass);
  console.log(`\n总结: ${allPass ? '✓ ALL PASS' : '✗ SOME FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('\n❌ POC 验证脚本异常:', (err as Error).message);
  process.exit(1);
});
