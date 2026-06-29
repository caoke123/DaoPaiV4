import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SettingsManager } from '../SettingsManager';

describe('SettingsManager — resolveWorkerCredential (设置中心优先 + credentials.ts 兜底)', () => {
  beforeEach(() => {
    // 重置单例
    (SettingsManager as any).instance = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T1: settings.json 命中罗晓红 → source=settings, employeeId=username', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-178212134615',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-罗晓红',
              employeeName: '罗晓红',
              username: 'tn_luoxh_user',
              password: 'tn_luoxh_pass_b',
              easybrBrowserId: 'browser-luoxh',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const sm = SettingsManager.getInstance();
    const result = await sm.resolveWorkerCredential({ site: 'tiannanda', staffName: '罗晓红' });

    expect(result.source).toBe('settings');
    expect(result.employeeId).toBe('tn_luoxh_user');
    expect(result.account).toBe('tn_luoxh_user');
    expect(result.password).toBeTruthy();
    expect(result.staffName).toBe('罗晓红');
    expect(result.windowName).toBe('天南大-罗晓红');
    expect(result.easybrBrowserId).toBe('browser-luoxh');
  });

  it('T2: settings.json 命中老员工孟德海 → source=settings, employeeId=username', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-178212134615',
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

    const sm = SettingsManager.getInstance();
    const result = await sm.resolveWorkerCredential({ site: 'tiannanda', staffName: '孟德海' });

    expect(result.source).toBe('settings');
    expect(result.employeeId).toBe('tn_mengdh_user');
    expect(result.account).toBe('tn_mengdh_user');
  });

  it('T3: settings.json 未命中 → fallback credentials.ts（仅存在于静态列表的员工）', async () => {
    // settings.json 中只有罗晓红，没有刘磊
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-178212134615',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-罗晓红',
              employeeName: '罗晓红',
              username: 'tn_luoxh_user',
              password: 'tn_luoxh_pass_b',
              easybrBrowserId: 'browser-luoxh',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const sm = SettingsManager.getInstance();
    // 刘磊在 credentials.ts 中存在
    const result = await sm.resolveWorkerCredential({ site: 'tiannanda', staffName: '刘磊' });

    expect(result.source).toBe('credentials');
    // credentials.ts gitignored，本地账号不写入仓库；fallback 只验证返回非空
    expect(result.employeeId).toBeTruthy();
    expect(result.account).toBeTruthy();
  });

  it('T4: settings.json 和 credentials.ts 同时存在 → 以 settings 为准', async () => {
    // 孟德海在 credentials.ts 和 settings.json 中都有
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-178212134615',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-孟德海',
              employeeName: '孟德海',
              username: 'tn_mengdh_user_new',
              password: 'tn_mengdh_pass_new',
              easybrBrowserId: 'browser-mengdehai-new',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const sm = SettingsManager.getInstance();
    const result = await sm.resolveWorkerCredential({ site: 'tiannanda', staffName: '孟德海' });

    expect(result.source).toBe('settings');
    expect(result.employeeId).toBe('tn_mengdh_user_new');
    expect(result.account).toBe('tn_mengdh_user_new');
    expect(result.password).toBe('tn_mengdh_pass_new');
  });

  it('T5: settings.json 和 credentials.ts 都找不到 → 抛出明确错误', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-178212134615',
          name: '天南大',
          windows: [],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const sm = SettingsManager.getInstance();

    await expect(
      sm.resolveWorkerCredential({ site: 'tiannanda', staffName: '不存在的人' }),
    ).rejects.toThrow('未找到员工 "不存在的人" 的设置中心窗口配置');
  });

  it('T6: 支持 site.id 格式（site-178212134615）', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-178212134615',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-罗晓红',
              employeeName: '罗晓红',
              username: 'tn_luoxh_user',
              password: 'tn_luoxh_pass_b',
              easybrBrowserId: 'browser-luoxh',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const sm = SettingsManager.getInstance();
    // 传入 site.id 格式
    const result = await sm.resolveWorkerCredential({ site: 'site-178212134615', staffName: '罗晓红' });

    expect(result.source).toBe('settings');
    expect(result.employeeId).toBe('tn_luoxh_user');
  });

  it('T7: 支持 browserId 精确匹配', async () => {
    const mockGetConfig = vi.fn().mockResolvedValue({
      initialized: true,
      sites: [
        {
          id: 'site-178212134615',
          name: '天南大',
          windows: [
            {
              windowName: '天南大-罗晓红',
              employeeName: '罗晓红',
              username: 'tn_luoxh_user',
              password: 'tn_luoxh_pass_b',
              easybrBrowserId: 'browser-luoxh',
            },
          ],
        },
      ],
      dataRetention: { retentionDays: 30, cleanupFrequency: 'weekly' as const },
    });
    vi.spyOn(SettingsManager.prototype, 'getConfig').mockImplementation(mockGetConfig);

    const sm = SettingsManager.getInstance();
    const result = await sm.resolveWorkerCredential({ staffName: '罗晓红', browserId: 'browser-luoxh' });

    expect(result.source).toBe('settings');
    expect(result.employeeId).toBe('tn_luoxh_user');
    expect(result.easybrBrowserId).toBe('browser-luoxh');
  });
});
