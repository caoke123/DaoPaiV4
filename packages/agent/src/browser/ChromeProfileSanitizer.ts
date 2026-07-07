/**
 * ChromeProfileSanitizer — Chrome Profile 消毒器
 *
 * Phase 5-C-5 修复版：启动 Chrome 前清理崩溃恢复文件，
 * 修改 Preferences 压制 Chrome 原生弹窗。
 *
 * 治理的 Chrome 原生弹窗：
 *   - 要恢复页面吗？
 *   - 保存密码
 *   - 默认浏览器提示
 *   - 首次运行提示
 *   - 账号同步提示
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SanitizeResult {
  cleaned: boolean;
  actions: string[];
  warnings: string[];
}

export async function sanitizeChromeProfile(userDataDir: string): Promise<SanitizeResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  let cleaned = false;

  // 1. 确保 userDataDir 存在
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    actions.push('创建用户数据目录');
  }

  const defaultDir = path.join(userDataDir, 'Default');
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
    actions.push('创建 Default 目录');
  }

  // 2. 清理崩溃恢复文件
  const crashFiles = [
    path.join(defaultDir, 'Last Session'),
    path.join(defaultDir, 'Last Tabs'),
  ];

  for (const file of crashFiles) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        actions.push(`清理崩溃恢复文件: ${path.basename(file)}`);
        cleaned = true;
      } catch (err) {
        warnings.push(`无法删除 ${path.basename(file)}: ${(err as Error).message}`);
      }
    }
  }

  // 清理 Sessions 目录
  const sessionsDir = path.join(defaultDir, 'Sessions');
  if (fs.existsSync(sessionsDir)) {
    try {
      const files = fs.readdirSync(sessionsDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(sessionsDir, file));
        } catch {
          // 忽略单个文件删除失败
        }
      }
      actions.push(`清理 Sessions 目录 (${files.length} 个文件)`);
      cleaned = true;
    } catch (err) {
      warnings.push(`无法清理 Sessions 目录: ${(err as Error).message}`);
    }
  }

  // 3. 修改 Default/Preferences
  const prefsPath = path.join(defaultDir, 'Preferences');
  let prefs: Record<string, unknown> = {};

  if (fs.existsSync(prefsPath)) {
    try {
      const raw = fs.readFileSync(prefsPath, 'utf-8');
      prefs = JSON.parse(raw);
    } catch {
      warnings.push('Preferences 文件损坏，将重建');
      prefs = {};
    }
  }

  // 写入压制 Chrome 原生弹窗的配置
  const prefsChanged = applySuppressionPrefs(prefs);

  if (prefsChanged) {
    try {
      fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf-8');
      actions.push('更新 Preferences（压制 Chrome 原生弹窗）');
      cleaned = true;
    } catch (err) {
      warnings.push(`无法写入 Preferences: ${(err as Error).message}`);
    }
  }

  console.log(`  [ChromeProfileSanitizer] 清理完成，${actions.length} 项操作`);
  if (warnings.length > 0) {
    console.log(`  [ChromeProfileSanitizer] ${warnings.length} 个警告: ${warnings.join('; ')}`);
  }

  return { cleaned, actions, warnings };
}

function applySuppressionPrefs(prefs: Record<string, unknown>): boolean {
  let changed = false;

  // profile 相关
  if (!prefs.profile) prefs.profile = {};
  const profile = prefs.profile as Record<string, unknown>;

  if (profile.exited_cleanly !== true) {
    profile.exited_cleanly = true;
    changed = true;
  }
  if (profile.exit_type !== 'Normal') {
    profile.exit_type = 'Normal';
    changed = true;
  }

  // 密码管理器
  if (!prefs.credentials_enable_service !== false) {
    prefs.credentials_enable_service = false;
    changed = true;
  }
  if (profile.password_manager_enabled !== false) {
    profile.password_manager_enabled = false;
    changed = true;
  }

  // 自动填充
  if (!prefs.autofill) prefs.autofill = {};
  const autofill = prefs.autofill as Record<string, unknown>;

  if (autofill.profile_enabled !== false) {
    autofill.profile_enabled = false;
    changed = true;
  }
  if (autofill.credit_card_enabled !== false) {
    autofill.credit_card_enabled = false;
    changed = true;
  }

  // 浏览器相关
  if (!prefs.browser) prefs.browser = {};
  const browser = prefs.browser as Record<string, unknown>;

  if (browser.default_browser_infobar_last_declined !== -1) {
    browser.default_browser_infobar_last_declined = -1;
    changed = true;
  }
  if (browser.check_default_browser !== false) {
    browser.check_default_browser = false;
    changed = true;
  }
  if (browser.has_seen_welcome_page !== true) {
    browser.has_seen_welcome_page = true;
    changed = true;
  }

  // 同步
  if (prefs.sync_promo_show_count !== -1) {
    prefs.sync_promo_show_count = -1;
    changed = true;
  }

  return changed;
}