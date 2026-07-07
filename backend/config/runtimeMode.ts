/**
 * Window Runtime Mode — Phase D-0B: EasyBR legacy removed
 *
 * Deploy-0B: EasyBR 生产路径已完全断开，默认模式为 playwright。
 * 旧值 legacy_easybr / easybr 归一为 playwright 并打印 warn。
 *
 * 配置方式：
 *   env WINDOW_RUNTIME_MODE=playwright  （默认）
 */
export type WindowRuntimeMode = 'legacy_easybr' | 'playwright';

let cachedMode: WindowRuntimeMode | null = null;

/**
 * 读取当前 runtime mode
 *
 * - 默认 playwright
 * - 旧值 legacy_easybr / easybr 归一为 playwright 并打印 warn
 */
export function getRuntimeMode(): WindowRuntimeMode {
  if (cachedMode) return cachedMode;
  const raw = process.env.WINDOW_RUNTIME_MODE?.toLowerCase();
  if (!raw || raw === 'playwright') {
    cachedMode = 'playwright';
    return 'playwright';
  }
  if (raw === 'legacy_easybr' || raw === 'easybr') {
    console.warn('[runtimeMode] WARNING: legacy_easybr/easybr mode detected, normalized to playwright. EasyBR has been removed in DaoPai V3.');
    cachedMode = 'playwright';
    return 'playwright';
  }
  console.warn(`[runtimeMode] WARNING: unknown mode "${raw}", falling back to playwright.`);
  cachedMode = 'playwright';
  return 'playwright';
}

/**
 * 是否为 playwright 模式
 */
export function isPlaywrightMode(): boolean {
  return getRuntimeMode() === 'playwright';
}

/**
 * Phase 2-E allowlist：playwright 模式下允许走 Adapter 的 taskType 集合
 *
 * 真实 taskType 来源（routes.ts → engine.execute({ taskType })）：
 *   - 'arrival'    → POST /api/operations/arrive      → ArrivalHandler
 *   - 'dispatch'   → POST /api/operations/dispatch    → DispatchHandler
 *   - 'integrated' → POST /api/operations/integrated  → IntegratedHandler
 *   - 'sign'       → POST /api/operations/sign        → SignHandler
 *
 * 注意：接口名是 /arrive 但 taskType 是 'arrival'，两者均已包含以容错。
 * 'arrive' 不会出现在真实 taskType 中，但保留以防止未来接口变化。
 */
const PLAYWRIGHT_ALLOWED_TASK_TYPES = new Set([
  'sign',
  'arrive',
  'arrival',
  'dispatch',
  'integrated',
]);

/**
 * 判断指定 taskType 是否在当前模式下走 PlaywrightWindowAdapter
 *
 * Phase 2-D 接入范围：
 *   - playwright 模式 + taskType='sign' → 走 Adapter
 *
 * Phase 2-E 接入范围（本次扩展）：
 *   - playwright 模式 + taskType∈{sign, arrival, dispatch, integrated} → 走 Adapter
 *   - 其他所有情况（含 legacy 模式 / 未在 allowlist 内的 taskType）→ 走 legacy BrowserPool
 *
 * D-0B: 默认模式改为 playwright，legacy_easybr 仅保留向后兼容类型。
 */
export function shouldUsePlaywrightAdapter(taskType: string): boolean {
  return isPlaywrightMode() && PLAYWRIGHT_ALLOWED_TASK_TYPES.has(taskType);
}
