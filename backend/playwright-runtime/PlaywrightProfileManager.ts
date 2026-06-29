/**
 * Playwright Profile Manager — userDataDir 管理（三层隔离）
 *
 * Phase 1-A 补丁：从 runtime/profiles/<windowId>/ 改为三层隔离路径
 *
 * 目录结构：
 *   runtime/profiles/{tenantId}/{siteId}/{windowId}/
 *
 * 示例：
 *   runtime/profiles/tenant-default/site-default/window-test-001/
 *   runtime/profiles/tenant-acme/site-tiannan/window-liulei/
 *
 * 路径安全：
 *   - 自动清理非法字符，避免路径穿越
 *   - 不允许 userDataDir 落到 bnsy-operator/ 目录
 *   - 不允许 userDataDir 使用系统临时目录
 *
 * 后续 Phase 3 租户隔离落地后，tenantId 由认证上下文提供。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const PROFILE_ROOT = path.join(process.cwd(), 'runtime', 'profiles');

export class PlaywrightProfileManager {
  private static instance: PlaywrightProfileManager;

  static getInstance(): PlaywrightProfileManager {
    if (!PlaywrightProfileManager.instance) {
      PlaywrightProfileManager.instance = new PlaywrightProfileManager();
    }
    return PlaywrightProfileManager.instance;
  }

  private constructor() {}

  /** 获取所有 profile 的根目录 */
  getRoot(): string {
    return PROFILE_ROOT;
  }

  /**
   * 解析指定窗口的 userDataDir 绝对路径（三层隔离）
   *
   * @param tenantId 租户 ID
   * @param siteId   站点 ID
   * @param windowId 窗口 ID
   * @returns userDataDir 绝对路径
   */
  resolveUserDataDir(tenantId: string, siteId: string, windowId: string): string {
    const t = this.sanitizeSegment(tenantId, 'tenantId');
    const s = this.sanitizeSegment(siteId, 'siteId');
    const w = this.sanitizeSegment(windowId, 'windowId');
    const dir = path.join(PROFILE_ROOT, t, s, w);
    this.validatePath(dir);
    return dir;
  }

  /** 确保指定窗口的 userDataDir 存在，返回绝对路径 */
  async ensureDir(tenantId: string, siteId: string, windowId: string): Promise<string> {
    const dir = this.resolveUserDataDir(tenantId, siteId, windowId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * 列出所有已存在的 profile（基于 tenantId/siteId/windowId 三层结构）
   * 返回三元组数组
   */
  async listProfiles(): Promise<Array<{ tenantId: string; siteId: string; windowId: string; path: string }>> {
    const results: Array<{ tenantId: string; siteId: string; windowId: string; path: string }> = [];
    try {
      const tenants = await fs.readdir(PROFILE_ROOT, { withFileTypes: true });
      for (const tenant of tenants) {
        if (!tenant.isDirectory()) continue;
        const tenantPath = path.join(PROFILE_ROOT, tenant.name);
        const sites = await fs.readdir(tenantPath, { withFileTypes: true }).catch(() => []);
        for (const site of sites) {
          if (!site.isDirectory()) continue;
          const sitePath = path.join(tenantPath, site.name);
          const windows = await fs.readdir(sitePath, { withFileTypes: true }).catch(() => []);
          for (const win of windows) {
            if (!win.isDirectory()) continue;
            results.push({
              tenantId: tenant.name,
              siteId: site.name,
              windowId: win.name,
              path: path.join(sitePath, win.name),
            });
          }
        }
      }
    } catch {
      // 根目录不存在
    }
    return results;
  }

  /** 删除指定窗口的 profile（慎用，会清除登录态） */
  async deleteProfile(tenantId: string, siteId: string, windowId: string): Promise<void> {
    const dir = this.resolveUserDataDir(tenantId, siteId, windowId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  /** 检查 profile 是否存在 */
  async exists(tenantId: string, siteId: string, windowId: string): Promise<boolean> {
    const dir = this.resolveUserDataDir(tenantId, siteId, windowId);
    try {
      const stat = await fs.stat(dir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * 清理路径段中的非法字符，防止路径穿越
   * 仅保留字母、数字、下划线、短横线、点、中文
   */
  private sanitizeSegment(segment: string, label: string): string {
    const cleaned = segment.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    if (!cleaned || cleaned.startsWith('.')) {
      throw new Error(`非法 ${label}: ${segment}（清理后为空或以点开头）`);
    }
    // 防止路径穿越：不允许 .. 残留
    if (cleaned.includes('..')) {
      throw new Error(`非法 ${label}: ${segment}（包含路径穿越字符）`);
    }
    return cleaned;
  }

  /**
   * 路径安全验证
   * - 不允许落到 bnsy-operator/ 目录
   * - 不允许使用系统临时目录
   */
  private validatePath(dir: string): void {
    const resolved = path.resolve(dir);
    const tmpDir = os.tmpdir();

    // 不允许使用系统临时目录
    if (resolved === tmpDir || resolved.startsWith(tmpDir + path.sep)) {
      throw new Error(`userDataDir 禁止使用系统临时目录: ${resolved}`);
    }

    // 不允许落到 bnsy-operator/ 目录（生产项目）
    const bnsyOperatorPath = path.resolve(process.cwd(), '..', 'bnsy-operator');
    if (resolved === bnsyOperatorPath || resolved.startsWith(bnsyOperatorPath + path.sep)) {
      throw new Error(`userDataDir 禁止落到 bnsy-operator/ 生产项目目录: ${resolved}`);
    }

    // 必须在当前项目的 runtime/profiles/ 下
    const expectedRoot = path.resolve(PROFILE_ROOT);
    if (resolved !== expectedRoot && !resolved.startsWith(expectedRoot + path.sep)) {
      throw new Error(`userDataDir 必须在 ${expectedRoot} 下，实际: ${resolved}`);
    }
  }
}
