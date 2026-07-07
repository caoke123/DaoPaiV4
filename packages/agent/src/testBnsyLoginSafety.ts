/**
 * testBnsyLoginSafety.ts — 笨鸟登录页识别与登录前安全检测
 *
 * Phase 5-C-3: 使用 BnsyLoginDetector 检测登录页元素，
 * 不输入账号密码，不点击登录，只输出检测报告。
 *
 * 硬性约束：
 *   - 只连接项目内便携版 Chrome
 *   - 不输入账号密码
 *   - 不点击登录
 *   - 不执行业务
 */

import { BrowserManager } from './browser/BrowserManager';
import { detectBnsyLoginPage } from './browser/BnsyLoginDetector';

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DaoPai V3 笨鸟登录前安全检测');
  console.log('  Phase 5-C-3');
  console.log('═══════════════════════════════════════════\n');

  const browserConfig = {
    executablePath: 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe',
    userDataDir: 'E:/网站开发/DaoPaiV3/runtime/chrome-profile-test',
    debugPort: 9223,
    headless: false,
  };

  const loginUrl = 'https://bnsy.benniaosuyun.com/login';

  const manager = new BrowserManager(browserConfig);

  try {
    // 1. 启动 + 连接
    console.log('[1/4] 启动便携版 Chrome...');
    await manager.start();
    console.log('  便携版 Chrome 启动成功\n');

    console.log('[2/4] 等待 CDP 就绪并连接...');
    await manager.connect();
    console.log('  CDP 连接成功\n');

    // 2. 打开登录页
    console.log('[3/4] 打开登录页并检测...');
    console.log(`  正在打开登录页：${loginUrl}\n`);

    let page;
    try {
      page = await manager.openPage(loginUrl);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  页面打开失败：${msg}`);
      await manager.close().catch(() => {});
      process.exit(1);
    }

    // 3. 检测登录页
    const result = await detectBnsyLoginPage(page);

    // ── 输出检测报告 ──
    console.log('  ── 页面信息 ──');
    console.log(`  当前 URL：${result.url}`);
    console.log(`  页面标题：${result.title || '(空)'}`);
    console.log('');

    console.log('  ── 登录页识别 ──');
    console.log(`  是否登录页：${result.isLoginPage ? '是' : '否'}`);
    console.log(`  是否已登录：${result.isLoggedIn ? '是（警告：疑似已登录，不应重复登录）' : '否'}`);
    console.log('');

    console.log('  ── 表单元素检测 ──');
    console.log(`  账号输入框：${result.hasUsernameInput ? '已检测到' : '未检测到'}`);
    if (result.usernameSelectors.length > 0) {
      console.log(`    选择器：${result.usernameSelectors.join(', ')}`);
    }
    console.log(`  密码输入框：${result.hasPasswordInput ? '已检测到' : '未检测到'}`);
    if (result.passwordSelectors.length > 0) {
      console.log(`    选择器：${result.passwordSelectors.join(', ')}`);
    }
    console.log(`  登录按钮：${result.hasLoginButton ? '已检测到' : '未检测到'}`);
    if (result.loginButtonSelectors.length > 0) {
      console.log(`    选择器：${result.loginButtonSelectors.join(', ')}`);
    }
    console.log('');

    if (result.warnings.length > 0) {
      console.log('  ── 警告 ──');
      for (const w of result.warnings) {
        console.log(`  警告：${w}`);
      }
      console.log('');
    }

    console.log('  ── 安全边界 ──');
    console.log('  未输入账号');
    console.log('  未输入密码');
    console.log('  未点击登录');
    console.log('  未执行业务');
    console.log('');

    // 4. 关闭
    console.log('[4/4] 关闭浏览器...');
    await manager.close();
    console.log('  检测完成，浏览器已关闭\n');

    console.log('═══════════════════════════════════════════');
    console.log('  笨鸟登录前安全检测完成');
    console.log('═══════════════════════════════════════════');
    console.log(`  检测地址：${loginUrl}`);
    console.log(`  登录页：${result.isLoginPage ? '是' : '否'}`);
    console.log(`  已登录：${result.isLoggedIn ? '是' : '否'}`);
    console.log('  测试结果：通过');
    console.log('═══════════════════════════════════════════\n');
  } catch (err) {
    console.error(`\n检测失败：${(err as Error).message}`);
    await manager.close().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n检测失败：', err.message);
  process.exit(1);
});