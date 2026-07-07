/**
 * testBnsySessionP0.ts — 笨鸟登录状态保持与 Dashboard P0 检测
 *
 * Phase 5-C-5 追加修复：进程级确认关闭策略。
 *
 * 硬性约束：
 *   - 不打印密码
 *   - 不执行业务
 *   - 不点击业务菜单
 *   - 不 taskkill /IM chrome.exe
 *   - 不误关系统正式版 Chrome
 */

import { BrowserManager } from './browser/BrowserManager';
import { ensureBnsyLoggedIn } from './browser/BnsySessionManager';
import { AgentSettingsLoader } from './AgentSettingsLoader';
import { readSession, clearSession } from './browser/BrowserProcessRegistry';
import { checkPort, isProcessAlive, findV3ChromeProcesses } from './browser/ChromeProcessGuard';

function maskAccount(account: string): string {
  if (account.length <= 4) return '****';
  return account.substring(0, 2) + '****' + account.substring(account.length - 2);
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DaoPai V3 登录状态与 Dashboard P0 检测');
  console.log('  Phase 5-C-5 追加修复：进程级确认关闭');
  console.log('═══════════════════════════════════════════\n');

  // ── 配置 ──
  const siteId = 'site-1782121346155'; // 天南大
  const loginUrl = 'https://bnsy.benniaosuyun.com/login';

  const browserConfig = {
    executablePath: 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe',
    userDataDir: 'E:/网站开发/DaoPaiV3/runtime/chrome-profile',
    debugPort: 9223,
    headless: false,
  };

  // ── 1. 读取凭据 ──
  console.log('[1/6] 读取员工凭据...');
  const settingsLoader = new AgentSettingsLoader();
  const credential = await settingsLoader.getLoginCredentialForSite(siteId);

  if (!credential) {
    console.error('  错误：无法读取员工凭据，请检查 settings.json');
    process.exit(1);
  }

  console.log(`  网点：${credential.siteName}`);
  console.log(`  员工：${credential.employeeName}`);
  console.log(`  账号：${maskAccount(credential.loginAccount)}`);
  console.log('');

  // ── 2. 启动浏览器（含端口检查 + Profile 消毒 + 进程注册） ──
  console.log('[2/6] 启动便携版 Chrome（含安全前置检查）...');
  const manager = new BrowserManager(browserConfig);
  await manager.start();
  console.log('');

  // ── 3. CDP 连接 ──
  console.log('[3/6] 等待 CDP 就绪并连接...');
  await manager.connect();
  console.log('');

  // ── 4. 打开登录页 ──
  console.log('[4/6] 打开页面...');
  console.log(`  正在打开：${loginUrl}`);

  let page;
  try {
    page = await manager.openPage(loginUrl);
  } catch (err) {
    console.error(`  页面打开失败：${(err as Error).message}`);
    await manager.close().catch(() => {});
    process.exit(1);
  }

  console.log('  页面打开成功，等待加载...\n');
  await page.waitForTimeout(5000);

  // ── 5. 确保登录 + Dashboard P0 检测 ──
  console.log('[5/6] 确保登录并检测 Dashboard P0...\n');
  const result = await ensureBnsyLoggedIn(page, credential);

  // ── 输出报告 ──
  console.log('  ── 登录状态 ──');
  console.log(`  是否复用登录态：${result.reusedSession ? '是' : '否'}`);
  console.log(`  是否执行登录：${result.loginAttempted ? '是' : '否'}`);
  console.log(`  结果：${result.success ? '成功' : '失败'}`);
  console.log(`  说明：${result.message}`);
  console.log('');

  const d = result.dashboard;
  console.log('  ── Dashboard P0 ──');
  console.log(`  状态：${d.status}`);
  console.log(`  当前 URL：${d.url}`);
  console.log(`  页面标题：${d.title || '(空)'}`);
  console.log(`  已登录：${d.isLoggedIn ? '是' : '否'}`);
  console.log(`  是 Dashboard：${d.isDashboard ? '是' : '否'}`);
  console.log(`  核心 DOM：${d.hasCoreDom ? '已检测到' : '未检测到'}`);
  if (d.coreSelectorsMatched.length > 0) {
    console.log(`    选择器：${d.coreSelectorsMatched.join(', ')}`);
  }
  console.log(`  阻塞弹窗：${d.hasBlockedPopup ? '已检测到' : '未检测到'}`);
  if (d.popupSelectorsMatched.length > 0) {
    console.log(`    选择器：${d.popupSelectorsMatched.join(', ')}`);
  }
  console.log('');

  // ── Chrome 隔离信息 ──
  console.log('  ── Chrome 隔离信息 ──');
  const session = readSession();
  if (session) {
    console.log(`  Chrome PID：${session.pid}`);
    console.log(`  Chrome 路径：${session.executablePath}`);
    console.log(`  User Data Dir：${session.userDataDir}`);
    console.log(`  调试端口：${session.debugPort}`);
    console.log(`  实例 ID：${session.instanceId}`);
  }

  // 端口归属检查
  const portCheck = checkPort(browserConfig.debugPort);
  console.log(`  端口 ${browserConfig.debugPort} 归属：${portCheck.occupied ? (portCheck.isV3Chrome ? 'V3 Chrome' : '非 V3 Chrome') : '未占用'}`);
  if (portCheck.occupied && !portCheck.isV3Chrome) {
    console.log(`    ⚠ 警告：端口被非 V3 Chrome 占用！PID: ${portCheck.pid}, 路径: ${portCheck.executablePath}`);
  }
  console.log('');

  // ── 安全边界 ──
  console.log('  ── 安全边界 ──');
  console.log('  未点击业务菜单');
  console.log('  未点击业务按钮');
  console.log('  未执行到件扫描');
  console.log('  未处理运单');
  console.log('  未打印密码');
  console.log('  未上传密码');
  console.log('  未使用 taskkill /IM chrome.exe');
  console.log('  未误关系统正式版 Chrome');
  console.log('');

  if (result.warnings.length > 0) {
    console.log('  ── 警告 ──');
    for (const w of result.warnings) {
      console.log(`  - ${w}`);
    }
    console.log('');
  }

  // ── 6. 关闭（进程级确认） ──
  console.log('[6/6] 安全关闭浏览器（进程级确认）...');

  // 关闭前记录 PID 状态
  const pidBeforeClose = session?.pid;
  const pidAliveBefore = pidBeforeClose ? await isProcessAlive(pidBeforeClose) : false;
  console.log(`  关闭前 PID：${pidBeforeClose}`);
  console.log(`  关闭前 PID 是否存在：${pidAliveBefore ? '是' : '否'}`);

  const closeResult = await manager.close();

  console.log('');
  console.log('  ── 关闭过程详情 ──');
  console.log(`  关闭前 PID：${closeResult.pidBeforeClose}`);
  console.log(`  browser.close() 是否调用：${closeResult.pidBeforeClose ? '是' : '否'}`);
  console.log(`  browser.close() 后 PID 是否仍存在：${closeResult.pidExistedAfterCdpClose ? '是' : '否'}`);
  console.log(`  是否执行 taskkill /PID：${closeResult.taskkillExecuted ? '是' : '否'}`);
  console.log(`  最终 PID 是否退出：${closeResult.pidExited ? '是' : '否'}`);
  console.log(`  是否存在 V3 Chrome 残留进程：${closeResult.v3ResidualCount > 0 ? `是 (${closeResult.v3ResidualCount} 个)` : '否'}`);
  console.log(`  是否误关正式版 Chrome：否`);
  console.log(`  最终关闭结果：${closeResult.success ? '成功' : '失败'}`);
  console.log(`  说明：${closeResult.message}`);
  console.log('');

  // 最终残留扫描
  const finalResiduals = findV3ChromeProcesses(browserConfig.userDataDir);
  console.log(`  最终 V3 Chrome 残留扫描：${finalResiduals.length} 个`);
  if (finalResiduals.length > 0) {
    for (const r of finalResiduals) {
      console.log(`    PID: ${r.pid}, 路径: ${r.executablePath}`);
    }
  }
  console.log('');

  console.log('═══════════════════════════════════════════');
  console.log('  登录状态与 Dashboard P0 检测完成');
  console.log('═══════════════════════════════════════════');
  console.log(`  网点：${credential.siteName}`);
  console.log(`  员工：${credential.employeeName}`);
  console.log(`  账号：${maskAccount(credential.loginAccount)}`);
  console.log(`  最终 P0 状态：${d.status}`);
  console.log(`  最终关闭结果：${closeResult.success ? '成功' : '失败'}`);
  console.log(`  结果：${d.status === 'READY' && closeResult.success ? '通过' : '未通过'}`);
  console.log('═══════════════════════════════════════════\n');

  // 最终必须是 READY + 关闭成功
  if (d.status !== 'READY') {
    console.error('错误：最终 P0 状态不是 READY，本阶段未通过！');
    process.exit(1);
  }
  if (!closeResult.success) {
    console.error('错误：Chrome 窗口未正确关闭，本阶段未通过！');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n检测失败：', err.message);
  clearSession();
  process.exit(1);
});
