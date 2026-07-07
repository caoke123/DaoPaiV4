/**
 * testBnsyLoginPage.ts — 笨鸟登录页连通性检测
 *
 * Phase 5-C-2: 使用 BrowserManager 打开笨鸟登录页，验证页面可访问。
 *
 * 硬性约束：
 *   - 只连接项目内便携版 Chrome
 *   - 不登录、不输入账号密码
 *   - 不点击任何业务按钮
 *   - 不执行到件扫描
 */

import { BrowserManager } from './browser/BrowserManager';

// ── 登录页特征检测 ──────────────────────────────────────

function detectLoginFeatures(bodyText: string, pageUrl: string): {
  hasLoginUrl: boolean;
  hasLoginKeywords: string[];
  isLikelyLoginPage: boolean;
} {
  const hasLoginUrl = pageUrl.toLowerCase().includes('login');

  const keywords = ['登录', '账号', '密码', '用户名', 'sign in', 'log in'];
  const found: string[] = [];

  for (const kw of keywords) {
    if (bodyText.includes(kw)) {
      found.push(kw);
    }
  }

  const isLikelyLoginPage = hasLoginUrl || found.length > 0;

  return { hasLoginUrl, hasLoginKeywords: found, isLikelyLoginPage };
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DaoPai V3 笨鸟登录页连通性检测');
  console.log('  Phase 5-C-2');
  console.log('═══════════════════════════════════════════\n');

  // 使用硬编码测试配置（不依赖 agent.json）
  const browserConfig = {
    executablePath: 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe',
    userDataDir: 'E:/网站开发/DaoPaiV3/runtime/chrome-profile-test',
    debugPort: 9223,
    headless: false,
  };

  const loginUrl = 'https://bnsy.benniaosuyun.com/login';

  const manager = new BrowserManager(browserConfig);

  try {
    // 1. 启动 Chrome
    console.log('[1/5] 启动便携版 Chrome...');
    await manager.start();
    console.log('  便携版 Chrome 启动成功\n');

    // 2. CDP 连接
    console.log('[2/5] 等待 CDP 就绪并连接...');
    await manager.connect();
    console.log('  CDP 连接成功\n');

    // 3. 打开笨鸟登录页
    console.log('[3/5] 打开笨鸟登录页...');
    console.log(`  正在打开：${loginUrl}`);

    let page;
    try {
      page = await manager.openPage(loginUrl);
      console.log('  页面打开成功\n');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('timeout') || msg.includes('超时')) {
        console.error('  页面打开失败：超时（网络不可达或页面加载过慢）');
      } else if (msg.includes('net::ERR_NAME_NOT_RESOLVED') || msg.includes('DNS')) {
        console.error('  页面打开失败：DNS 解析失败');
      } else if (msg.includes('net::ERR_CERT') || msg.includes('证书')) {
        console.error('  页面打开失败：证书错误');
      } else {
        console.error(`  页面打开失败：${msg}`);
      }
      await manager.close().catch(() => {});
      process.exit(1);
    }

    // 4. 检测登录页特征
    console.log('[4/5] 检测登录页特征...');
    const pageUrl = page.url();
    const pageTitle = await page.title();
    const bodyText = await page.evaluate(() => {
      const body = document.body;
      return body ? body.innerText.substring(0, 500) : '';
    });

    console.log(`  当前 URL：${pageUrl}`);
    console.log(`  页面标题：${pageTitle || '(空)'}`);

    const features = detectLoginFeatures(bodyText, pageUrl);

    if (features.isLikelyLoginPage) {
      console.log(`  登录页特征：已检测到`);
      if (features.hasLoginUrl) {
        console.log(`    - URL 包含 login`);
      }
      if (features.hasLoginKeywords.length > 0) {
        console.log(`    - 页面文本包含关键词：${features.hasLoginKeywords.join('、')}`);
      }
    } else {
      console.log('  登录页特征：页面可访问，但未确认登录页特征');
      if (bodyText.length > 0) {
        console.log(`  页面文本前 500 字符：${bodyText.substring(0, 200)}...`);
      }
    }

    console.log('');

    // 5. 关闭浏览器
    console.log('[5/5] 关闭浏览器...');
    await manager.close();
    console.log('  检测完成，浏览器已关闭\n');

    console.log('═══════════════════════════════════════════');
    console.log('  笨鸟登录页连通性检测完成');
    console.log('═══════════════════════════════════════════');
    console.log(`  检测地址：${loginUrl}`);
    console.log(`  实际 URL：${pageUrl}`);
    console.log(`  页面标题：${pageTitle || '(空)'}`);
    console.log(`  登录页特征：${features.isLikelyLoginPage ? '已检测到' : '未确认'}`);
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