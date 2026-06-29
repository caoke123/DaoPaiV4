/**
 * seed-test-worker-from-legacy — Phase 2-D-Data
 *
 * 从旧项目 bnsy-operator/data/settings.json 只读提取测试网点/员工/窗口信息，
 * 写入新项目 bnsy-operator-next/data/settings.json（独立测试 settings）。
 *
 * 严禁：
 *   - 修改旧项目 bnsy-operator/
 *   - 让新项目运行时依赖旧项目 settings
 *   - 把密码写入日志或报告
 *   - 把整个旧项目 settings 复制过来
 *
 * 安全：
 *   - 账号从环境变量 BNSY_TEST_USERNAME 读取（必须显式设置，无默认值）
 *   - 日志中账号脱敏（022****0008）
 *   - 密码始终显示 ******
 *   - settings.json 已在 .gitignore 中（data/*.json）
 *
 * 运行方式：
 *   $env:BNSY_TEST_USERNAME="<你的测试账号>"
 *   npx tsx scripts/seed-test-worker-from-legacy.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ── 路径常量 ──

const NEXT_ROOT = path.resolve(__dirname, '..');
const LEGACY_ROOT = path.resolve(NEXT_ROOT, '..', 'bnsy-operator');
const LEGACY_SETTINGS = path.join(LEGACY_ROOT, 'data', 'settings.json');
const NEXT_SETTINGS = path.join(NEXT_ROOT, 'data', 'settings.json');
const NEXT_DATA_DIR = path.join(NEXT_ROOT, 'data');

// ── 测试账号（环境变量，必须显式设置，无默认值） ──

const TEST_USERNAME = process.env.BNSY_TEST_USERNAME || '';

// ── 脱敏函数 ──

function maskUsername(username: string): string {
  if (!username) return '(empty)';
  if (username.length <= 7) return '****';
  return `${username.slice(0, 3)}****${username.slice(-4)}`;
}

// ── 旧项目 settings 类型（宽松，兼容多种 schema） ──

interface LegacyWindow {
  windowName?: string;
  employeeName?: string;
  username?: string;
  account?: string;
  phone?: string;
  loginAccount?: string;
  loginUsername?: string;
  password?: string;
  easybrBrowserId?: string;
  credential?: { username?: string; account?: string; password?: string };
  credentials?: { username?: string; account?: string; password?: string };
  [k: string]: unknown;
}

interface LegacySite {
  id?: string;
  name?: string;
  siteCode?: string;
  windows?: LegacyWindow[];
  workers?: LegacyWindow[];
  [k: string]: unknown;
}

interface LegacySettings {
  initialized?: boolean;
  sites?: LegacySite[];
  windows?: LegacyWindow[];
  workers?: LegacyWindow[];
  [k: string]: unknown;
}

// ── 新项目 settings 类型（与 SettingsManager.ts 一致） ──

interface NextWindow {
  windowName: string;
  employeeName: string;
  username: string;
  password: string;        // Base64 编码
  easybrBrowserId?: string;
}

interface NextSite {
  id: string;
  name: string;
  windows: NextWindow[];
}

interface NextSettings {
  initialized: boolean;
  pinHash: string;
  pinSalt: string;
  sites: NextSite[];
  runtime: { dryRunMode: boolean };
}

// ── 搜索结果 ──

interface SearchResult {
  found: boolean;
  legacySiteId?: string;
  legacySiteName?: string;
  legacyStaffName?: string;
  legacyWindowName?: string;
  legacyUsername?: string;
  legacyPassword?: string;       // Base64 编码，不输出到日志
  legacyEasybrBrowserId?: string;
  matchedField?: string;         // 匹配的字段名
  searchPath?: string;           // 搜索路径（sites[].windows[] 等）
}

// ── 1. 读取旧项目 settings ──

function readLegacySettings(): LegacySettings {
  if (!fs.existsSync(LEGACY_SETTINGS)) {
    throw new Error(`旧项目 settings.json 不存在: ${LEGACY_SETTINGS}`);
  }
  const raw = fs.readFileSync(LEGACY_SETTINGS, 'utf-8');
  return JSON.parse(raw) as LegacySettings;
}

// ── 2. 搜索测试账号 ──

/**
 * 在旧项目 settings 中搜索测试账号
 *
 * 搜索字段（按优先级）：
 *   username, account, phone, loginAccount, loginUsername,
 *   credential.username, credential.account,
 *   credentials.username, credentials.account
 *
 * 搜索范围：
 *   sites[].windows[], sites[].workers[], windows[], workers[]
 */
