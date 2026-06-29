/**
 * import-v1-settings-to-v2 — V1 网点/员工/窗口信息导入 V2 设置中心
 *
 * 从旧项目 bnsy-operator/data/settings.json 只读提取网点/员工/窗口/登录账号，
 * 合并写入新项目 bnsyV2/data/settings.json。
 *
 * 本任务是一次性数据导入，不是运行时依赖 V1。
 *
 * 严禁：
 *   - 修改 bnsy-operator/
 *   - 修改 V1 settings.json
 *   - 修改业务 Handler / routes.ts / AssignmentEngine / PlaywrightRuntime / BrowserPool / EasyBRClient
 *   - 打印明文密码
 *   - 打印 Base64 密码原文
 *
 * 安全：
 *   - 账号脱敏（022****0008）
 *   - 密码只输出 passwordExists: true/false
 *   - settings.json 已在 .gitignore 中（data/*.json）
 *
 * 运行方式：
 *   npx tsx scripts/import-v1-settings-to-v2.ts                # 默认 dry-run
 *   npx tsx scripts/import-v1-settings-to-v2.ts --dry-run      # 只预览
 *   npx tsx scripts/import-v1-settings-to-v2.ts --apply        # 真正写入
 *   npx tsx scripts/import-v1-settings-to-v2.ts --apply --replace  # 替换模式（谨慎）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 路径常量 ──

const V2_ROOT = path.resolve(__dirname, '..');
const V1_ROOT = path.resolve(V2_ROOT, '..', 'bnsy-operator');
const V1_SETTINGS = path.join(V1_ROOT, 'data', 'settings.json');
const V2_SETTINGS = path.join(V2_ROOT, 'data', 'settings.json');
const V2_DATA_DIR = path.join(V2_ROOT, 'data');
const V2_DOCS_DIR = path.join(V2_ROOT, 'docs');
const REPORT_PATH = path.join(V2_DOCS_DIR, 'v1-to-v2-settings-import-report.md');

// ── CLI 参数 ──

const argv = process.argv.slice(2);
const isDryRun = !argv.includes('--apply');
const isApply = argv.includes('--apply');
const isReplace = argv.includes('--replace');

if (isReplace && !isApply) {
  console.error('❌ --replace 必须配合 --apply 使用（防止误操作）');
  process.exit(1);
}

// ── 脱敏函数 ──

function maskUsername(username: string): string {
  if (!username) return '(empty)';
  if (username.length <= 7) return '****';
  return `${username.slice(0, 3)}****${username.slice(-4)}`;
}

// ── 类型定义（宽松，兼容多种 schema） ──

interface V1Window {
  windowName?: string;
  employeeName?: string;
  staffName?: string;
  name?: string;
  username?: string;
  account?: string;
  loginAccount?: string;
  loginUsername?: string;
  password?: string;
  easybrBrowserId?: string;
  browserId?: string;
  credential?: { username?: string; account?: string; password?: string };
  credentials?: { username?: string; account?: string; password?: string };
  [k: string]: unknown;
}

interface V1Site {
  id?: string;
  name?: string;
  siteCode?: string;
  windows?: V1Window[];
  workers?: V1Window[];
  [k: string]: unknown;
}

interface V1Settings {
  initialized?: boolean;
  sites?: V1Site[];
  windows?: V1Window[];
  workers?: V1Window[];
  [k: string]: unknown;
}

interface V2Window {
  windowName: string;
  employeeName: string;
  username: string;
  password: string;        // Base64 编码，不输出到日志
  easybrBrowserId?: string;
}

interface V2Site {
  id: string;
  name: string;
  windows: V2Window[];
}

interface V2Settings {
  initialized: boolean;
  pinHash: string;
  pinSalt: string;
  sites: V2Site[];
  runtime: { dryRunMode: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

// ── 字段提取（兼容多种字段名） ──

function extractEmployeeName(win: V1Window): string {
  return String(win.employeeName || win.staffName || win.name || '').trim();
}

function extractUsername(win: V1Window): string {
  return String(
    win.username || win.account || win.loginAccount || win.loginUsername ||
    win.credential?.username || win.credential?.account ||
    win.credentials?.username || win.credentials?.account || '',
  ).trim();
}

function extractPassword(win: V1Window): string {
  return String(win.password || win.credential?.password || win.credentials?.password || '').trim();
}

function extractWindowName(win: V1Window, fallback: string): string {
  return String(win.windowName || '').trim() || fallback;
}

function extractEasybrBrowserId(win: V1Window): string | undefined {
  const id = win.easybrBrowserId || win.browserId;
  return id ? String(id).trim() : undefined;
}

// ── 1. 读取 V1 settings ──

function readV1Settings(): V1Settings {
  if (!fs.existsSync(V1_SETTINGS)) {
    throw new Error(`V1 settings.json 不存在: ${V1_SETTINGS}`);
  }
  const raw = fs.readFileSync(V1_SETTINGS, 'utf-8');
  return JSON.parse(raw) as V1Settings;
}

// ── 2. 读取 V2 settings ──

function readV2Settings(): V2Settings {
  if (!fs.existsSync(V2_SETTINGS)) {
    throw new Error(`V2 settings.json 不存在: ${V2_SETTINGS}`);
  }
  const raw = fs.readFileSync(V2_SETTINGS, 'utf-8');
  return JSON.parse(raw) as V2Settings;
}

// ── 3. 从 V1 提取所有 sites（统一为 V2 格式） ──

interface ExtractedSite {
  id: string;
  name: string;
  windows: V2Window[];
}

function extractV1Sites(v1: V1Settings): ExtractedSite[] {
  const result: ExtractedSite[] = [];

  // 范围 1: v1.sites[].windows[] / workers[]
  if (Array.isArray(v1.sites)) {
    for (const site of v1.sites) {
      const siteId = String(site.id || '').trim();
      if (!siteId) continue;
      const siteName = String(site.name || site.siteCode || '').trim() || siteId;
      const rawWindows = (site.windows || []).concat(site.workers || []);
      const windows = rawWindows.map(win => normalizeWindow(win)).filter(w => w.employeeName && w.username);
      result.push({ id: siteId, name: siteName, windows });
    }
  }

  // 范围 2: 顶层 windows[] / workers[]（归入 fallback site）
  const topWindows = (v1.windows || []).concat(v1.workers || []);
  if (topWindows.length > 0) {
    const normalized = topWindows.map(win => normalizeWindow(win)).filter(w => w.employeeName && w.username);
    if (normalized.length > 0) {
      // 检查是否已有 fallback site
      const fallbackId = 'site-legacy-top-level';
      const existing = result.find(s => s.id === fallbackId);
      if (existing) {
        existing.windows.push(...normalized);
      } else {
        result.push({ id: fallbackId, name: '旧项目顶层窗口', windows: normalized });
      }
    }
  }

  return result;
}

function normalizeWindow(win: V1Window): V2Window {
  const employeeName = extractEmployeeName(win);
  const username = extractUsername(win);
  const password = extractPassword(win);
  const windowName = extractWindowName(win, employeeName);
  const easybrBrowserId = extractEasybrBrowserId(win);
  return {
    windowName,
    employeeName,
    username,
    password,
    ...(easybrBrowserId ? { easybrBrowserId } : {}),
  };
}

// ── 4. 窗口匹配（优先级：employeeName > windowName > username） ──

function findMatchingWindowIndex(windows: V2Window[], target: V2Window): number {
  // 1. employeeName 相同
  if (target.employeeName) {
    const idx = windows.findIndex(w => w.employeeName === target.employeeName);
    if (idx >= 0) return idx;
  }
  // 2. windowName 相同
  if (target.windowName) {
    const idx = windows.findIndex(w => w.windowName === target.windowName);
    if (idx >= 0) return idx;
  }
  // 3. username 相同
  if (target.username) {
    const idx = windows.findIndex(w => w.username === target.username);
    if (idx >= 0) return idx;
  }
  return -1;
}

// ── 5. 合并逻辑 ──

interface MergeStats {
  sitesAdded: number;
  sitesUpdated: number;
  windowsAdded: number;
  windowsUpdated: number;
  windowsUnchanged: number;
  details: Array<{
    siteId: string;
    siteName: string;
    action: 'added' | 'updated' | 'unchanged';
    windows: Array<{
      employeeName: string;
      maskedUsername: string;
      windowName: string;
      action: 'added' | 'updated' | 'unchanged';
      passwordExists: boolean;
      easybrBrowserId?: string;
      windowId: string;
    }>;
  }>;
}

function mergeSettings(v2: V2Settings, v1Sites: ExtractedSite[], replace: boolean): { merged: V2Settings; stats: MergeStats } {
  // 深拷贝 V2（不修改原对象）
  const merged: V2Settings = JSON.parse(JSON.stringify(v2));
  const stats: MergeStats = {
    sitesAdded: 0,
    sitesUpdated: 0,
    windowsAdded: 0,
    windowsUpdated: 0,
    windowsUnchanged: 0,
    details: [],
  };

  for (const v1Site of v1Sites) {
    const v2SiteIdx = merged.sites.findIndex(s => s.id === v1Site.id);

    if (v2SiteIdx < 0) {
      // 新增 site
      merged.sites.push({
        id: v1Site.id,
        name: v1Site.name,
        windows: v1Site.windows.map(w => ({ ...w })),
      });
      stats.sitesAdded++;
      stats.windowsAdded += v1Site.windows.length;
      stats.details.push({
        siteId: v1Site.id,
        siteName: v1Site.name,
        action: 'added',
        windows: v1Site.windows.map(w => ({
          employeeName: w.employeeName,
          maskedUsername: maskUsername(w.username),
          windowName: w.windowName,
          action: 'added',
          passwordExists: !!w.password,
          ...(w.easybrBrowserId ? { easybrBrowserId: w.easybrBrowserId } : {}),
          windowId: `staff-${w.employeeName}`,
        })),
      });
      continue;
    }

    // 已存在 site → 合并 windows
    const v2Site = merged.sites[v2SiteIdx];
    v2Site.name = v1Site.name || v2Site.name;

    if (replace) {
      // --replace: 用 V1 windows 替换 V2 windows
      const oldCount = v2Site.windows.length;
      v2Site.windows = v1Site.windows.map(w => ({ ...w }));
      stats.sitesUpdated++;
      stats.windowsAdded += v1Site.windows.length;
      stats.details.push({
        siteId: v1Site.id,
        siteName: v1Site.name,
        action: 'updated',
        windows: v1Site.windows.map(w => ({
          employeeName: w.employeeName,
          maskedUsername: maskUsername(w.username),
          windowName: w.windowName,
          action: 'added',
          passwordExists: !!w.password,
          ...(w.easybrBrowserId ? { easybrBrowserId: w.easybrBrowserId } : {}),
          windowId: `staff-${w.employeeName}`,
        })),
      });
      continue;
    }

    // merge 模式
    const siteDetail: MergeStats['details'][0] = {
      siteId: v1Site.id,
      siteName: v1Site.name,
      action: 'updated',
      windows: [],
    };
    let siteChanged = false;

    for (const v1Win of v1Site.windows) {
      const matchIdx = findMatchingWindowIndex(v2Site.windows, v1Win);
      if (matchIdx < 0) {
        // 新增窗口
        v2Site.windows.push({ ...v1Win });
        stats.windowsAdded++;
        siteChanged = true;
        siteDetail.windows.push({
          employeeName: v1Win.employeeName,
          maskedUsername: maskUsername(v1Win.username),
          windowName: v1Win.windowName,
          action: 'added',
          passwordExists: !!v1Win.password,
          ...(v1Win.easybrBrowserId ? { easybrBrowserId: v1Win.easybrBrowserId } : {}),
          windowId: `staff-${v1Win.employeeName}`,
        });
      } else {
        // 更新窗口
        const old = v2Site.windows[matchIdx];
        const changed =
          old.username !== v1Win.username ||
          old.password !== v1Win.password ||
          old.windowName !== v1Win.windowName ||
          old.easybrBrowserId !== v1Win.easybrBrowserId;
        v2Site.windows[matchIdx] = {
          windowName: v1Win.windowName || old.windowName,
          employeeName: v1Win.employeeName || old.employeeName,
          username: v1Win.username || old.username,
          password: v1Win.password || old.password,
          ...(v1Win.easybrBrowserId || old.easybrBrowserId
            ? { easybrBrowserId: v1Win.easybrBrowserId || old.easybrBrowserId }
            : {}),
        };
        if (changed) {
          stats.windowsUpdated++;
          siteChanged = true;
        } else {
          stats.windowsUnchanged++;
        }
        siteDetail.windows.push({
          employeeName: v1Win.employeeName,
          maskedUsername: maskUsername(v1Win.username),
          windowName: v1Win.windowName,
          action: changed ? 'updated' : 'unchanged',
          passwordExists: !!v1Win.password,
          ...(v1Win.easybrBrowserId ? { easybrBrowserId: v1Win.easybrBrowserId } : {}),
          windowId: `staff-${v1Win.employeeName}`,
        });
      }
    }

    if (siteChanged) stats.sitesUpdated++;
    stats.details.push(siteDetail);
  }

  return { merged, stats };
}

// ── 6. 原子写入 ──

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, json + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function backupV2Settings(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(V2_DATA_DIR, `settings.backup.${ts}.json`);
  fs.copyFileSync(V2_SETTINGS, backupPath);
  return backupPath;
}

// ── 7. 生成报告 ──

function generateReport(opts: {
  stats: MergeStats;
  v2Settings: V2Settings;
  backupPath?: string;
  applied: boolean;
}): string {
  const { stats, v2Settings, backupPath, applied } = opts;
  const lines: string[] = [];

  lines.push('# V1 → V2 设置导入报告');
  lines.push('');
  lines.push(`> 一次性数据导入：从 V1 旧项目 settings.json 合并到 V2 设置中心`);
  lines.push(`> 日期：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  lines.push(`> 模式：${applied ? '--apply（已写入）' : '--dry-run（仅预览，未写入）'}`);
  lines.push('');

  lines.push('---');
  lines.push('');

  // 1. 是否修改 V1
  lines.push('## 1. 是否修改 V1');
  lines.push('');
  lines.push('**否。** 只读 V1 settings.json，未做任何写入。');
  lines.push('');

  // 2. V1 settings 路径
  lines.push('## 2. V1 settings 路径');
  lines.push('');
  lines.push('```text');
  lines.push(V1_SETTINGS);
  lines.push('```');
  lines.push('');

  // 3. V2 settings 路径
  lines.push('## 3. V2 settings 路径');
  lines.push('');
  lines.push('```text');
  lines.push(V2_SETTINGS);
  lines.push('```');
  lines.push('');

  // 4. 是否创建备份
  lines.push('## 4. 是否创建备份');
  lines.push('');
  if (backupPath) {
    lines.push(`**是。** 备份路径：`);
    lines.push('');
    lines.push('```text');
    lines.push(backupPath);
    lines.push('```');
  } else {
    lines.push('**否。** 本次为 --dry-run，未写入未备份。');
  }
  lines.push('');

  // 5. 导入网点数量
  lines.push('## 5. 导入网点数量');
  lines.push('');
  lines.push(`- 新增网点：${stats.sitesAdded}`);
  lines.push(`- 更新网点：${stats.sitesUpdated}`);
  lines.push(`- V2 当前网点总数：${v2Settings.sites.length}`);
  lines.push('');

  // 6. 导入员工/窗口数量
  lines.push('## 6. 导入员工/窗口数量');
  lines.push('');
  const totalWindows = v2Settings.sites.reduce((sum, s) => sum + s.windows.length, 0);
  lines.push(`- 新增员工/窗口：${stats.windowsAdded}`);
  lines.push(`- 更新员工/窗口：${stats.windowsUpdated}`);
  lines.push(`- 未变化员工/窗口：${stats.windowsUnchanged}`);
  lines.push(`- V2 当前员工/窗口总数：${totalWindows}`);
  lines.push('');

  // 7. 每个网点员工列表
  lines.push('## 7. 每个网点员工列表（账号脱敏）');
  lines.push('');
  for (const detail of stats.details) {
    lines.push(`### ${detail.siteName}（${detail.siteId}）— ${detail.action}`);
    lines.push('');
    lines.push('| 员工 | 脱敏账号 | 窗口名 | 操作 | 密码 | easybrBrowserId | 推荐 windowId |');
    lines.push('|------|---------|--------|------|------|----------------|--------------|');
    for (const w of detail.windows) {
      lines.push(`| ${w.employeeName} | ${w.maskedUsername} | ${w.windowName} | ${w.action} | ${w.passwordExists ? '存在' : '缺失'} | ${w.easybrBrowserId || '-'} | ${w.windowId} |`);
    }
    lines.push('');
  }

  // 8. 密码是否未泄露
  lines.push('## 8. 密码是否未泄露');
  lines.push('');
  lines.push('**是。** 本脚本和报告中：');
  lines.push('- 禁止打印明文密码');
  lines.push('- 禁止打印 Base64 密码原文');
  lines.push('- 只输出 `passwordExists: true/false`');
  lines.push('- 密码字段（Base64）直接复制到 V2 settings.json，不经过日志');
  lines.push('');

  // 9. easybrBrowserId 是否保留
  lines.push('## 9. easybrBrowserId 是否保留');
  lines.push('');
  const withBrowserId = stats.details.flatMap(d => d.windows).filter(w => w.easybrBrowserId);
  lines.push(`- 保留 easybrBrowserId 的员工数：${withBrowserId.length}`);
  for (const w of withBrowserId) {
    lines.push(`  - ${w.employeeName}: ${w.easybrBrowserId}`);
  }
  lines.push('');

  // 10. V2 推荐 windowId
  lines.push('## 10. V2 推荐 windowId');
  lines.push('');
  lines.push('Playwright 模式下推荐 windowId 命名规则：`staff-${employeeName}`');
  lines.push('');
  lines.push('| 员工 | 推荐 windowId |');
  lines.push('|------|--------------|');
  for (const detail of stats.details) {
    for (const w of detail.windows) {
      lines.push(`| ${w.employeeName} | ${w.windowId} |`);
    }
  }
  lines.push('');

  // 11. 是否保留 V2 initialized / pinHash / pinSalt / runtime
  lines.push('## 11. 是否保留 V2 initialized / pinHash / pinSalt / runtime');
  lines.push('');
  lines.push('**是。** 合并时只更新 `sites`，以下字段全部保留 V2 原值：');
  lines.push('');
  lines.push(`- initialized: ${v2Settings.initialized}`);
  lines.push(`- pinHash: ${v2Settings.pinHash ? '(已设置，已保留)' : '(空)'}`);
  lines.push(`- pinSalt: ${v2Settings.pinSalt ? '(已设置，已保留)' : '(空)'}`);
  lines.push(`- runtime: ${JSON.stringify(v2Settings.runtime)}`);
  lines.push('');

  // 12. 是否建议打开 V2 设置中心检查
  lines.push('## 12. 是否建议打开 V2 设置中心检查');
  lines.push('');
  lines.push('**是。** 建议导入后：');
  lines.push('1. 打开 V2 前端设置中心，确认网点/员工列表正确');
  lines.push('2. 调用 `GET /api/sites/:siteId/playwright-windows` 确认导入员工出现在窗口列表');
  lines.push('3. 可选择测试一个员工 `POST /api/sites/:siteId/playwright-windows/ensure`（需用户确认，会打开真实 Chrome）');
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## 通过标准对照');
  lines.push('');
  lines.push('| # | 通过标准 | 结果 |');
  lines.push('|---|---------|------|');
  lines.push('| 1 | V1 未修改 | ✅ 只读 |');
  lines.push(`| 2 | V2 settings.json 已备份 | ${backupPath ? '✅' : '☐ dry-run 未备份'} |`);
  lines.push(`| 3 | V1 网点导入到 V2 | ${stats.sitesAdded > 0 || stats.sitesUpdated > 0 ? '✅' : '☐'} |`);
  lines.push(`| 4 | V1 员工/窗口导入到 V2 | ${stats.windowsAdded > 0 || stats.windowsUpdated > 0 ? '✅' : '☐'} |`);
  lines.push('| 5 | V2 原有全局字段保留 | ✅ initialized/pinHash/pinSalt/runtime 全保留 |');
  lines.push('| 6 | 账号脱敏输出 | ✅ 022****0008 格式 |');
  lines.push('| 7 | 密码未打印 | ✅ 只输出 passwordExists |');
  lines.push(`| 8 | V2 设置中心刷新后能看到导入员工 | ${applied ? '☐ 待人工确认' : '☐ dry-run 未写入'} |`);
  lines.push(`| 9 | GET /api/sites/:siteId/playwright-windows 能看到导入员工 | ${applied ? '☐ 待人工确认' : '☐ dry-run 未写入'} |`);
  lines.push('| 10 | 没有修改业务代码 | ✅ 仅修改 data/settings.json |');
  lines.push('');

  return lines.join('\n');
}

// ── 主流程 ──

function main(): void {
  console.log('═══════════════════════════════════════════');
  console.log('  V1 → V2 设置导入');
  console.log('═══════════════════════════════════════════');
  console.log(`  V1 settings: ${V1_SETTINGS}`);
  console.log(`  V2 settings: ${V2_SETTINGS}`);
  console.log(`  模式: ${isApply ? '--apply' : '--dry-run（默认）'}${isReplace ? ' + --replace' : ''}`);
  console.log('');

  // 1. 读取 V1
  console.log('── 1. 读取 V1 settings ──');
  const v1 = readV1Settings();
  const v1Sites = extractV1Sites(v1);
  const v1TotalWindows = v1Sites.reduce((s, site) => s + site.windows.length, 0);
  console.log(`  V1 网点数: ${v1Sites.length}`);
  console.log(`  V1 员工/窗口数: ${v1TotalWindows}`);
  for (const site of v1Sites) {
    console.log(`    - ${site.name}（${site.id}）: ${site.windows.length} 个员工`);
    for (const w of site.windows) {
      console.log(`        · ${w.employeeName} (${maskUsername(w.username)}) passwordExists=${!!w.password}${w.easybrBrowserId ? ` browserId=${w.easybrBrowserId}` : ''}`);
    }
  }
  console.log('');

  // 2. 读取 V2
  console.log('── 2. 读取 V2 settings ──');
  const v2 = readV2Settings();
  const v2TotalWindows = v2.sites.reduce((s, site) => s + site.windows.length, 0);
  console.log(`  V2 网点数: ${v2.sites.length}`);
  console.log(`  V2 员工/窗口数: ${v2TotalWindows}`);
  console.log(`  V2 initialized: ${v2.initialized}`);
  console.log(`  V2 pinHash: ${v2.pinHash ? '(已设置)' : '(空)'}`);
  console.log(`  V2 runtime: ${JSON.stringify(v2.runtime)}`);
  console.log('');

  // 3. 合并
  console.log('── 3. 合并 ──');
  const { merged, stats } = mergeSettings(v2, v1Sites, isReplace);
  const mergedTotalWindows = merged.sites.reduce((s, site) => s + site.windows.length, 0);
  console.log(`  新增网点: ${stats.sitesAdded}`);
  console.log(`  更新网点: ${stats.sitesUpdated}`);
  console.log(`  新增员工: ${stats.windowsAdded}`);
  console.log(`  更新员工: ${stats.windowsUpdated}`);
  console.log(`  未变化员工: ${stats.windowsUnchanged}`);
  console.log(`  合并后 V2 网点数: ${merged.sites.length}`);
  console.log(`  合并后 V2 员工/窗口数: ${mergedTotalWindows}`);
  console.log('');

  // 4. dry-run 或 apply
  if (!isApply) {
    console.log('── 4. dry-run 预览（未写入） ──');
    console.log('  如需写入，请加 --apply 参数');
    console.log('');
  } else {
    console.log('── 4. 备份 + 写入 ──');
    const backupPath = backupV2Settings();
    console.log(`  备份: ${backupPath}`);
    atomicWriteJson(V2_SETTINGS, merged);
    console.log(`  写入: ${V2_SETTINGS}（原子写入：tmp → rename）`);
    console.log('');
  }

  // 5. 验证（读取写入后的 V2）
  console.log('── 5. 导入后验证 ──');
  const finalV2 = isApply ? readV2Settings() : merged;
  const finalTotalWindows = finalV2.sites.reduce((s, site) => s + site.windows.length, 0);
  console.log(`  V2 网点数: ${finalV2.sites.length}`);
  console.log(`  V2 员工/窗口数: ${finalTotalWindows}`);
  for (const site of finalV2.sites) {
    console.log(`    - ${site.name}（${site.id}）: ${site.windows.length} 个员工`);
    for (const w of site.windows) {
      console.log(`        · ${w.employeeName} (${maskUsername(w.username)}) windowId=staff-${w.employeeName}${w.easybrBrowserId ? ` browserId=${w.easybrBrowserId}` : ''}`);
    }
  }
  console.log('');

  // 6. 生成报告
  console.log('── 6. 生成报告 ──');
  const backupPath = isApply ? (() => {
    // 重新计算备份路径（与实际一致）
    const files = fs.readdirSync(V2_DATA_DIR).filter(f => f.startsWith('settings.backup.'));
    return files.length > 0 ? path.join(V2_DATA_DIR, files.sort().slice(-1)[0]) : undefined;
  })() : undefined;
  const report = generateReport({
    stats,
    v2Settings: finalV2,
    backupPath,
    applied: isApply,
  });
  if (!fs.existsSync(V2_DOCS_DIR)) {
    fs.mkdirSync(V2_DOCS_DIR, { recursive: true });
  }
  fs.writeFileSync(REPORT_PATH, report, 'utf-8');
  console.log(`  报告: ${REPORT_PATH}`);
  console.log('');

  console.log('═══════════════════════════════════════════');
  console.log(`  ${isApply ? '✅ 导入完成' : '✅ 预览完成（未写入）'}`);
  console.log('═══════════════════════════════════════════');
}

main();
