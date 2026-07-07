/**
 * Window Adapter 模块入口 — Phase 2-A / 2-B
 *
 * 导出：
 *   - PlaywrightWindowAdapter（适配器实现）
 *   - WindowAdapterRegistry（单例注册表）
 *   - pocAdapterRouter（Express 路由，前缀 /api/window-adapter-poc）
 *   - adapterTestRouter（Express 路由，前缀 /api/playwright-adapter-test）
 *   - AdapterTestHandler（测试任务 Handler，Phase 2-B）
 *   - 类型定义
 */
export { PlaywrightWindowAdapter } from './PlaywrightWindowAdapter';
export { WindowAdapterRegistry } from './WindowAdapterRegistry';
export { pocAdapterRouter } from './pocAdapterRoutes';
export { adapterTestRouter } from './adapterTestRoutes';
export { AdapterTestHandler } from './AdapterTestHandler';
export type { AdapterTestResult, AdapterTestExecuteOptions } from './AdapterTestHandler';
export * from './types';
