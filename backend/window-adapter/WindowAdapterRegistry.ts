/**
 * WindowAdapterRegistry — 适配层注册表
 *
 * 单例模式，统一管理窗口适配器实例。
 *
 * 设计目的：
 *   1. 上层业务通过 Registry 获取 adapter，不直接 new PlaywrightWindowAdapter
 *   2. 保证全局只有一个 adapter 实例（共享同一个 PlaywrightRuntime）
 *   3. 未来可扩展支持多种 adapter（如 PuppeteerAdapter），通过 name 区分
 *
 * Phase 2-A 只注册 'playwright' 一个 adapter。
 */
import { PlaywrightWindowAdapter } from './PlaywrightWindowAdapter';

export class WindowAdapterRegistry {
  private static instance: WindowAdapterRegistry;

  /** adapter 名称 → 实例 */
  private adapters = new Map<string, PlaywrightWindowAdapter>();

  /** 默认 adapter 名称 */
  private defaultName = 'playwright';

  static getInstance(): WindowAdapterRegistry {
    if (!WindowAdapterRegistry.instance) {
      WindowAdapterRegistry.instance = new WindowAdapterRegistry();
    }
    return WindowAdapterRegistry.instance;
  }

  private constructor() {
    // 注册默认 Playwright adapter
    this.adapters.set(this.defaultName, new PlaywrightWindowAdapter());
  }

  /**
   * 获取默认 adapter
   */
  getAdapter(): PlaywrightWindowAdapter {
    return this.adapters.get(this.defaultName)!;
  }

  /**
   * 按名称获取 adapter
   */
  getAdapterByName(name: string): PlaywrightWindowAdapter | undefined {
    return this.adapters.get(name);
  }

  /**
   * 获取默认 adapter 名称
   */
  getDefaultName(): string {
    return this.defaultName;
  }

  /**
   * 列出所有已注册 adapter 名称
   */
  listNames(): string[] {
    return Array.from(this.adapters.keys());
  }
}
