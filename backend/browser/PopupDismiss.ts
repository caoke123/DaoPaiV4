// 弹窗清除工具模块
// 打开 Worker Window（员工账号）时，凤凰系统常会出现公告、升级提示、广告等弹窗，必须自动清除
// 注意：只清除"广告/公告弹窗"，不处理"操作确认弹窗"（如批量签收的二次确认，由操作模块自行处理）
import type { Page, ElementHandle } from 'playwright';

/** 不需要二次确认就能关闭的按钮文本（点它们直接关弹窗） */
const DISMISS_BTN_TEXTS = ['取消', '关闭', '否', '暂不', '忽略', '跳过', '我再想想', '以后再说'];

/** 二次确认关闭弹窗的识别关键词 — 匹配到则点"确定" */
const CLOSE_CONFIRM_KEYWORDS = [
  '确定关闭', '是否关闭', '确认关闭', '确定要关闭',
  '确定取消', '确认取消',
  '放弃修改', '放弃保存', '不保存',
  '退出当前', '退出编辑',
  '关闭页面', '关闭窗口',
  '取消支付', '放弃支付', '关闭支付',
];

/** 顽固弹窗额外选择器（pay-dialog 等） */
const STUBBORN_DIALOG_SELECTORS = [
  '.el-dialog__wrapper:not([style*="display: none"])',
  '.pay-dialog:not([style*="display: none"])',
];

/**
 * 判断弹窗文本是否为"关闭类"二次确认（而非操作类确认）
 * 关闭类：确定关闭？→ 点"确定" = 关闭弹窗 ✓
 * 操作类：确定删除？ → 点"确定" = 执行删除 ✗
 */
function isCloseConfirmation(text: string): boolean {
  // 去掉所有空白字符再匹配（如 "取 消" → "取消"）
  const normalized = text.replace(/\s+/g, '');
  return CLOSE_CONFIRM_KEYWORDS.some(kw => normalized.includes(kw));
}

/**
 * 点击弹窗中的按钮
 * 优先级：取消/关闭按钮 > 关闭类二次确认的"确定"按钮
 * @returns 是否成功点击了某个按钮
 */
async function clickSmartButton(container: ElementHandle): Promise<boolean> {
  // 先读取容器内的文本，判断弹窗性质
  const fullText = (await container.textContent().catch(() => '')) ?? '';

  // 查找所有按钮
  const buttons = await container.$$('button, .el-button, .btn, [role="button"]').catch(() => []);

  /**
   * 辅助：查找并点击包含指定文本的按钮
   * @param texts 按优先级排列的匹配文本列表
   */
  const tryClickByText = async (texts: string[]): Promise<boolean> => {
    for (const targetText of texts) {
      for (const btn of buttons) {
        const rawText = (await btn.textContent().catch(() => '')) ?? '';
        // 去掉所有空白字符再匹配（如 "取 消" → "取消"）
        const text = rawText.replace(/\s+/g, '');
        if (text.includes(targetText)) {
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible) {
            console.log(`[PopupDismiss] 点击按钮 "${text}"`);
            await btn.click().catch(() => {});
            return true;
          }
        }
      }
    }
    return false;
  };

  // 第一优先级：点击"取消"
  if (await tryClickByText(['取消'])) return true;

  // 第二优先级：点击其他关闭类按钮
  const otherDismiss = DISMISS_BTN_TEXTS.filter(t => t !== '取消');
  if (await tryClickByText(otherDismiss)) return true;

  // 第三优先级：关闭类二次确认 → 点击"确定"/"是"
  if (isCloseConfirmation(fullText)) {
    if (await tryClickByText(['确定', '是'])) return true;
  }

  return false;
}

/**
 * 尝试用 Esc 或点击遮罩关闭弹窗
 */
async function closeViaEscapeOrOverlay(page: Page): Promise<void> {
  // 1. 点击遮罩层
  const overlaySelectors = [
    '.v-modal:not([style*="display: none"])',
    '.el-overlay:not([style*="display: none"])',
  ];
  for (const sel of overlaySelectors) {
    const overlays = await page.$$(sel).catch(() => []);
    for (const overlay of overlays) {
      await overlay.click().catch(() => {});
      await page.waitForTimeout(200).catch(() => {});
    }
  }

  // 2. Escape 键
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200).catch(() => {});
}

/**
 * 检查当前页面是否仍有可见弹窗
 */
async function stillHasPopups(page: Page): Promise<boolean> {
  const allSelectors = [
    '.el-dialog__wrapper',
    '.pay-dialog',
    '.el-message-box',
  ];
  for (const sel of allSelectors) {
    const elements = await page.$$(sel).catch(() => []);
    for (const el of elements) {
      const isVisible = await el.isVisible().catch(() => false);
      if (isVisible) return true;
    }
  }
  return false;
}

