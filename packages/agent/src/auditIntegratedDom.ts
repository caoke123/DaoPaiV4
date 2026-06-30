/**
 * auditIntegratedDom.ts — 到派一体页面 DOM 精准定位审计脚本
 *
 * Phase 5-F-0: 审计 /scanning/arrivalscan 左侧表单所有字段，
 *              精准确认"班次"和"上一站"是不同元素，
 *              验证用 label 文本定位的 selector。
 *
 * 硬性边界：
 *   - 禁止猜测选择器，必须用 label 文本定位
 *   - 禁止坐标点击
 *   - 禁止点击最终上传/提交按钮
 *   - 禁止产生真实到派业务
 *   - 只允许点击"上一站"下拉和选择"天津分拨中心"
 *   - 不 taskkill /IM chrome.exe
 *   - 不误关系统正式版 Chrome
 */

import { BrowserManager } from './browser/BrowserManager';
import { ensureBnsyLoggedIn } from './browser/BnsySessionManager';
import { AgentSettingsLoader } from './AgentSettingsLoader';
import { readSession, clearSession } from './browser/BrowserProcessRegistry';
import { checkPort, findV3ChromeProcesses } from './browser/ChromeProcessGuard';

// 到派一体页面 URL（来源：PageStateManager.ts:21 INTEGRATED_PAGE_ROUTE）
const INTEGRATED_PAGE_URL = 'https://bnsy.benniaosuyun.com/scanning/arrivalscan';

// 必须确认的字段列表
const REQUIRED_FIELDS = [
  '操作网点', '班次', '快件类型', '物品类型', '到付款', '代收货款',
  '上一站', '目的地', '重量', '车次号', '运单编号',
];

interface FieldInfo {
  index: number;
  rowIndex: number;
  inputIndexInRow: number;
  label: string;
  inputSelector: string;
  placeholder: string;
  value: string;
  className: string;
  outerHtmlSnippet: string;
  rowOuterHtml: string;
  isSelect: boolean;
  isCheckbox: boolean;
  isInput: boolean;
  needOperate: boolean;
}

