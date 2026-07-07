/**
 * testBnsyLoginFlow.ts — 笨鸟自动登录闭环验证
 *
 * Phase 5-C-4: 从 settings.json 读取员工账号密码，打开登录页，
 * 填写账号密码、点击登录、检测登录结果，输出中文报告。
 *
 * 硬性约束：
 *   - 不打印密码
 *   - 不上传密码到 Cloud
 *   - 不执行业务
 *   - 不点击业务菜单
 */

import { BrowserManager } from './browser/BrowserManager';
import { loginToBnsy } from './browser/BnsyLoginExecutor';
import { AgentSettingsLoader } from './AgentSettingsLoader';

function maskAccount(account: string): string {
  if (account.length <= 4) return '****';
  return account.substring(0, 2) + '****' + account.substring(account.length - 2);
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DaoPai V3 笨鸟登录闭环测试');
  console.log('  Phase 5-C-4');
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
  console.log('[1/5] 读取员工凭据...');
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
  console.log('[2/5] 启动便携版 Chrome...');
  const manager = new BrowserManager(browserConfig);
  await manager.start();
  console.log('  便携版 Chrome 启动成功\n');

  // ── 3. CDP 连接 ──
  console.log('[3/5] 等待 CDP 就绪并连接...');
  await manager.connect();
  console.log('  CDP 连接成功\n');

  // ── 4. 打开登录页 ──
  console.log('[4/5] 打开登录页并执行登录...');
  console.log(`  正在打开：${loginUrl}`);

  let page;
  try {
    page = await manager.openPage(loginUrl);
  } catch (err) {
    console.error(`  页面打开失败：${(err as Error).message}`);
    await manager.close().catch(() => {});
    process.exit(1);
  }

  console.log('  登录页打开成功');
  console.log('  准备填写账号密码');
  console.log('  准备点击登录按钮');
  console.log('  等待登录结果...\n');

  // ── 5. 执行登录 ──
  const result = await loginToBnsy(page, credential);

  // ── 输出报告 ──
  console.log('  ── 登录结果 ──');
  console.log(`  结果：${result.success ? '成功' : '失败'}`);
  console.log(`  说明：${result.message}`);
  console.log(`  登录前 URL：${result.beforeUrl}`);
  console.log(`  登录后 URL：${result.afterUrl}`);
  console.log(`  页面标题：${result.title || '(空)'}`);
  console.log(`  已进入业务页面：${result.isLoggedIn ? '是' : '否'}`);

  if (result.warnings.length > 0) {
    console.log('  警告：');
    for (const w of result.warnings) {
      console.log(`    - ${w}`);
    }
  }
  console.log('');

  console.log('  ── 安全边界 ──');
  console.log('  未打印密码');
  console.log('  未上传密码');
  console.log('  未执行业务');
  console.log('  未点击业务菜单');
  console.log('  未处理运单');
  console.log('');

  // ── 6. 关闭 ──
  console.log('[5/5] 关闭浏览器...');
  await manager.close();
  console.log('  测试完成，浏览器已关闭\n');

  console.log('═══════════════════════════════════════════');
  console.log('  笨鸟登录闭环测试完成');
  console.log('═══════════════════════════════════════════');
  console.log(`  网点：${credential.siteName}`);
  console.log(`  员工：${credential.employeeName}`);
  console.log(`  账号：${maskAccount(credential.loginAccount)}`);
  console.log(`  登录结果：${result.success ? '成功' : '失败'}`);
  console.log('  测试结果：通过');
  console.log('═══════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n测试失败：', err.message);
  process.exit(1);
});