/**
 * 清除页面上的所有广告/公告弹窗
 * 策略：
 *   1. 先读弹窗文本判断性质（关闭确认 vs 操作确认）
 *   2. el-dialog + pay-dialog：优先点 footer 的关闭按钮 → 关二确点确定 → X → 遮罩
 *   3. el-message-box：优先关二确按钮 → 关二确点确定 → X
 *   4. 循环最多 5 轮，每轮间隔 300ms，处理二次确认引发的次级弹窗
 */
export async function dismissPopups(page: Page): Promise<number> {
  const startTime = Date.now();
  let totalDismissed = 0;

  for (let round = 0; round < 5; round++) {
    let foundInThisRound = 0;
    console.log(`[PopupDismiss] Round ${round + 1}/5 开始 (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);

    // ── 1. 处理 el-dialog / pay-dialog ──
    for (const sel of STUBBORN_DIALOG_SELECTORS) {
      const dialogWrappers = await page.$$(sel).catch(() => []);
      console.log(`[PopupDismiss]   ${sel}: ${dialogWrappers.length} 个匹配元素`);
      for (const wrapper of dialogWrappers) {
        const isVisible = await wrapper.isVisible().catch(() => false);
        if (!isVisible) continue;

        // 1a. 优先在 footer 找关闭按钮
        const footer = await wrapper.$('.el-dialog__footer').catch(() => null);
        if (footer) {
          const clicked = await clickSmartButton(footer);
          if (clicked) { totalDismissed++; foundInThisRound++; await page.waitForTimeout(300).catch(() => {}); continue; }
        }

        // 1b. 在 body 内找关闭按钮
        const body = await wrapper.$('.el-dialog__body').catch(() => null);
        if (body) {
          const clicked = await clickSmartButton(body);
          if (clicked) { totalDismissed++; foundInThisRound++; await page.waitForTimeout(300).catch(() => {}); continue; }
        }

        // 1c. 全局查找（dialog 内任意位置）
        const clicked = await clickSmartButton(wrapper);
        if (clicked) { totalDismissed++; foundInThisRound++; await page.waitForTimeout(300).catch(() => {}); continue; }

        // 1d. 点击 X 按钮
        const headerBtn = await wrapper.$('.el-dialog__headerbtn').catch(() => null);
        if (headerBtn) {
          await headerBtn.click().catch(() => {});
          totalDismissed++; foundInThisRound++;
          await page.waitForTimeout(300).catch(() => {});
        }
      }
    }

    // ── 2. 处理 el-message-box ──
    const msgBoxes = await page.$$('.el-message-box:not([style*="display: none"])').catch(() => []);
    for (const box of msgBoxes) {
      const isVisible = await box.isVisible().catch(() => false);
      if (!isVisible) continue;

      // 2a. 优先在按钮区域找
      const btnWrapper = await box.$('.el-message-box__btns').catch(() => null);
      const searchEl = btnWrapper ?? box;
      const clicked = await clickSmartButton(searchEl);
      if (clicked) { totalDismissed++; foundInThisRound++; await page.waitForTimeout(300).catch(() => {}); continue; }

      // 2b. 点击 X 按钮
      const closeBtn = await box.$('.el-message-box__headerbtn').catch(() => null);
      if (closeBtn) {
        await closeBtn.click().catch(() => {});
        totalDismissed++; foundInThisRound++;
        await page.waitForTimeout(300).catch(() => {});
      }
    }

    // ── 3. 自定义遮罩弹窗 ──
    const customCloseBtns = await page.$$(
      '.modal-close, .popup-close, .ad-close, [class*="close-btn"]:not([style*="display: none"])'
    ).catch(() => []);
    for (const btn of customCloseBtns) {
      const isVisible = await btn.isVisible().catch(() => false);
      if (isVisible) {
        await btn.click().catch(() => {});
        totalDismissed++; foundInThisRound++;
        await page.waitForTimeout(200).catch(() => {});
      }
    }

    // ── 4. Escape + 遮罩兜底 ──
    await closeViaEscapeOrOverlay(page);

    // 无弹窗则退出；有弹窗则继续（最多 5 轮）
    if (foundInThisRound === 0) {
      const stillThere = await stillHasPopups(page);
      console.log(`[PopupDismiss] Round ${round + 1}/5 stillHasPopups=${stillThere}`);
      if (!stillThere) {
        console.log(`[PopupDismiss] Round ${round + 1}/5 无弹窗，退出循环`);
        break;
      }
    }
  }

  if (totalDismissed > 0) {
    console.log(`[PopupDismiss] 清除了 ${totalDismissed} 个弹窗 (总耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[PopupDismiss] 无需清除弹窗 (总耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
  }

  return totalDismissed;
}

/**
 * 检查页面上是否有可见弹窗
 */
export async function hasVisiblePopups(page: Page): Promise<boolean> {
  return stillHasPopups(page);
}