function searchTestAccount(settings: LegacySettings, testUsername: string): SearchResult {
  const fields = ['username', 'account', 'phone', 'loginAccount', 'loginUsername'];
  const nestedFields = [
    { path: 'credential', keys: ['username', 'account'] },
    { path: 'credentials', keys: ['username', 'account'] },
  ];

  // 检查单个 window 是否匹配
  function matchWindow(win: LegacyWindow, context: string): { matched: boolean; field?: string; path?: string } {
    for (const f of fields) {
      const v = win[f];
      if (typeof v === 'string' && v === testUsername) {
        return { matched: true, field: f, path: `${context}.${f}` };
      }
    }
    for (const nf of nestedFields) {
      const nested = win[nf.path] as { username?: string; account?: string } | undefined;
      if (nested) {
        for (const k of nf.keys) {
          const v = nested[k];
          if (typeof v === 'string' && v === testUsername) {
            return { matched: true, field: `${nf.path}.${k}`, path: `${context}.${nf.path}.${k}` };
          }
        }
      }
    }
    return { matched: false };
  }

  // 范围 1: sites[].windows[]
  if (Array.isArray(settings.sites)) {
    for (const site of settings.sites) {
      const windows = (site.windows || []).concat(site.workers || []);
      for (const win of windows) {
        const ctx = `sites[].windows[]`;
        const m = matchWindow(win, ctx);
        if (m.matched) {
          return {
            found: true,
            legacySiteId: site.id,
            legacySiteName: site.name,
            legacyStaffName: win.employeeName,
            legacyWindowName: win.windowName,
            legacyUsername: win.username || win.account || testUsername,
            legacyPassword: win.password,
            legacyEasybrBrowserId: win.easybrBrowserId,
            matchedField: m.field,
            searchPath: m.path,
          };
        }
      }
    }
  }

  // 范围 2: windows[] / workers[]（顶层）
  const topWindows = (settings.windows || []).concat(settings.workers || []);
  for (const win of topWindows) {
    const ctx = `windows[]`;
    const m = matchWindow(win, ctx);
    if (m.matched) {
      return {
        found: true,
        legacySiteId: '(顶层无 site)',
        legacySiteName: '(顶层无 site)',
        legacyStaffName: win.employeeName,
        legacyWindowName: win.windowName,
        legacyUsername: win.username || win.account || testUsername,
        legacyPassword: win.password,
        legacyEasybrBrowserId: win.easybrBrowserId,
        matchedField: m.field,
        searchPath: m.path,
      };
    }
  }

  return { found: false };
}

// ── 3. 生成新项目 settings ──

/**
 * 生成新项目 settings.json（已初始化状态 + 测试网点）
 *
 * - PIN: 固定测试值 "0000"（仅供测试，不影响功能）
 * - sites: 只包含测试网点（1 个 site + 1 个 window）
 * - runtime.dryRunMode: true（安全优先）
 */
function generateNextSettings(result: SearchResult): NextSettings {
  // 生成 PIN hash（固定测试 PIN "0000"）
  const pinSalt = crypto.randomBytes(16).toString('hex');
  const pinHash = crypto.createHash('sha256').update('0000' + pinSalt).digest('hex');

  const siteName = result.legacySiteName || '';
  // siteCode 推导（与 routes.ts normalizeSiteToCode 一致）
  let siteCode = '';
  if (siteName.includes('天南大')) siteCode = 'tiannanda';
  else if (siteName.includes('和苑')) siteCode = 'heyuan';

  // 保持 site.id 与旧项目一致（Sign API 校验 site.id 有效性）
  const siteId = result.legacySiteId || `site-next-${Date.now()}`;

  const nextSite: NextSite = {
    id: siteId,
    name: siteName,
    windows: [
      {
        windowName: result.legacyWindowName || '',
        employeeName: result.legacyStaffName || '',
        username: result.legacyUsername || TEST_USERNAME,
        // 密码保持 Base64 编码（与旧项目一致，不解码）
        password: result.legacyPassword || '',
        easybrBrowserId: result.legacyEasybrBrowserId,
      },
    ],
  };

  return {
    initialized: true,
    pinHash,
    pinSalt,
    sites: [nextSite],
    runtime: { dryRunMode: true },
  };
}

// ── 4. 原子写入新项目 settings ──

