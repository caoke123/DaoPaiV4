/**
 * Playwright Runtime 模块入口
 *
 * bnsy-operator-next Phase 1 POC
 *
 * 导出：
 *   - PlaywrightRuntime（核心运行时，单例）
 *   - PlaywrightProfileManager（userDataDir 管理）
 *   - PlaywrightLoginVerifier（登录状态判断）
 *   - PlaywrightWindowState（窗口状态存储）
 *   - pocRouter（Express 路由，前缀 /api/playwright-poc）
 *   - 类型定义
 */
export { PlaywrightRuntime } from './PlaywrightRuntime';
export { PlaywrightProfileManager } from './PlaywrightProfileManager';
export { PlaywrightLoginVerifier } from './PlaywrightLoginVerifier';
export { PlaywrightWindowStateStore } from './PlaywrightWindowState';
export { pocRouter } from './pocRoutes';
export * from './types';
