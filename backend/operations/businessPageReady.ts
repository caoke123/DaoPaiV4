import type { Page } from 'playwright';
import { drainNativeAlerts } from '../browser/NativeAlertGuard';

export type BusinessPageType = 'arrival' | 'dispatch' | 'sign' | 'integrated';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

const SPECS: Record<BusinessPageType, { path: string; selectors: string[] }> = {
  arrival: {
    path: '/scanning/arrivalscanbatch',
    selectors: ['textarea', 'button.el-button--danger'],
  },
  dispatch: {
    path: '/scanning/dispatchscan',
    selectors: ['.dispatchscan_left input', '.dispatchscan_left button.el-button--primary'],
  },
  integrated: {
    path: '/scanning/arrivalscan',
    selectors: ['#waybillNum', '.arrivalscan_left button.el-button--primary'],
  },
  sign: {
    path: '/scanning/signfor/signforinput',
    selectors: ['.search-wrap .item-actions .el-button--primary', '.search-wrap .inputs .el-date-editor'],
  },
};

const POPUP_CONTAINERS = [
  '.el-message-box__wrapper:visible',
  '.el-message-box:visible',
  '.el-dialog__wrapper:visible',
  '.el-dialog:visible',
  '.pay-dialog:visible',
];

const CANCEL_BUTTONS = [
  'button:has-text("取 消")',
  '.el-button:has-text("取 消")',
  'button:has-text("取消")',
  '.el-button:has-text("取消")',
];

function pathMatches(url: string, expectedPath: string): boolean {
  try {
    const actual = new URL(url).pathname.toLowerCase().replace(/\/+$/, '');
    return actual === expectedPath.toLowerCase().replace(/\/+$/, '');
  } catch {
    return url.toLowerCase().includes(expectedPath.toLowerCase());
  }
}

export async function afterPageEnterLightCleanup(
  page: Page,
  label: string,
  log: LogFn,
): Promise<{ cleaned: boolean; popupVisible: boolean }> {
  const alertCount = await drainNativeAlerts(page, { durationMs: 250, intervalMs: 80, scope: `${label}-light-cleanup` }).catch(() => 0);
  if (alertCount > 0) {
    log('info', `[${label}] native alert accepted count=${alertCount}`);
  }

  const popup = page.locator(POPUP_CONTAINERS.join(', ')).first();
  const hasPopup = (await popup.count().catch(() => 0)) > 0 && await popup.isVisible().catch(() => false);
  if (!hasPopup) {
    log('info', `[${label}] no_visible_popup skip cleanup`);
    return { cleaned: false, popupVisible: false };
  }

  for (const selector of CANCEL_BUTTONS) {
    const btn = popup.locator(selector).first();
    if ((await btn.count().catch(() => 0)) > 0 && await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 1500 });
      log('info', `[${label}] cleaned_cancel`);
      await page.waitForTimeout(200);
      const stillVisible = await page.locator(POPUP_CONTAINERS.join(', ')).first().isVisible().catch(() => false);
      if (stillVisible) {
        log('warning', `[${label}] popup still visible after cleaned_cancel`);
      }
      return { cleaned: true, popupVisible: stillVisible };
    }
  }

  log('warning', `[${label}] visible popup found but no internal 取 消 button, skip clicking`);
  return { cleaned: false, popupVisible: true };
}

export async function verifyBusinessPageReady(
  page: Page,
  type: BusinessPageType,
  label: string,
  log: LogFn,
): Promise<{ ready: boolean; url: string; missing: string[]; popupVisible: boolean }> {
  const spec = SPECS[type];
  const url = page.url();
  const missing: string[] = [];

  const cleanup = await afterPageEnterLightCleanup(page, label, log);

  for (const selector of spec.selectors) {
    const visible = await page.locator(selector).first().isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) missing.push(selector);
  }

  const ready = pathMatches(url, spec.path) && missing.length === 0 && !cleanup.popupVisible;
  if (ready) {
    log('info', `[${label}] verifyBusinessPageReady success`);
  } else {
    log('warning', `[${label}] verifyBusinessPageReady failed: url=${url}, expected=${spec.path}, missing=${missing.join(',') || '-'}, popupVisible=${cleanup.popupVisible}`);
  }
  return { ready, url, missing, popupVisible: cleanup.popupVisible };
}