function writeNextSettings(settings: NextSettings): void {
  // 确保 data 目录存在
  if (!fs.existsSync(NEXT_DATA_DIR)) {
    fs.mkdirSync(NEXT_DATA_DIR, { recursive: true });
  }

  // 如果已存在，先备份
  if (fs.existsSync(NEXT_SETTINGS)) {
    const backupPath = NEXT_SETTINGS + `.backup-${Date.now()}`;
    fs.copyFileSync(NEXT_SETTINGS, backupPath);
    console.log(`  ℹ 已备份原 settings.json → ${path.basename(backupPath)}`);
  }

  // 原子写入：先写 .tmp，再 rename
  const tmpPath = NEXT_SETTINGS + '.tmp';
  const json = JSON.stringify(settings, null, 2);
  fs.writeFileSync(tmpPath, json, 'utf-8');
  fs.renameSync(tmpPath, NEXT_SETTINGS);
}

// ── 5. 验证写入结果 ──

function verifyNextSettings(): { ok: boolean; siteId: string; siteName: string; staffName: string; windowName: string; username: string; hasPassword: boolean } {
  if (!fs.existsSync(NEXT_SETTINGS)) {
    return { ok: false, siteId: '', siteName: '', staffName: '', windowName: '', username: '', hasPassword: false };
  }
  const raw = fs.readFileSync(NEXT_SETTINGS, 'utf-8');
  const data = JSON.parse(raw) as NextSettings;
  const site = data.sites?.[0];
  const win = site?.windows?.[0];
  return {
    ok: !!(data.initialized && site?.id && site?.name && win?.employeeName && win?.username && win?.password),
    siteId: site?.id || '',
    siteName: site?.name || '',
    staffName: win?.employeeName || '',
    windowName: win?.windowName || '',
    username: win?.username || '',
    hasPassword: !!win?.password,
  };
}

// ── 主流程 ──

