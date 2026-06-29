/**
 * 签收 E2E 测试 V2 — 从前端点击启动 + API 轮询进度
 * 超时 120 秒，应对 PageStateManager 完整流程
 */
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const FRONTEND_URL = 'http://localhost:5275';
const BACKEND_URL = 'http://localhost:3200';
const SIGN_PAGE = `${FRONTEND_URL}/sign`;
const SCREENSHOT_DIR = path.resolve(__dirname, 'screenshots/e2e');

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function apiGet(url: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status}`);
  return resp.json();
}

async function main() {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();

  console.log('╔══════════════════════════════════════╗');
  console.log('║   签收 E2E V2 (120s timeout)        ║');
  console.log('╚══════════════════════════════════════╝\n');

  try {
    await page.goto(SIGN_PAGE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);

    // 等待刘磊卡片就绪
    console.log('[1] 等待窗口列表...');
    for (let i = 0; i < 30; i++) {
      const cards = await page.$$('.node-card');
      if (cards.length > 0) break;
      await sleep(2000);
    }

    // 选中刘磊
    const cards = await page.$$('.node-card');
    let liulei: any = null;
    for (const c of cards) {
      const n = await c.$eval('.node-name', (el: any) => el.textContent?.trim() ?? '').catch(() => '');
      if (n === '刘磊') { liulei = c; break; }
    }
    if (!liulei) { console.error('未找到刘磊'); return; }

    const sel = await liulei.evaluate((el: any) => el.classList.contains('selected'));
    if (!sel) { await liulei.click(); await sleep(300); }
    console.log('  ✓ 已选中刘磊');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'v2-pre-launch.png') });

    // 点击启动
    console.log('[2] 启动任务...');
    const btn = await page.$('button.launch-btn');
    if (!btn) { console.error('未找到启动按钮'); return; }

    // 捕获网络请求
    let taskId: string | null = null;
    page.on('response', async (resp) => {
      if (resp.url().includes('/api/operations/sign') && resp.status() === 200) {
        try {
          const body = await resp.json();
          taskId = body.taskId;
          console.log(`  [API] 任务已创建: ${taskId}`);
        } catch {}
      }
    });

    await btn.click();
    console.log('  ✓ 已点击');

    // 等待 taskId
    for (let i = 0; i < 20; i++) {
      if (taskId) break;
      await sleep(1000);
    }
    if (!taskId) { console.error('未获取到 taskId'); return; }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'v2-launched.png') });

    // API 轮询进度
    console.log('[3] 轮询进度 (最多120秒)...');
    let lastLogLen = 0;
    const start = Date.now();

    for (let i = 0; i < 120; i++) {
      await sleep(2000);

      try {
        // 获取前端日志更新
        const logs = await page.$$('.log-line');
        if (logs.length > lastLogLen) {
          for (let j = lastLogLen; j < logs.length; j++) {
            const msg = await logs[j].$eval('.log-msg', (el: any) => el.textContent).catch(() => '');
            const lv = await logs[j].$eval('.log-lv', (el: any) => el.textContent).catch(() => '');
            if (msg) console.log(`  [${lv?.trim()}] ${msg?.trim()}`);
          }
          lastLogLen = logs.length;
        }

        // API 进度
        const progress = await apiGet(`${BACKEND_URL}/api/tasks/${taskId}/progress`).catch(() => null);
        if (progress) {
          const label = progress.status === 'done' ? '✓ 完成' : progress.status === 'failed' ? '✗ 失败' : '⏳ 进行中';
          if (i % 5 === 0) {
            console.log(`  ${label} done=${progress.done}/${progress.total} fails=${progress.failCount ?? 0} (${Math.round((Date.now()-start)/1000)}s)`);
          }
          if (progress.status === 'done' || progress.status === 'failed') {
            console.log(`  >> 最终状态: ${progress.status} total=${progress.total} done=${progress.done} failCount=${progress.failCount}`);
            break;
          }
        }
      } catch (e) {
        // ignore
      }

      if (i === 119) console.log('  ⚠ 超时 (120s)');
    }

    // 获取最终日志
    const finalLogs = await apiGet(`${BACKEND_URL}/api/tasks/${taskId}/logs?limit=200`).catch(() => []);
    console.log(`\n[4] 后端日志 (${finalLogs.length} 条):`);
    for (const l of finalLogs) {
      const ts = new Date(l.timestamp).toLocaleTimeString();
      console.log(`  [${ts}] [${l.level?.toUpperCase()}] ${l.message}`);
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'v2-final.png') });

    console.log('\n测试完成，截图保存在 scripts/screenshots/e2e/');
    console.log('浏览器保持 60 秒...');
    await sleep(60000);
  } catch (e) {
    console.error('异常:', (e as Error).message);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'v2-crash.png') });
  } finally {
    await browser.close();
  }
}

main();
