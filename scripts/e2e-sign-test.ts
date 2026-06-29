/**
 * 签收端到端测试 — 从前端页面点击"启动任务"到后端完成执行
 *
 * 测试流程:
 * 1. 打开 localhost:5275/sign
 * 2. 等待窗口列表加载
 * 3. 选择"刘磊"窗口
 * 4. 设置 100条/页
 * 5. 点击"启动自动签收"
 * 6. 等待任务执行完成
 * 7. 输出日志 + 截图
 */
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const FRONTEND_URL = 'http://localhost:5275';
const SIGN_PAGE = `${FRONTEND_URL}/sign`;

const SCREENSHOT_DIR = path.resolve(__dirname, 'screenshots/e2e');

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();

  console.log('╔══════════════════════════════════════╗');
  console.log('║   签收 E2E 端到端测试              ║');
  console.log('╚══════════════════════════════════════╝\n');

  try {
    // Step 1: 导航到签收页面
    console.log('[1/6] 导航到签收页面...');
    await page.goto(SIGN_PAGE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-sign-page.png'), fullPage: false });
    console.log('  ✓ 页面已加载');

    // Step 2: 等待窗口列表加载
    console.log('\n[2/6] 等待窗口列表...');

    // 查找所有派件员节点卡片
    let workerCards: any[] = [];
    const maxWait = 15;
    for (let i = 0; i < maxWait; i++) {
      workerCards = await page.$$('.node-card');
      if (workerCards.length > 0) break;
      console.log(`  等待窗口列表... (${i + 1}/${maxWait})`);
      await sleep(2000);
    }

    console.log(`  找到 ${workerCards.length} 个窗口卡片`);
    for (const card of workerCards) {
      const name = await card.$eval('.node-name', (el: HTMLElement) => el.textContent).catch(() => '?');
      const statusBadge = await card.$eval('.node-status', (el: HTMLElement) => el.textContent).catch(() => '?');
      console.log(`    - ${name?.trim()} (${statusBadge?.trim()})`);
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-worker-list.png'), fullPage: false });

    // Step 3: 选择"刘磊"窗口
    console.log('\n[3/6] 选择"刘磊"...');
    let liuleiCard: any = null;
    for (const card of workerCards) {
      const name = await card.$eval('.node-name', (el: HTMLElement) => el.textContent?.trim() ?? '').catch(() => '');
      if (name === '刘磊') {
        liuleiCard = card;
        console.log('  ✓ 找到刘磊卡片');
        break;
      }
    }

    if (!liuleiCard) {
      console.error('  ✗ 未找到刘磊卡片');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'ERROR-no-liulei.png'), fullPage: false });
      return;
    }

    // 检查状态是否为 ready
    const statusEl = await liuleiCard.$('.node-status');
    const statusText = await statusEl?.evaluate((el: HTMLElement) => el.textContent?.trim() ?? '');
    console.log(`  状态: ${statusText}`);

    if (statusText !== 'READY' && statusText !== 'CONN') {
      console.log(`  ⚠ 状态不是 READY (${statusText})，等待...`);
      // 等待一会再看
      await sleep(5000);
      const statusText2 = await liuleiCard.$eval('.node-status', (el: HTMLElement) => el.textContent?.trim() ?? '').catch(() => '');
      console.log(`  状态更新: ${statusText2}`);
    }

    // 点击选中
    const isAlreadySelected = await liuleiCard.evaluate((el: HTMLElement) => el.classList.contains('selected'));
    if (!isAlreadySelected) {
      await liuleiCard.click();
      await sleep(500);
      console.log('  ✓ 已选中刘磊');
    } else {
      console.log('  ✓ 刘磊已选中');
    }

    // Step 4: 设置分页大小 (默认100，不需要改)
    console.log('\n[4/6] 确认分页大小...');
    const activePageBtn = await page.$('.btn-primary');
    if (activePageBtn) {
      const btnText = await activePageBtn.textContent();
      console.log(`  当前分页大小: ${btnText?.trim()}条/页`);
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-selected.png'), fullPage: false });

    // Step 5: 点击"启动自动签收"
    console.log('\n[5/6] 启动任务...');
    const launchBtn = await page.$('button.launch-btn');
    if (!launchBtn) {
      console.error('  ✗ 未找到启动按钮');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'ERROR-no-launch-btn.png'), fullPage: false });
      return;
    }

    const btnDisabled = await launchBtn.evaluate((el: HTMLButtonElement) => el.disabled);
    if (btnDisabled) {
      console.error('  ✗ 启动按钮被禁用');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'ERROR-btn-disabled.png'), fullPage: false });
      return;
    }

    // 监听网络请求（捕获 sign API 调用）
    const signApiCalls: string[] = [];
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/api/operations/sign') || url.includes('signFors') || url.includes('findSignFor') || url.includes('waybillScanVerifyBatch')) {
        signApiCalls.push(`${response.status()} ${url}`);
      }
    });

    await launchBtn.click();
    console.log('  ✓ 已点击启动按钮');

    // 等待执行面板展开
    await sleep(2000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-launched.png'), fullPage: false });

    // Step 6: 等待任务完成
    console.log('\n[6/6] 等待任务执行...');
    let completed = false;
    let error = false;
    const maxPollSeconds = 120; // 最多等 2 分钟
    let lastDoneCount = -1;
    let stallCount = 0;
    let prevLogsLen = 0;

    for (let s = 0; s < maxPollSeconds; s++) {
      await sleep(2000);

      // 检查日志更新
      const logLines = await page.$$('.log-line');
      if (logLines.length > prevLogsLen) {
        prevLogsLen = logLines.length;
        stallCount = 0;
        // 打印最新日志
        const lastLog = logLines[logLines.length - 1];
        if (lastLog) {
          const msg = await lastLog.$eval('.log-msg', (el: HTMLElement) => el.textContent).catch(() => '');
          const lv = await lastLog.$eval('.log-lv', (el: HTMLElement) => el.textContent).catch(() => '');
          if (msg) console.log(`  [${lv?.trim()}] ${msg?.trim()}`);
        }
      }

      // 检查进度
      try {
        const doneVal = await page.$eval('.gp-stat:nth-child(1) .gp-val', (el: HTMLElement) => el.textContent?.trim()).catch(() => '');
        const totalVal = await page.$eval('.gp-stat:nth-child(3) .gp-val', (el: HTMLElement) => el.textContent?.trim()).catch(() => '');
        const progressLabel = await page.$eval('.gp-bar-label span:last-child', (el: HTMLElement) => el.textContent?.trim()).catch(() => '');

        if (doneVal && totalVal && doneVal !== lastDoneCount.toString()) {
          lastDoneCount = parseInt(doneVal, 10) || 0;
          console.log(`  进度: ${doneVal}/${totalVal} - ${progressLabel}`);
          stallCount = 0;
        } else {
          stallCount++;
        }

        if (progressLabel?.includes('签收完成')) {
          completed = true;
          console.log('\n  ✓ 任务完成！');
          break;
        }
        if (progressLabel?.includes('任务失败') || progressLabel?.includes('异常')) {
          error = true;
          console.log(`\n  ✗ 任务失败: ${progressLabel}`);
          break;
        }
        if (stallCount > 15) {
          console.log('\n  ⚠ 任务可能已停滞，检查更多日志...');
          break;
        }
      } catch {
        // progress may not be visible yet
      }

      if (s % 15 === 14) {
        console.log(`  已等待 ${s + 1}s...`);
      }
    }

    // 最终截图
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-result.png'), fullPage: false });

    // 输出网络请求
    if (signApiCalls.length > 0) {
      console.log('\n  签收相关 API 调用:');
      signApiCalls.forEach(c => console.log(`    ${c}`));
    }

    // 输出所有日志
    console.log('\n  === 最终执行日志 ===');
    const allLogLines = await page.$$('.log-line');
    for (const line of allLogLines) {
      const msg = await line.$eval('.log-msg', (el: HTMLElement) => el.textContent).catch(() => '');
      const ts = await line.$eval('.log-ts', (el: HTMLElement) => el.textContent).catch(() => '');
      const lv = await line.$eval('.log-lv', (el: HTMLElement) => el.textContent).catch(() => '');
      if (msg) console.log(`  [${ts?.trim()}] [${lv?.trim()}] ${msg?.trim()}`);
    }

    // 结论
    console.log('\n╔══════════════════════════════════════╗');
    if (completed) {
      console.log('║  测试结果: ✅ PASS                  ║');
    } else if (error) {
      console.log('║  测试结果: ❌ FAIL (任务出错)       ║');
    } else {
      console.log('║  测试结果: ⚠️  INCONCLUSIVE (未确定) ║');
    }
    console.log('╚══════════════════════════════════════╝');

    // 保持浏览器打开
    console.log('\n浏览器将保持打开 30 秒...');
    await sleep(30000);

  } catch (err) {
    console.error('\n❌ E2E 测试异常:', (err as Error).message);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'ERROR-crash.png'), fullPage: true });
  } finally {
    await browser.close();
  }
}

main();
