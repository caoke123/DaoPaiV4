/**
 * Window Runtime Mode — Phase 2-D / Phase 2-E 模式开关
 *
 * 控制 AssignmentEngine 在获取窗口连接时走 legacy EasyBR 路径还是 Playwright Adapter 路径。
 *
 * 设计原则：
 *   1. 默认值必须是 legacy_easybr（生产零影响）
 *   2. 未设置或非法值一律回退 legacy_easybr
 *   3. Phase 2-D：playwright 模式下仅 sign 走 Adapter
 *   4. Phase 2-E：playwright 模式下扩展到 arrival/dispatch/integrated 走 Adapter
 *   5. POC API（/api/window-adapter-poc）不受该 mode 影响
 *   6. 模式判断集中在本文件，不散落到多个 Handler
 *
 * 配置方式：
 *   env WINDOW_RUNTIME_MODE=legacy_easybr  （默认）
 *   env WINDOW_RUNTIME_MODE=playwright
 */
export type WindowRuntimeMode = 'legacy_easybr' | 'playwright';

/**
 * 读取当前 runtime mode
 *
 * - 严格匹配 'playwright'，其他任何值（包括未设置）都回退 legacy_easybr
 * - 读取一次后缓存，避免重复解析 env
 */
export function getRuntimeMode(): WindowRuntimeMode {
  const raw = process.env.WINDOW_RUNTIME_MODE;
  if (raw === 'playwright') return 'playwright';
  return 'legacy_easybr';
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
 * 默认模式仍为 legacy_easybr，playwright 不会成为默认。
 */
export function shouldUsePlaywrightAdapter(taskType: string): boolean {
  return isPlaywrightMode() && PLAYWRIGHT_ALLOWED_TASK_TYPES.has(taskType);
}