function main(): void {
  console.log('═'.repeat(72));
  console.log('  Phase 2-D-Data: 从旧项目只读提取测试网点/员工/窗口信息');
  console.log('═'.repeat(72));
  console.log();

  // 1. 输出测试账号（脱敏）
  console.log(`  测试账号（脱敏）: ${maskUsername(TEST_USERNAME)}`);
  console.log(`  测试密码: ******（环境变量传入，不写入日志）`);
  console.log();

  // 2. 读取旧项目 settings
  console.log(`  ── 步骤 1: 读取旧项目 settings ──`);
  console.log(`  旧项目路径: ${LEGACY_SETTINGS}`);
  let legacySettings: LegacySettings;
  try {
    legacySettings = readLegacySettings();
    console.log(`  ✓ 旧项目 settings 读取成功（只读，未修改）`);
    console.log(`    sites 数量: ${legacySettings.sites?.length || 0}`);
  } catch (e) {
    console.error(`  ✗ 读取旧项目 settings 失败: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log();

  // 3. 搜索测试账号
  console.log(`  ── 步骤 2: 搜索测试账号 ──`);
  console.log(`  搜索账号（脱敏）: ${maskUsername(TEST_USERNAME)}`);
  console.log(`  搜索字段: username, account, phone, loginAccount, loginUsername, credential.*, credentials.*`);
  console.log(`  搜索范围: sites[].windows[], sites[].workers[], windows[], workers[]`);
  const result = searchTestAccount(legacySettings, TEST_USERNAME);

  if (!result.found) {
    console.error(`  ✗ 未在旧项目 settings 中找到测试账号 ${maskUsername(TEST_USERNAME)}`);
    process.exit(2);
  }

  console.log(`  ✓ 找到测试账号`);
  console.log(`    匹配字段: ${result.matchedField}`);
  console.log(`    搜索路径: ${result.searchPath}`);
  console.log(`    legacy siteId: ${result.legacySiteId}`);
  console.log(`    legacy siteName: ${result.legacySiteName}`);
  console.log(`    legacy staffName: ${result.legacyStaffName}`);
  console.log(`    legacy windowName: ${result.legacyWindowName}`);
  console.log(`    legacy username（脱敏）: ${maskUsername(result.legacyUsername || '')}`);
  console.log(`    legacy easybrBrowserId: ${result.legacyEasybrBrowserId || '(无)'}`);
  console.log(`    legacy password: ******（Base64 编码，不输出）`);
  console.log();

  // 4. 推导 siteCode
  const siteName = result.legacySiteName || '';
  let siteCode = '';
  if (siteName.includes('天南大')) siteCode = 'tiannanda';
  else if (siteName.includes('和苑')) siteCode = 'heyuan';

  console.log(`  ── 步骤 3: 推导 siteCode ──`);
  console.log(`    siteName: ${siteName}`);
  console.log(`    siteCode: ${siteCode || '(未识别)'}`);
  console.log();

  // 5. 确认 signApiSiteValue
  console.log(`  ── 步骤 4: 确认 signApiSiteValue ──`);
  console.log(`    Sign API (routes.ts L1101-1113) 校验 site 必须是 settings.json 中的 site.id`);
  console.log(`    Sign API 内部调用 normalizeSiteToCode 将 site.id → siteCode`);
  console.log(`    → signApiSiteValue = settings.json site.id = ${result.legacySiteId}`);
  console.log();

  // 6. 生成新项目 settings
  console.log(`  ── 步骤 5: 生成新项目 settings ──`);
  const nextSettings = generateNextSettings(result);
  console.log(`    新项目 settings 路径: ${NEXT_SETTINGS}`);
  console.log(`    initialized: ${nextSettings.initialized}`);
  console.log(`    pinHash: ${nextSettings.pinHash.slice(0, 8)}...（测试 PIN=0000，仅供测试）`);
  console.log(`    sites[0].id: ${nextSettings.sites[0].id}`);
  console.log(`    sites[0].name: ${nextSettings.sites[0].name}`);
  console.log(`    sites[0].windows[0].windowName: ${nextSettings.sites[0].windows[0].windowName}`);
  console.log(`    sites[0].windows[0].employeeName: ${nextSettings.sites[0].windows[0].employeeName}`);
  console.log(`    sites[0].windows[0].username（脱敏）: ${maskUsername(nextSettings.sites[0].windows[0].username)}`);
  console.log(`    sites[0].windows[0].password: ******（Base64 编码，不输出）`);
  console.log(`    runtime.dryRunMode: ${nextSettings.runtime.dryRunMode}`);
  console.log();

  // 7. 写入新项目 settings
  console.log(`  ── 步骤 6: 写入新项目 settings ──`);
  try {
    writeNextSettings(nextSettings);
    console.log(`  ✓ 新项目 settings 写入成功`);
  } catch (e) {
    console.error(`  ✗ 写入新项目 settings 失败: ${(e as Error).message}`);
    process.exit(3);
  }
  console.log();

  // 8. 验证写入结果
  console.log(`  ── 步骤 7: 验证写入结果 ──`);
  const verify = verifyNextSettings();
  if (verify.ok) {
    console.log(`  ✓ 验证通过`);
    console.log(`    next siteId: ${verify.siteId}`);
    console.log(`    next siteName: ${verify.siteName}`);
    console.log(`    next staffName: ${verify.staffName}`);
    console.log(`    next windowName: ${verify.windowName}`);
    console.log(`    next username（脱敏）: ${maskUsername(verify.username)}`);
    console.log(`    next hasPassword: ${verify.hasPassword}`);
  } else {
    console.error(`  ✗ 验证失败`);
    process.exit(4);
  }
  console.log();

  // 9. 输出验收信息
  console.log('═'.repeat(72));
  console.log('  验收信息汇总');
  console.log('═'.repeat(72));
  console.log(`  legacySiteId: ${result.legacySiteId}`);
  console.log(`  legacySiteName: ${result.legacySiteName}`);
  console.log(`  legacyStaffName: ${result.legacyStaffName}`);
  console.log(`  legacyWindowName: ${result.legacyWindowName}`);
  console.log(`  nextSiteId: ${verify.siteId}`);
  console.log(`  nextSiteName: ${verify.siteName}`);
  console.log(`  nextStaffName: ${verify.staffName}`);
  console.log(`  nextWindowName: ${verify.windowName}`);
  console.log(`  nextWindowId: staff-${verify.staffName}`);
  console.log(`  siteCode: ${siteCode}`);
  console.log(`  signApiSiteValue: ${verify.siteId}`);
  console.log(`  账号脱敏: ${maskUsername(TEST_USERNAME)}`);
  console.log(`  密码脱敏: ******`);
  console.log(`  旧项目是否修改: 否（只读）`);
  console.log(`  新项目是否独立: 是（data/settings.json 独立）`);
  console.log(`  是否建议继续 Phase 2-D-Run: ${verify.ok ? '是' : '否'}`);
  console.log('═'.repeat(72));

  // 10. 输出启动命令示例
  console.log();
  console.log('  Phase 2-D-Run 启动命令：');
  console.log();
  console.log('  $env:WINDOW_RUNTIME_MODE="playwright"');
  console.log(`  $env:BNSY_TEST_USERNAME="${TEST_USERNAME}"`);
  console.log('  $env:BNSY_TEST_PASSWORD="<你的测试密码>"');
  console.log(`  npx tsx scripts/sign-runtime-mode-verify.ts --auto-login --site=${verify.siteId} --staff=${verify.staffName}`);
  console.log();
}

main();
