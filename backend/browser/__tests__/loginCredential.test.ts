import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BrowserPool } from '../BrowserPool';
import { SettingsManager } from '../../config/SettingsManager';
import { WindowLockManager } from '../WindowLockManager';

function resetBrowserPool(): BrowserPool {
  (BrowserPool as any).instance = null;
  (WindowLockManager as any).instance = null;
  const pool = BrowserPool.getInstance();
  (pool as any).windowBusy.clear();
  (pool as any).activeWindowLeases.clear();
  (pool as any).runtimeStates.clear();
  (pool as any).connections.clear();
  (pool as any).p0Verified.clear();
  (pool as any).loginRequiredWindows.clear();
  return pool;
}

describe('BrowserPool — resolveLoginCredential (settings优先 + credentials兜底)', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    pool = resetBrowserPool();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('C1: settings.json 有凭据 → 优先使用 settings，不依赖 credentials.ts', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-tn',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-罗晓红',
              employeeName: '罗晓红',
              username: 'tn_luoxh_user',
              password: 'tn_luoxh_pass_a',
              easybrBrowserId: 'browser-luoxh',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const result = await pool.resolveLoginCredential('browser-luoxh', '天南大-罗晓红');

    expect(result.cred).toBeDefined();
    expect(result.cred!.account).toBe('tn_luoxh_user');
    expect(result.cred!.password).toBe('tn_luoxh_pass_a');
    expect(result.source).toBe('settings');
    expect(result.diagnostics.settingsFound).toBe(true);
    expect(result.diagnostics.settingsHasUser).toBe(true);
    expect(result.diagnostics.settingsHasPass).toBe(true);
    expect(result.diagnostics.fallbackFound).toBe(false);
    expect(result.diagnostics.staffName).toBe('罗晓红');
    expect(result.diagnostics.site).toBe('tiannanda');
  });

  it('C2: settings.json 有该 browserId 的完整凭据 → 使用 settings（孟德海）', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-tn',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-孟德海',
              employeeName: '孟德海',
              username: 'tn_mengdh_user',
              password: 'tn_mengdh_pass',
              easybrBrowserId: 'browser-mengdehai',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const result = await pool.resolveLoginCredential('browser-mengdehai', '天南大-孟德海');

    expect(result.cred).toBeDefined();
    expect(result.source).toBe('settings');
    expect(result.cred!.account).toBe('tn_mengdh_user');
    expect(result.diagnostics.settingsFound).toBe(true);
    expect(result.diagnostics.fallbackFound).toBe(false);
  });

  it('C2b: settings.json 无该 browserId → fallback 到 credentials.ts（刘磊 旧员工）', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-tn',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-罗晓红',
              employeeName: '罗晓红',
              username: 'tn_luoxh_user',
              password: 'tn_luoxh_pass_a',
              easybrBrowserId: 'browser-luoxh',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const unknownBrowserId = 'browser-liulei-not-in-settings';
    const result = await pool.resolveLoginCredential(unknownBrowserId, '天南大-刘磊');

    expect(result.cred).toBeDefined();
    // credentials.ts 已 gitignore，测试只验证 fallback 是否返回非空 account
    expect(result.cred!.account).toBeTruthy();
    // credentials.ts 中 password 已改为占位符（交付前安全加固），不再保存真实密码
    expect(result.cred!.password).toBe('FALLBACK_PLACEHOLDER');
    expect(result.source).toBe('credentials');
    expect(result.diagnostics.settingsFound).toBe(false);
    expect(result.diagnostics.fallbackFound).toBe(true);
    expect(result.diagnostics.staffName).toBe('刘磊');
  });

  it('C3: settings.json 和 credentials.ts 都找不到 → cred 为 undefined，不抛异常', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-tn',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-孟德海',
              employeeName: '孟德海',
              username: 'tn_mengdh_user',
              password: 'tn_mengdh_pass',
              easybrBrowserId: 'browser-mengdehai',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const result = await pool.resolveLoginCredential('browser-unknown', '天南大-不存在的人');

    expect(result.cred).toBeUndefined();
    expect(result.source).toBe('none');
    expect(result.diagnostics.settingsFound).toBe(false);
    expect(result.diagnostics.fallbackFound).toBe(false);
    expect(result.diagnostics.staffName).toBe('不存在的人');
  });

  it('C4: settings.json 找到窗口但 password 为空 → fallback 到 credentials.ts', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-tn',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-肖飞',
              employeeName: '肖飞',
              username: 'tn_xiaof_user',
              password: '',
              easybrBrowserId: 'browser-xiaofei-empty',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const result = await pool.resolveLoginCredential('browser-xiaofei-empty', '天南大-肖飞');

    expect(result.cred).toBeDefined();
    expect(result.source).toBe('credentials');
    expect(result.diagnostics.settingsFound).toBe(true);
    expect(result.diagnostics.settingsHasUser).toBe(true);
    expect(result.diagnostics.settingsHasPass).toBe(false);
    expect(result.diagnostics.fallbackFound).toBe(true);
    expect(result.cred!.account).toBe('tn_xiaof_user');
  });

  it('C5: settings.json 读取异常 → 不崩溃，走 fallback', async () => {
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockRejectedValue(new Error('文件读取失败'));

    const result = await pool.resolveLoginCredential('browser-any', '天南大-肖飞');

    expect(result.cred).toBeDefined();
    expect(result.source).toBe('credentials');
    expect(result.diagnostics.settingsFound).toBe(false);
    expect(result.diagnostics.fallbackFound).toBe(true);
  });

  it('C6: settings 凭据优先级高于 credentials.ts（旧员工settings密码覆盖硬编码）', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-hey',
          name: '和苑',
          windows: [
            {
              windowName: '和苑-肖文勇',
              employeeName: '肖文勇',
              username: 'hey_xiaowy_user',
              password: 'hey_new_pass',
              easybrBrowserId: 'browser-xiaowenyong',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const result = await pool.resolveLoginCredential('browser-xiaowenyong', '和苑-肖文勇');

    expect(result.cred).toBeDefined();
    expect(result.source).toBe('settings');
    expect(result.cred!.password).toBe('hey_new_pass');
  });

  it('C7: Base64 密码由 SettingsManager.getConfig() 自动解码为明文', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-tn',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-罗晓红',
              employeeName: '罗晓红',
              username: 'tn_luoxh_user',
              password: 'tn_luoxh_pass_a',
              easybrBrowserId: 'browser-luoxh2',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const result = await pool.resolveLoginCredential('browser-luoxh2', '天南大-罗晓红');

    expect(result.cred).toBeDefined();
    expect(result.cred!.password).toBe('tn_luoxh_pass_a');
    expect(result.cred!.password).not.toBe('dG5fbHVveGhfcGFzc19h');
    expect(result.source).toBe('settings');
  });
});