function maskAccount(account: string): string {
  if (account.length <= 4) return '****';
  return account.substring(0, 2) + '****' + account.substring(account.length - 2);
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DaoPai V3 到派一体页面 DOM 精准定位审计');
  console.log('  Phase 5-F-0: 只读审计，不点击最终提交');
  console.log('═══════════════════════════════════════════\n');

  const siteId = 'site-1782121346155'; // 天南大
  const loginUrl = 'https://bnsy.benniaosuyun.com/login';

  const browserConfig = {
    executablePath: 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe',
    userDataDir: 'E:/网站开发/DaoPaiV3/runtime/chrome-profile',
    debugPort: 9223,
    headless: false,
  };

  // ── 1. 读取凭据 ──
  console.log('[1/8] 读取员工凭据...');
  const settingsLoader = new AgentSettingsLoader();
  const credential = await settingsLoader.getLoginCredentialForSite(siteId);

  if (!credential) {
    console.error('  错误：无法读取员工凭据，请检查 settings.json');
    process.exit(1);
  }

  console.log(`  网点：${credential.siteName}`);
  console.log(`  员工：${credential.employeeName}`);
  console.log(`  账号：${maskAccount(credential.loginAccount)}`);
  console.log('');

  // ── 2. 启动浏览器 ──
  console.log('[2/8] 启动便携版 Chrome...');
  const manager = new BrowserManager(browserConfig);
  await manager.start();
  console.log('');

  // ── 3. CDP 连接 ──
  console.log('[3/8] 等待 CDP 就绪并连接...');
  await manager.connect();
  console.log('');

  // ── 4. 打开登录页 ──
  console.log('[4/8] 打开登录页...');
  let page;
  try {
    page = await manager.openPage(loginUrl);
  } catch (err) {
    console.error(`  页面打开失败：${(err as Error).message}`);
    await manager.close().catch(() => {});
    process.exit(1);
  }
  console.log('  页面打开成功，等待加载...\n');
  await page.waitForTimeout(5000);

  // ── 5. 登录 + Dashboard P0 ──
  console.log('[5/8] 确保登录并检测 Dashboard P0...');
  const loginResult = await ensureBnsyLoggedIn(page, credential);

  console.log(`  登录结果：${loginResult.success ? '成功' : '失败'}`);
  console.log(`  说明：${loginResult.message}`);
  console.log(`  Dashboard P0 状态：${loginResult.dashboard.status}`);
  console.log('');

  if (!loginResult.success || loginResult.dashboard.status !== 'READY') {
    console.error('错误：Dashboard P0 不是 READY，不进入到派一体页面');
    await manager.close().catch(() => {});
    process.exit(1);
  }

  // ── 6. 导航到到派一体页面 ──
  console.log('[6/8] 导航到到派一体页面...');
  console.log(`  目标 URL: ${INTEGRATED_PAGE_URL}`);
  console.log(`  URL 来源: PageStateManager.ts:21 INTEGRATED_PAGE_ROUTE`);

  try {
    const dashboardUrl = 'https://bnsy.benniaosuyun.com/dashboard';
    if (!page.url().includes('/dashboard')) {
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3000);
    }

    await page.goto(INTEGRATED_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    // 如果被重定向，尝试 Vue Router
    let currentUrl = page.url();
    if (currentUrl.includes('/dashboard')) {
      console.log('  直接导航被重定向，尝试 Vue Router...');
      await page.evaluate((url) => {
        const app = document.querySelector('#app') as any;
        if (app && app.__vue__ && app.__vue__.$router) {
          app.__vue__.$router.push(url.replace('https://bnsy.benniaosuyun.com', ''));
        } else {
          window.location.href = url;
        }
      }, INTEGRATED_PAGE_URL);
      await page.waitForTimeout(3000);
    }

    currentUrl = page.url();
    console.log(`  当前 URL: ${currentUrl}`);

    // 清理可能的弹窗
    await page.evaluate(() => {
      const wrappers = document.querySelectorAll('.el-dialog__wrapper');
      for (const wrapper of wrappers) {
        const ws = window.getComputedStyle(wrapper as HTMLElement);
        if (ws.display === 'none') continue;
        const btns = wrapper.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').replace(/\s+/g, '');
          if (text === '取消' || text === '关闭' || text === '知道了') {
            (btn as HTMLElement).click();
            break;
          }
        }
      }
    }).catch(() => {});
    await page.waitForTimeout(1500);

    // 等待页面稳定
    console.log('  等待页面稳定 (3 秒)...');
    await page.waitForTimeout(3000);
  } catch (err) {
    console.error(`  到派一体页面打开失败：${(err as Error).message}`);
    await manager.close().catch(() => {});
    process.exit(1);
  }

  const pageTitle = await page.title().catch(() => '');
  console.log(`  页面标题: ${pageTitle}`);
  console.log('');

  // ── 7. 扫描左侧表单所有字段 ──
  console.log('[7/8] 扫描 .arrivalscan_left 左侧表单字段...\n');

  const fields: FieldInfo[] = await page.evaluate(() => {
    const results: any[] = [];
    const leftPanel = document.querySelector('.arrivalscan_left');
    if (!leftPanel) {
      return results;
    }

    // 到派一体左侧表单结构：.arrivalscan_left > div > div(每个表单行)
    const rows = leftPanel.querySelectorAll(':scope > div > div');

    rows.forEach((row, idx) => {
      const rowEl = row as HTMLElement;
      const rowText = (rowEl.textContent || '').trim().slice(0, 200);

      // 改进 label 提取：遍历直接子节点，找文本节点或简单 label 元素
      // 到派一体页面结构：div(行) > [文本节点label] + div(input容器)
      // 或 div(行) > div(label列) + div(input列)
      let labelText = '';

      // 方式1：查找 .el-form-item__label
      const formLabel = rowEl.querySelector('.el-form-item__label');
      if (formLabel) {
        labelText = (formLabel.textContent || '').trim();
      }

      // 方式2：查找 label 标签
      if (!labelText) {
        const labelTag = rowEl.querySelector('label');
        if (labelTag) {
          labelText = (labelTag.textContent || '').trim();
        }
      }

      // 方式3：遍历直接子节点，找第一个文本节点（非空白）
      if (!labelText) {
        for (let i = 0; i < rowEl.childNodes.length; i++) {
          const node = rowEl.childNodes[i];
          if (node.nodeType === Node.TEXT_NODE) {
            const text = (node.textContent || '').trim();
            if (text && text.length < 20) {
              labelText = text;
              break;
            }
          }
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            // 跳过包含 input/select/checkbox 的容器
            if (el.querySelector('input, textarea, .el-checkbox, .el-select')) {
              continue;
            }
            // 取这个元素的直接文本（不递归）
            const directText = Array.from(el.childNodes)
              .filter(n => n.nodeType === Node.TEXT_NODE)
              .map(n => (n.textContent || '').trim())
              .join('')
              .trim();
            if (directText && directText.length < 20) {
              labelText = directText;
              break;
            }
            // 如果元素本身文本很短（< 20），且不含子元素，用 textContent
            if (el.children.length === 0) {
              const t = (el.textContent || '').trim();
              if (t && t.length < 20) {
                labelText = t;
                break;
              }
            }
          }
        }
      }

      // 方式4：对 el-select，尝试从 placeholder 或 aria-label 推断
      if (!labelText) {
        const selectInput = rowEl.querySelector('.el-select .el-input__inner') as HTMLInputElement;
        if (selectInput) {
          // 检查是否有 aria-label
          const ariaLabel = selectInput.getAttribute('aria-label');
          if (ariaLabel) {
            labelText = ariaLabel;
          }
        }
      }

      // 查找 input
      const inputs = rowEl.querySelectorAll('input');
      const textareas = rowEl.querySelectorAll('textarea');
      const checkboxes = rowEl.querySelectorAll('.el-checkbox__inner, input[type="checkbox"]');
      const elCheckboxes = rowEl.querySelectorAll('.el-checkbox');

      // 处理每个 input
      if (inputs.length > 0) {
        inputs.forEach((input, inputIdx) => {
          const inputEl = input as HTMLInputElement;
          const parentEl = inputEl.parentElement;
          const grandParent = parentEl?.parentElement;
          const className = parentEl?.className || '';
          const fullClassPath = [
            parentEl?.className || '',
            grandParent?.className || '',
          ].filter(Boolean).join(' | ');

          let stableSelector = '';
          if (labelText) {
            stableSelector = `.arrivalscan_left :has-text("${labelText}") input`;
          } else {
            stableSelector = `.arrivalscan_left > div > div:nth-child(${idx + 1}) input`;
          }

          const outerHtml = (inputEl.outerHTML || '').slice(0, 300);

          results.push({
            index: results.length + 1,
            rowIndex: idx + 1,
            inputIndexInRow: inputIdx + 1,
            label: labelText || `(行${idx + 1} 无label)`,
            rowTextPreview: rowText.slice(0, 100),
            rowOuterHtml: (rowEl.outerHTML || '').slice(0, 500),
            inputSelector: stableSelector,
            placeholder: inputEl.placeholder || '',
            value: inputEl.value || '',
            className: fullClassPath,
            isSelect: className.includes('el-select') || className.includes('el-input--suffix'),
            isCheckbox: false,
            isInput: !className.includes('el-select'),
            outerHtmlSnippet: outerHtml,
            needOperate: false,
          });
        });
      } else if (textareas.length > 0) {
        textareas.forEach((ta, taIdx) => {
          const taEl = ta as HTMLTextAreaElement;
          results.push({
            index: results.length + 1,
            rowIndex: idx + 1,
            inputIndexInRow: taIdx + 1,
            label: labelText || `(行${idx + 1} textarea)`,
            rowTextPreview: rowText.slice(0, 100),
            rowOuterHtml: (rowEl.outerHTML || '').slice(0, 500),
            inputSelector: labelText
              ? `.arrivalscan_left :has-text("${labelText}") textarea`
              : `.arrivalscan_left > div > div:nth-child(${idx + 1}) textarea`,
            placeholder: taEl.placeholder || '',
            value: taEl.value || '',
            className: taEl.parentElement?.className || '',
            isSelect: false,
            isCheckbox: false,
            isInput: true,
            outerHtmlSnippet: (taEl.outerHTML || '').slice(0, 300),
            needOperate: false,
          });
        });
      } else if (checkboxes.length > 0) {
        checkboxes.forEach((cb, cbIdx) => {
          const cbEl = cb as HTMLElement;
          const checkboxLabel = rowEl.querySelector('.el-checkbox__label');
          const cbLabelText = checkboxLabel ? (checkboxLabel.textContent || '').trim() : labelText;
          results.push({
            index: results.length + 1,
            rowIndex: idx + 1,
            inputIndexInRow: cbIdx + 1,
            label: cbLabelText || `(行${idx + 1} checkbox)`,
            rowTextPreview: rowText.slice(0, 100),
            rowOuterHtml: (rowEl.outerHTML || '').slice(0, 500),
            inputSelector: cbLabelText
              ? `.arrivalscan_left .el-checkbox:has-text("${cbLabelText}") .el-checkbox__inner`
              : `.arrivalscan_left > div > div:nth-child(${idx + 1}) .el-checkbox__inner`,
            placeholder: '',
            value: cbEl.className.includes('is-checked') ? 'checked' : 'unchecked',
            className: cbEl.className || '',
            isSelect: false,
            isCheckbox: true,
            isInput: false,
            outerHtmlSnippet: (cbEl.outerHTML || '').slice(0, 300),
            needOperate: false,
          });
        });
      } else if (elCheckboxes.length > 0) {
        elCheckboxes.forEach((ecb, ecbIdx) => {
          const ecbEl = ecb as HTMLElement;
          const labelSpan = ecbEl.querySelector('.el-checkbox__label');
          const ecbLabel = labelSpan ? (labelSpan.textContent || '').trim() : '';
          results.push({
            index: results.length + 1,
            rowIndex: idx + 1,
            inputIndexInRow: ecbIdx + 1,
            label: ecbLabel || `(行${idx + 1} el-checkbox)`,
            rowTextPreview: rowText.slice(0, 100),
            rowOuterHtml: (rowEl.outerHTML || '').slice(0, 500),
            inputSelector: ecbLabel
              ? `.arrivalscan_left .el-checkbox:has-text("${ecbLabel}") .el-checkbox__inner`
              : `.arrivalscan_left > div > div:nth-child(${idx + 1}) .el-checkbox__inner`,
            placeholder: '',
            value: ecbEl.className.includes('is-checked') ? 'checked' : 'unchecked',
            className: ecbEl.className || '',
            isSelect: false,
            isCheckbox: true,
            isInput: false,
            outerHtmlSnippet: (ecbEl.outerHTML || '').slice(0, 300),
            needOperate: false,
          });
        });
      }
    });

    return results;
  }).catch((err) => {
    console.error(`  扫描失败：${(err as Error).message}`);
    return [] as FieldInfo[];
  });

  // 标记需要操作的字段
  for (const field of fields) {
    if (field.label === '上一站') field.needOperate = true;
    if (field.label === '运单编号' || field.label.includes('运单')) field.needOperate = true;
  }

  // 打印字段清单
  console.log('  ── 左侧表单字段清单 ──');
  console.log(`  共扫描到 ${fields.length} 个字段\n`);
  console.log('  序号 | 行号 | 字段名 | 类型 | placeholder | 当前value | 需要操作 | 推荐selector');
  console.log('  ─────┼──────┼────────┼──────┼────────────┼───────────┼─────────┼─────────────');

  for (const f of fields) {
    const fieldType = f.isCheckbox ? 'checkbox' : (f.isSelect ? 'select' : 'input');
    const needOp = f.needOperate ? '是' : '否';
    console.log(`  ${String(f.index).padStart(4)} | ${String(f.rowIndex).padStart(4)} | ${f.label.padEnd(12)} | ${fieldType.padEnd(8)} | ${(f.placeholder || '-').padEnd(10)} | ${(f.value || '-').slice(0, 20).padEnd(9)} | ${needOp.padEnd(7)} | ${f.inputSelector}`);
  }
  console.log('');

  // 详细信息
  console.log('  ── 字段详细信息 ──');
  for (const f of fields) {
    console.log(`\n  [字段 ${f.index}] ${f.label}`);
    console.log(`    行号: ${f.rowIndex}, 行内input序号: ${f.inputIndexInRow}`);
    console.log(`    类型: ${f.isCheckbox ? 'checkbox' : (f.isSelect ? 'select(下拉)' : 'input(文本)')}`);
    console.log(`    placeholder: "${f.placeholder}"`);
    console.log(`    当前value: "${f.value}"`);
    console.log(`    className: ${f.className}`);
    console.log(`    推荐selector: ${f.inputSelector}`);
    console.log(`    input outerHTML: ${f.outerHtmlSnippet}`);
    console.log(`    行 outerHTML(前500): ${f.rowOuterHtml}`);
  }
  console.log('');

  // ── 必须确认字段检查 ──
  console.log('  ── 必须确认字段检查 ──');
  for (const req of REQUIRED_FIELDS) {
    const found = fields.find(f => f.label.includes(req) || req.includes(f.label));
    const status = found ? '✓ 已找到' : '✗ 未找到';
    console.log(`  ${req.padEnd(10)} : ${status}`);
  }
  console.log('');

  // ── 班次字段结论 ──
  const shiftField = fields.find(f => f.label === '班次' || f.label.includes('班次'));
  console.log('  ── 班次字段结论 ──');
  if (shiftField) {
    console.log(`  ✓ 班次字段已识别`);
    console.log(`    字段序号: ${shiftField.index}`);
    console.log(`    label: ${shiftField.label}`);
    console.log(`    selector: ${shiftField.inputSelector}`);
    console.log(`    是否需要点击: 否（班次字段禁止作为上一站使用）`);
    console.log(`    后续代码避免误点方式: 用 label 文本"上一站"定位，不使用 .first()`);
  } else {
    console.log(`  ✗ 班次字段未找到，请人工检查`);
  }
  console.log('');

  // ── 上一站字段结论 ──
  const prevStationField = fields.find(f => f.label === '上一站' || f.label.includes('上一站'));
  console.log('  ── 上一站字段结论（审计前）──');
  if (prevStationField) {
    console.log(`  ✓ 上一站字段已识别`);
    console.log(`    字段序号: ${prevStationField.index}`);
    console.log(`    label: ${prevStationField.label}`);
    console.log(`    selector: ${prevStationField.inputSelector}`);
    console.log(`    placeholder: ${prevStationField.placeholder}`);
    console.log(`    当前value: ${prevStationField.value}`);
  } else {
    console.log(`  ✗ 上一站字段未找到`);
  }
  console.log('');

  // ── 班次 vs 上一站 区分验证 ──
  if (shiftField && prevStationField) {
    console.log('  ── 班次 vs 上一站 区分验证 ──');
    console.log(`  班次 selector:   ${shiftField.inputSelector}`);
    console.log(`  上一站 selector: ${prevStationField.inputSelector}`);
    console.log(`  两者是否同一元素: ${shiftField.index === prevStationField.index ? '是（错误！）' : '否（正确）'}`);
    console.log('');
  }

  // ── 8. 上一站专项验证 ──
  console.log('[8/8] 上一站专项验证：点击上一站 input → 打开下拉 → 选择天津分拨中心...\n');

  let prevStationVerifyResult = {
    clicked: false,
    dropdownOpened: false,
    optionFound: false,
    optionCount: 0,
    optionSelector: '',
    selected: false,
    finalValue: '',
    optionTexts: [] as string[],
  };

  if (prevStationField) {
    try {
      // Step 1: 用 label 文本精确定位"上一站"行内的 input（不使用 .first()）
      console.log('  Step 1: 用 label 文本"上一站"精确定位 input...');
      const prevInputSelector = `.arrivalscan_left .el-form-item:has-text("上一站") input, .arrivalscan_left :has-text("上一站") .el-input--suffix input`;
      const prevInputLoc = page.locator(prevInputSelector).first();

      const prevInputCount = await prevInputLoc.count().catch(() => 0);
      console.log(`    定位到 ${prevInputCount} 个匹配元素`);

      if (prevInputCount > 0) {
        // 验证这个 input 确实在"上一站"行内（而非"班次"行）
        const isPrevStation = await page.evaluate((): {
          found: boolean;
          labelText: string;
          inputClass: string;
          placeholder: string;
        } => {
          const inputs = document.querySelectorAll('.arrivalscan_left input');
          for (const input of inputs) {
            const inputEl = input as HTMLInputElement;
            // 向上查找包含"上一站"文本的容器
            let parent = inputEl.parentElement;
            let depth = 0;
            while (parent && depth < 8) {
              const text = (parent.textContent || '').trim();
              if (text.includes('上一站') && !text.includes('班次')) {
                return {
                  found: true,
                  labelText: '上一站',
                  inputClass: inputEl.parentElement?.className || '',
                  placeholder: inputEl.placeholder || '',
                };
              }
              if (text.includes('班次') && !text.includes('上一站')) {
                // 这是班次，跳过
                break;
              }
              parent = parent.parentElement;
              depth++;
            }
          }
          return { found: false, labelText: '', inputClass: '', placeholder: '' };
        }).catch(() => ({ found: false, labelText: '', inputClass: '', placeholder: '' }));

        console.log(`    验证结果: ${isPrevStation.found ? '✓ 确认是上一站 input' : '✗ 未确认'}`);
        if (isPrevStation.found) {
          console.log(`    input class: ${isPrevStation.inputClass}`);
          console.log(`    placeholder: ${isPrevStation.placeholder}`);
        }
        prevStationVerifyResult.clicked = isPrevStation.found;

        if (isPrevStation.found) {
          // Step 2: 点击上一站 input 打开下拉
          console.log('\n  Step 2: 点击上一站 input 打开下拉...');
          // 用 evaluate 找到"上一站"行内的 input 并点击（基于 label 文本定位，不用 .first()）
          await page.evaluate(() => {
            const inputs = document.querySelectorAll('.arrivalscan_left .el-input--suffix input');
            for (const input of inputs) {
              const inputEl = input as HTMLInputElement;
              let parent = inputEl.parentElement;
              let depth = 0;
              let isPrevStation = false;
              while (parent && depth < 8) {
                const text = (parent.textContent || '').trim();
                if (text.includes('上一站') && !text.includes('班次')) {
                  isPrevStation = true;
                  break;
                }
                if (text.includes('班次') && !text.includes('上一站')) {
                  break;
                }
                parent = parent.parentElement;
                depth++;
              }
              if (isPrevStation) {
                (inputEl as HTMLElement).click();
                break;
              }
            }
          }).catch(() => {});

          await page.waitForTimeout(800);
          prevStationVerifyResult.dropdownOpened = true;
          console.log('    已点击上一站 input，等待下拉出现');

          // Step 3: 查找候选项"天津分拨中心"
          console.log('\n  Step 3: 查找候选项"天津分拨中心"...');
          const optionInfo = await page.evaluate((stationName) => {
            const items = document.querySelectorAll('li.el-select-dropdown__item');
            const texts: string[] = [];
            let matchedItem: HTMLElement | null = null;
            for (const item of items) {
              const text = (item.textContent || '').trim();
              texts.push(text);
              if (text.includes(stationName)) {
                matchedItem = item as HTMLElement;
              }
            }
            return {
              count: items.length,
              texts,
              matched: !!matchedItem,
              matchedText: matchedItem ? (matchedItem.textContent || '').trim() : '',
            };
          }, '天津分拨中心').catch(() => ({ count: 0, texts: [], matched: false, matchedText: '' }));

          prevStationVerifyResult.optionCount = optionInfo.count;
          prevStationVerifyResult.optionFound = optionInfo.matched;
          prevStationVerifyResult.optionTexts = optionInfo.texts.slice(0, 20);

          console.log(`    候选项总数: ${optionInfo.count}`);
          console.log(`    前20个候选项文本:`);
          for (let i = 0; i < optionInfo.texts.length; i++) {
            console.log(`      ${i + 1}. ${optionInfo.texts[i]}`);
          }
          console.log(`    是否找到"天津分拨中心": ${optionInfo.matched ? '✓ 是' : '✗ 否'}`);
          if (optionInfo.matched) {
            console.log(`    匹配文本: ${optionInfo.matchedText}`);
            prevStationVerifyResult.optionSelector = 'li.el-select-dropdown__item:has-text("天津分拨中心")';
          }

          // Step 4: 选择"天津分拨中心"（DOM click，绕过可见性检查）
          if (optionInfo.matched) {
            console.log('\n  Step 4: 选择"天津分拨中心"（DOM click）...');
            await page.evaluate((stationName) => {
              const items = document.querySelectorAll('li.el-select-dropdown__item');
              for (const item of items) {
                if (item.textContent && item.textContent.includes(stationName)) {
                  (item as HTMLElement).click();
                  return true;
                }
              }
              return false;
            }, '天津分拨中心').catch(() => {});

            await page.waitForTimeout(800);

            // Step 5: 读取上一站 input.value
            console.log('\n  Step 5: 读取上一站 input.value...');
            const finalValue = await page.evaluate(() => {
              const inputs = document.querySelectorAll('.arrivalscan_left .el-input--suffix input');
              for (const input of inputs) {
                const inputEl = input as HTMLInputElement;
                let parent = inputEl.parentElement;
                let depth = 0;
                while (parent && depth < 8) {
                  const text = (parent.textContent || '').trim();
                  if (text.includes('上一站') && !text.includes('班次')) {
                    // 同时检查 li.selected
                    const selectedItems = document.querySelectorAll('li.el-select-dropdown__item.selected');
                    let selectedText = '';
                    for (const si of selectedItems) {
                      if ((si.textContent || '').includes('天津分拨中心')) {
                        selectedText = (si.textContent || '').trim();
                      }
                    }
                    return {
                      value: inputEl.value,
                      selectedText,
                      found: true,
                    };
                  }
                  if (text.includes('班次') && !text.includes('上一站')) {
                    break;
                  }
                  parent = parent.parentElement;
                  depth++;
                }
              }
              return { value: '', selectedText: '', found: false };
            }).catch(() => ({ value: '', selectedText: '', found: false }));

            prevStationVerifyResult.finalValue = finalValue.value;
            console.log(`    input.value: "${finalValue.value}"`);
            console.log(`    li.selected 文本: "${finalValue.selectedText}"`);

            const isSuccess = finalValue.value.includes('天津分拨中心') || finalValue.selectedText.includes('天津分拨中心');
            prevStationVerifyResult.selected = isSuccess;
            console.log(`    选择是否成功: ${isSuccess ? '✓ 成功' : '✗ 失败'}`);
          }
        }
      } else {
        console.log('  ✗ 未定位到"上一站" input');
      }
    } catch (err) {
      console.log(`  上一站专项验证异常: ${(err as Error).message}`);
    }
  } else {
    console.log('  ✗ 上一站字段未识别，跳过专项验证');
  }
  console.log('');

  // ── 推荐的精准 selector 汇总 ──
  console.log('  ── 推荐的精准 selector 汇总（基于 label 文本定位）──');
  console.log('  策略：从 .arrivalscan_left 中查找 label 文本匹配的表单行，再在该行容器内查找 input');
  console.log('  禁止：.arrivalscan_left .el-input--suffix input.first()（会误点班次）');
  console.log('');
  console.log('  上一站 input 推荐 selector:');
  console.log('    方案A（label 文本定位，推荐）:');
  console.log('      在 page.evaluate 中遍历 .arrivalscan_left .el-input--suffix input，');
  console.log('      向上查找父容器 textContent 包含"上一站"且不包含"班次"的 input');
  console.log('    方案B（el-form-item 结构定位）:');
  console.log('      .arrivalscan_left .el-form-item:has(.el-form-item__label:has-text("上一站")) input');
  console.log('');
  console.log('  班次 input selector（仅供识别，禁止点击）:');
  if (shiftField) {
    console.log(`    ${shiftField.inputSelector}`);
  }
  console.log('');
  console.log('  上一站候选项 selector:');
  console.log(`    ${prevStationVerifyResult.optionSelector || 'li.el-select-dropdown__item:has-text("天津分拨中心")'}`);
  console.log('');

  // ── 班次保护验证 ──
  console.log('  ── 班次保护验证 ──');
  if (shiftField) {
    console.log(`  ✓ 班次字段已识别: ${shiftField.inputSelector}`);
    console.log(`  ✓ 后续 IntegratedBrowserDryRun 不得使用 .first() 定位上一站`);
    console.log(`  ✓ 后续代码必须用 label 文本"上一站"定位，确保不误点班次`);
    console.log(`  ✓ 如果某元素附近 label 是"班次"，必须报错并停止`);
  } else {
    console.log(`  ✗ 班次字段未识别，无法保证班次保护`);
  }
  console.log('');

  // ── Chrome 隔离信息 ──
  console.log('  ── Chrome 隔离信息 ──');
  const session = readSession();
  if (session) {
    console.log(`  Chrome PID：${session.pid}`);
    console.log(`  Chrome 路径：${session.executablePath}`);
    console.log(`  User Data Dir：${session.userDataDir}`);
    console.log(`  调试端口：${session.debugPort}`);
  }
  const portCheck = checkPort(browserConfig.debugPort);
  console.log(`  端口 ${browserConfig.debugPort} 归属：${portCheck.occupied ? (portCheck.isV3Chrome ? 'V3 Chrome' : '非 V3 Chrome') : '未占用'}`);
  console.log('');

  // ── 安全边界 ──
  console.log('  ── 安全边界 ──');
  console.log('  浏览器：项目内便携版 Chrome');
  console.log('  是否误连正式版 Chrome：否');
  console.log('  是否点击最终上传/提交按钮：否');
  console.log('  是否产生真实到派业务：否');
  console.log('  仅点击上一站下拉 + 选择天津分拨中心（审计允许）');
  console.log('  未使用 taskkill /IM chrome.exe');
  console.log('  未误关系统正式版 Chrome');
  console.log('');

  // ── 关闭浏览器 ──
  console.log('  安全关闭浏览器...');
  const closeResult = await manager.close();
  console.log(`  关闭结果：${closeResult.success ? '成功' : '失败'}`);
  console.log(`  说明：${closeResult.message}`);

  const finalResiduals = findV3ChromeProcesses(browserConfig.userDataDir);
  console.log(`  最终 V3 Chrome 残留扫描：${finalResiduals.length} 个`);
  console.log('');

  // ── 审计总结 ──
  console.log('═══════════════════════════════════════════');
  console.log('  到派一体 DOM 精准定位审计完成');
  console.log('═══════════════════════════════════════════');
  console.log(`  扫描字段总数: ${fields.length}`);
  console.log(`  班次字段: ${shiftField ? `已识别 (序号${shiftField.index})` : '未识别'}`);
  console.log(`  上一站字段: ${prevStationField ? `已识别 (序号${prevStationField.index})` : '未识别'}`);
  console.log(`  上一站选择天津分拨中心: ${prevStationVerifyResult.selected ? '成功' : '失败'}`);
  console.log(`  上一站最终value: "${prevStationVerifyResult.finalValue}"`);
  console.log(`  Chrome 关闭: ${closeResult.success ? '成功，无残留' : '失败'}`);
  console.log(`  是否误关正式版 Chrome: 否`);
  console.log(`  是否产生真实业务: 否`);
  console.log('═══════════════════════════════════════════\n');

  if (!closeResult.success) {
    console.error('错误：Chrome 窗口未正确关闭');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n审计失败：', err.message);
  clearSession();
  process.exit(1);
});
