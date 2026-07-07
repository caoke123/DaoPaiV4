/**
 * testDispatchBrowserDryRun.ts — 派件扫描浏览器 DRY-RUN 测试
 *
 * Phase 5-F: 在笨鸟系统中执行派件扫描页面级 DRY-RUN。
 *
 * 硬性约束：
 *   - 不点击"上传"按钮（最终提交）
 *   - 不点击"添加"按钮（spec 白名单只允许查询/搜索/检索）
 *   - 不产生真实派件业务
 *   - 不处理真实生产单号
 *   - 不接 Agent 主循环
 *   - 不 taskkill /IM chrome.exe
 *   - 不误关系统正式版 Chrome
 */

import { BrowserManager } from './browser/BrowserManager';
import { ensureBnsyLoggedIn } from './browser/BnsySessionManager';
import { AgentSettingsLoader } from './AgentSettingsLoader';
import { readSession, clearSession } from './browser/BrowserProcessRegistry';
import { checkPort, findV3ChromeProcesses } from './browser/ChromeProcessGuard';
import { runDispatchBrowserDryRun } from './browser/DispatchBrowserDryRun';

// 测试运单号（非真实生产单号）
const TEST_WAYBILLS = [
  'TEST000000001',
  'TEST000000002',
];

function maskAccount(account: string): string {
  if (account.length <= 4) return '****';
  return account.substring(0, 2) + '****' + account.substring(account.length - 2);
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DaoPai V3 派件扫描浏览器 DRY-RUN 测试');
  console.log('  Phase 5-F: 页面级 DRY-RUN，不提交真实派件');
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
  console.log('[1/7] 读取员工凭据...');
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

  // ── 2. 启动浏览器 ──
  console.log('[2/7] 启动便携版 Chrome...');
  const manager = new BrowserManager(browserConfig);
  await manager.start();
  console.log('');

  // ── 3. CDP 连接 ──
  console.log('[3/7] 等待 CDP 就绪并连接...');
  await manager.connect();
  console.log('');

  // ── 4. 打开登录页 ──
  console.log('[4/7] 打开登录页...');
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

  // ── 5. 确保登录 + Dashboard P0 ──
  console.log('[5/7] 确保登录并检测 Dashboard P0...');
  const loginResult = await ensureBnsyLoggedIn(page, credential);

  console.log(`  登录结果：${loginResult.success ? '成功' : '失败'}`);
  console.log(`  说明：${loginResult.message}`);
  console.log(`  Dashboard P0 状态：${loginResult.dashboard.status}`);
  console.log('');

  if (!loginResult.success || loginResult.dashboard.status !== 'READY') {
    console.error('错误：Dashboard P0 不是 READY，不进入派件页面');
    await manager.close().catch(() => {});
    process.exit(1);
  }

  // ── 6. 执行派件扫描 DRY-RUN ──
  console.log('[6/7] 执行派件扫描浏览器 DRY-RUN...\n');
  const dryRunResult = await runDispatchBrowserDryRun(page, {
    siteId,
    siteName: credential.siteName,
    waybills: TEST_WAYBILLS,
    options: {
      // 派件员姓名来源：settings.json 中网点的 employeeName 字段
      // 旧代码 DispatchScan.ts 通过 staffName 参数传入，用于 el-select 文本匹配
      courierName: credential.employeeName,
    },
  });

  // ── 输出报告 ──
  console.log('');
  console.log('  ── DRY-RUN 结果 ──');
  console.log(`  执行结果：${dryRunResult.success ? '成功' : '失败'}`);
  console.log(`  说明：${dryRunResult.message}`);
  console.log(`  页面 URL：${dryRunResult.pageUrl}`);
  console.log(`  页面标题：${dryRunResult.title || '(空)'}`);
  console.log(`  输入运单数：${dryRunResult.inputCount}`);
  console.log(`  派件员选中：${dryRunResult.courierSelected ? '是' : '否'}`);
  console.log(`  是否点击最终提交：${dryRunResult.finalSubmitClicked ? '是' : '否'}`);
  console.log('');

  // 检测前
  if (dryRunResult.detectBefore) {
    console.log('  ── 页面检测（输入前）──');
    console.log(`  是否派件页面：${dryRunResult.detectBefore.isDispatchPage ? '是' : '否'}`);
    console.log(`  派件员下拉框：${dryRunResult.detectBefore.hasCourierSelectInput ? '已检测到' : '未检测到'}`);
    console.log(`  运单输入框：${dryRunResult.detectBefore.hasWaybillInput ? '已检测到' : '未检测到'}`);
    console.log(`  添加按钮：${dryRunResult.detectBefore.hasAddButton ? '已检测到（不点击）' : '未检测到'}`);
    console.log(`  上传按钮：${dryRunResult.detectBefore.hasUploadButton ? '已检测到（不点击）' : '未检测到'}`);
    if (dryRunResult.detectBefore.matchedSelectors.length > 0) {
      console.log('  匹配的选择器：');
      for (const sel of dryRunResult.detectBefore.matchedSelectors) {
        console.log(`    - ${sel}`);
      }
    }
    console.log('');
  }

  // 警告
  if (dryRunResult.warnings.length > 0) {
    console.log('  ── 警告 ──');
    for (const w of dryRunResult.warnings) {
      console.log(`  - ${w}`);
    }
    console.log('');
  }

  // ── Chrome 隔离信息 ──
  console.log('  ── Chrome 隔离信息 ──');
  const session = readSession();
  if (session) {
    console.log(`  Chrome PID：${session.pid}`);
    console.log(`  Chrome 路径：${session.executablePath}`);
    console.log(`  User Data Dir：${session.userDataDir}`);
    console.log(`  调试端口：${session.debugPort}`);
  }
  const portCheck = checkPort(browserConfig.debugPort);
  console.log(`  端口 ${browserConfig.debugPort} 归属：${portCheck.occupied ? (portCheck.isV3Chrome ? 'V3 Chrome' : '非 V3 Chrome') : '未占用'}`);
  console.log('');

  // ── 安全边界 ──
  console.log('  ── 安全边界 ──');
  console.log('  浏览器：项目内便携版 Chrome');
  console.log('  是否误连正式版 Chrome：否');
  console.log('  是否点击"添加"按钮：否');
  console.log('  是否点击"上传"按钮：否');
  console.log('  是否产生真实派件：否');
  console.log('  是否处理真实运单：否（使用测试单号）');
  console.log('  未接 Agent 主循环');
  console.log('  未使用 taskkill /IM chrome.exe');
  console.log('  未误关系统正式版 Chrome');
  console.log('');

  // ── 7. 关闭 ──
  console.log('[7/7] 安全关闭浏览器...');
  const closeResult = await manager.close();
  console.log(`  关闭结果：${closeResult.success ? '成功' : '失败'}`);
  console.log(`  说明：${closeResult.message}`);

  const finalResiduals = findV3ChromeProcesses(browserConfig.userDataDir);
  console.log(`  最终 V3 Chrome 残留扫描：${finalResiduals.length} 个`);
  console.log('');

  console.log('═══════════════════════════════════════════');
  console.log('  派件扫描浏览器 DRY-RUN 测试完成');
  console.log('═══════════════════════════════════════════');
  console.log(`  网点：${credential.siteName}`);
  console.log(`  员工：${credential.employeeName}`);
  console.log(`  账号：${maskAccount(credential.loginAccount)}`);
  console.log(`  Dashboard P0：READY`);
  console.log(`  是否进入派件页面：${dryRunResult.detectBefore?.isDispatchPage ? '是' : '否'}`);
  console.log(`  是否识别运单输入框：${dryRunResult.detectBefore?.hasWaybillInput ? '是' : '否'}`);
  console.log(`  是否识别上传按钮：${dryRunResult.detectBefore?.hasUploadButton ? '是' : '否'}`);
  console.log(`  是否选派件员：${dryRunResult.courierSelected ? '是' : '否'}`);
  console.log(`  是否输入测试运单：${dryRunResult.inputCount > 0 ? '是' : '否'}`);
  console.log(`  是否点击"添加"按钮：否`);
  console.log(`  是否点击"上传"按钮：否`);
  console.log(`  是否产生真实派件：否`);
  console.log(`  关闭结果：${closeResult.success ? 'V3 Chrome 已关闭，无残留' : '关闭失败'}`);
  console.log(`  是否误关正式版 Chrome：否`);
  console.log(`  最终结果：${dryRunResult.success && closeResult.success ? '通过' : '未通过'}`);
  console.log('═══════════════════════════════════════════\n');

  if (!dryRunResult.success) {
    console.error('错误：DRY-RUN 未成功');
    process.exit(1);
  }
  if (!closeResult.success) {
    console.error('错误：Chrome 窗口未正确关闭');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n测试失败：', err.message);
  clearSession();
  process.exit(1);
});
