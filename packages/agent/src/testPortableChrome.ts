/**
 * testPortableChrome.ts — 便携版 Chrome 连接测试
 *
 * Phase 5-C-1: 使用 BrowserManager 封装浏览器启动和连接逻辑。
 *
 * 硬性约束：
 *   - 只连接项目内便携版 Chrome
 *   - 不连接系统正式版 Chrome
 *   - 不使用用户默认 Chrome Profile
 *   - 不执行真实业务任务
 */

import { BrowserManager } from './browser/BrowserManager';

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DaoPai V3 便携版 Chrome 连接测试');
  console.log('  Phase 5-C-1 (BrowserManager)');
  console.log('═══════════════════════════════════════════\n');

  // 使用硬编码测试配置（不依赖 agent.json，避免测试时缺少执行电脑授权码）
  const browserConfig = {
    executablePath: 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe',
    userDataDir: 'E:/网站开发/DaoPaiV3/runtime/chrome-profile-test',
    debugPort: 9223,
    headless: false,
  };

  const manager = new BrowserManager(browserConfig);

  try {
    // 1. 启动 Chrome
    console.log('[1/4] 启动便携版 Chrome...');
    await manager.start();
    console.log('  便携版 Chrome 启动成功\n');

    // 2. CDP 连接
    console.log('[2/4] 等待 CDP 就绪并连接...');
    await manager.connect();
    console.log('  CDP 连接成功\n');

    // 3. 获取页面
    console.log('[3/4] 获取页面并执行健康检查...');
    const page = await manager.getOrCreatePage();
    console.log('  Playwright 连接成功');

    const health = await manager.healthCheck();
    console.log(`  页面健康检查通过`);
    console.log(`  UserAgent: ${health.userAgent}`);
    console.log(`  页面标题: "${health.title}"\n`);

    // 4. 关闭
    console.log('[4/4] 关闭浏览器...');
    await manager.close();
    console.log('  测试完成，浏览器已关闭\n');

    console.log('═══════════════════════════════════════════');
    console.log('  便携版 Chrome 连接测试完成');
    console.log('═══════════════════════════════════════════');
    console.log(`  Chrome 路径：${browserConfig.executablePath}`);
    console.log(`  调试端口：${browserConfig.debugPort}`);
    console.log(`  用户目录：${browserConfig.userDataDir}`);
    console.log('  测试结果：通过');
    console.log('═══════════════════════════════════════════\n');
  } catch (err) {
    console.error(`\n测试失败：${(err as Error).message}`);
    await manager.close().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n测试失败：', err.message);
  process.exit(1);
});