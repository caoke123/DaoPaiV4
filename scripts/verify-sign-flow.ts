/**
 * 签收流程验证脚本 — 实际登录并验证页面 DOM 结构
 * 
 * 目的：
 * 1. 验证日期选择器 actual DOM 结构（确认 placeholder vs .is-left/.is-right 选择器）
 * 2. 验证导航菜单层级（确认"操作中心 > 签收 > 签收录入"路径）
 * 3. 验证签收弹窗结构（确认 signerSelectInput / signerOptionTpl 选择器）
 * 4. 验证全选 checkbox 交互方式
 * 5. 验证弹窗（余额不足等）出现时机
 * 
 * 使用方式: npx tsx scripts/verify-sign-flow.ts
 */

import { chromium } from 'playwright';

const TARGET_URL = 'https://bnsy.benniaosuyun.com';
const LOGIN_URL = `${TARGET_URL}/login`;
const SIGN_URL = `${TARGET_URL}/scanning/signFor/signForInput`;

const CRED = {
  account: process.env.BNSY_TEST_USERNAME || 'mock_sign_account',
  password: process.env.BNSY_TEST_PASSWORD || 'mock_sign_password',
  staffName: '刘磊',
};

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log('=== 签收流程验证脚本 ===\n');

  try {
    // ── Step 1: 登录 ──
    console.log('[Step 1] 导航到登录页...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 检查登录页
    const accountInput = await page.$('input[placeholder="请输入账号"]');
    const passwordInput = await page.$('input[placeholder="请输入密码"]');

    if (!accountInput || !passwordInput) {
      console.error('❌ 未找到登录表单元素');
      // 打印当前页面内容帮助排查
      const bodyText = await page.textContent('body').catch(() => '');
      console.log('页面内容(前500字):', bodyText.slice(0, 500));
      await page.screenshot({ path: 'scripts/screenshots/01-login-page.png', fullPage: true });
      return;
    }

    console.log('  ✓ 找到登录表单');
    await accountInput.fill(CRED.account);
    await passwordInput.fill(CRED.password);
    console.log(`  ✓ 已填入账号: ${CRED.account}`);

    // 关闭可能的弹窗
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    // 点击登录按钮
    const loginBtn = await page.$('button.submitBtn') 
      || await page.$('button.el-button--primary')
      || await page.$('button:has-text("登录")');
    
    if (!loginBtn) {
      console.error('❌ 未找到登录按钮');
      await page.screenshot({ path: 'scripts/screenshots/01-login-no-btn.png', fullPage: true });
      return;
    }

    await loginBtn.click();
    console.log('  ✓ 已点击登录');

    // 等待登录跳转 + 清弹窗
    await page.waitForURL((url) => !url.toString().includes('/login') && !url.toString().includes('Login'), { timeout: 20000 });
    console.log('  ✓ 登录成功，当前URL:', page.url());

    // 清除可能的余额警告弹窗
    await page.waitForTimeout(2000);
    await dismissAllPopups(page);
    await page.screenshot({ path: 'scripts/screenshots/02-after-login.png', fullPage: false });

    // ── Step 2: 验证侧边栏导航结构 ──
    console.log('\n[Step 2] 验证侧边栏导航结构...');

    // 展开侧边栏
    await ensureSidebarExpanded(page);

    // 查找"操作中心"一级菜单
    const submenuTitles = await page.$$('.el-submenu__title');
    let operationCenterFound = false;
    for (const title of submenuTitles) {
      const text = (await title.textContent())?.trim();
      console.log(`  一级菜单: "${text}"`);
      if (text?.includes('操作中心')) {
        operationCenterFound = true;
        const parentEl = await title.evaluateHandle(el => el.closest('.el-submenu'));
        const isOpened = await parentEl.evaluate((el: Element | null) => el?.classList.contains('is-opened') ?? false);
        if (!isOpened) {
          await title.click();
          await page.waitForTimeout(500);
          console.log('  ✓ 已展开"操作中心"');
        } else {
          console.log('  ✓ "操作中心"已展开');
        }
      }
    }

    if (!operationCenterFound) {
      console.warn('  ⚠ 未找到"操作中心"一级菜单，尝试查找 .el-menu-item...');
      const menuItems = await page.$$('.el-menu-item');
      for (const item of menuItems) {
        const text = (await item.textContent())?.trim();
        console.log(`  菜单项: "${text}"`);
        if (text?.includes('操作中心')) {
          await item.click();
          await page.waitForTimeout(500);
          operationCenterFound = true;
          break;
        }
      }
    }

    // 查找"签收录入"子菜单
    const allMenuItems = await page.$$('.el-menu-item');
    let signMenuItemFound = false;
    for (const item of allMenuItems) {
      const text = (await item.textContent())?.trim();
      const visible = await item.isVisible().catch(() => false);
      if (text?.includes('签收') || text?.includes('signFor')) {
        console.log(`  子菜单: "${text}" (visible=${visible})`);
      }
      if (text === '签收录入' && visible) {
        signMenuItemFound = true;
        console.log('  ✓ 找到"签收录入"菜单项');
      }
    }
    
    if (!signMenuItemFound) {
      console.warn('  ⚠ "签收录入"不可见，可能需要先点击"签收"子菜单');
      // 点击"签收"展开子菜单
      for (const item of allMenuItems) {
        const text = (await item.textContent())?.trim();
        if (text === '签收') {
          await item.click();
          await page.waitForTimeout(500);
          console.log('  ✓ 已点击"签收"');
          break;
        }
      }
    }

    await page.screenshot({ path: 'scripts/screenshots/03-sidebar-menu.png', fullPage: false });

    // ── Step 3: 导航到签收录入页面 ──
    console.log('\n[Step 3] 导航到签收录入页面...');
    
    // 方法1: 菜单点击
    let navigated = false;
    for (const item of await page.$$('.el-menu-item')) {
      const text = (await item.textContent())?.trim();
      const visible = await item.isVisible().catch(() => false);
      if (text === '签收录入' && visible) {
        await item.click();
        navigated = true;
        console.log('  ✓ 通过菜单点击导航');
        break;
      }
    }

    // 方法2: URL 直连
    if (!navigated) {
      console.log('  → 菜单导航失败，使用 URL 直连...');
      await page.goto(SIGN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    await page.waitForTimeout(3000);
    await dismissAllPopups(page);
    console.log('  ✓ 当前URL:', page.url());

    // ── Step 4: 验证签收页面 DOM 结构 ──
    console.log('\n[Step 4] 验证签收页面 DOM 结构...');

    // 4a. 验证搜索区域
    const searchWrap = await page.$('.search-wrap');
    console.log('  .search-wrap:', searchWrap ? '✓ 存在' : '✗ 不存在');

    const dateRangeInput = await page.$('.search-wrap .inputs .el-date-editor input');
    console.log('  dateRangeInput (.search-wrap .inputs .el-date-editor input):', dateRangeInput ? '✓ 存在' : '✗ 不存在');

    const courierSelectInput = await page.$('.search-wrap .inputs .el-select input');
    console.log('  courierSelectInput:', courierSelectInput ? '✓ 存在' : '✗ 不存在');

    const searchButton = await page.$('.search-wrap .item-actions .el-button--primary');
    console.log('  searchButton:', searchButton ? '✓ 存在' : '✗ 不存在');

    const batchSignButton = await page.$('.search-wrap .item-actions .el-button--danger');
    console.log('  batchSignButton:', batchSignButton ? '✓ 存在' : '✗ 不存在');

    // 4b. 验证日期选择器结构（关键！）
    console.log('\n  --- 日期选择器验证 ---');
    if (dateRangeInput) {
      await dateRangeInput.click();
      await page.waitForTimeout(1000);

      // 检查日期面板是否存在
      const datePicker = await page.$('.el-date-range-picker');
      console.log('  .el-date-range-picker:', datePicker ? '✓ 存在' : '✗ 不存在');

      if (datePicker) {
        // 检查时间头部区域
        const timeHeader = await page.$('.el-date-range-picker__time-header');
        console.log('  .el-date-range-picker__time-header:', timeHeader ? '✓ 存在' : '✗ 不存在');

        if (timeHeader) {
          // 获取 time-header 的 HTML 结构
          const timeHeaderHTML = await timeHeader.evaluate(el => el.innerHTML.slice(0, 500));
          console.log('  __time-header innerHTML(前500):', timeHeaderHTML);

          // 检查所有 input 元素
          const timeHeaderInputs = await timeHeader.$$('input');
          console.log(`  __time-header 内 input 数量: ${timeHeaderInputs.length}`);
          for (let i = 0; i < timeHeaderInputs.length; i++) {
            const inp = timeHeaderInputs[i];
            const placeholder = await inp.getAttribute('placeholder').catch(() => 'N/A');
            const className = await inp.evaluate(el => (el.parentElement?.className || '')).catch(() => 'N/A');
            const isLeft = className.includes('is-left');
            const isRight = className.includes('is-right');
            console.log(`    input[${i}]: placeholder="${placeholder}" parentClass="${className}" isLeft=${isLeft} isRight=${isRight}`);
          }
        }

        // 检查 .is-left / .is-right 选择器
        const isLeftInputs = await page.$$('.el-date-range-picker__time-header .is-left input');
        const isRightInputs = await page.$$('.el-date-range-picker__time-header .is-right input');
        console.log(`  .is-left input 数量: ${isLeftInputs.length}`);
        console.log(`  .is-right input 数量: ${isRightInputs.length}`);

        // 检查 placeholder="开始日期" / "结束日期"
        const startPlaceholderInputs = await page.$$('.el-date-range-picker__time-header input[placeholder="开始日期"]');
        const endPlaceholderInputs = await page.$$('.el-date-range-picker__time-header input[placeholder="结束日期"]');
        console.log(`  input[placeholder="开始日期"] 数量: ${startPlaceholderInputs.length}`);
        console.log(`  input[placeholder="结束日期"] 数量: ${endPlaceholderInputs.length}`);

        // 检查确认按钮
        const confirmBtn = await page.$('.el-picker-panel__footer .el-button--primary');
        const defaultBtn = await page.$('.el-picker-panel__footer .el-button--default');
        console.log(`  确认按钮(.el-button--primary): ${confirmBtn ? '✓' : '✗'}`);
        console.log(`  确认按钮(.el-button--default): ${defaultBtn ? '✓' : '✗'}`);

        // 关闭日期面板
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }
    }

    await page.screenshot({ path: 'scripts/screenshots/04-sign-page.png', fullPage: false });

    // 4c. 验证表格结构
    console.log('\n  --- 表格结构验证 ---');
    const tableHeaderWrapper = await page.$('.el-table__header-wrapper');
    console.log('  .el-table__header-wrapper:', tableHeaderWrapper ? '✓ 存在' : '✗ 不存在');

    const headerCheckbox = await page.$('.el-table__header-wrapper input[type="checkbox"]');
    console.log('  header input[type="checkbox"]:', headerCheckbox ? '✓ 存在' : '✗ 不存在');

    const tableBodyWrapper = await page.$('.el-table__body-wrapper');
    console.log('  .el-table__body-wrapper:', tableBodyWrapper ? '✓ 存在' : '✗ 不存在');

    // 验证分页
    const pagination = await page.$('.el-pagination');
    console.log('  .el-pagination:', pagination ? '✓ 存在' : '✗ 不存在');

    if (pagination) {
      const pageSizeInput = await page.$('.el-pagination .el-pagination__sizes .el-input input');
      console.log('  pageSizeInput:', pageSizeInput ? '✓ 存在' : '✗ 不存在');
      if (pageSizeInput) {
        const val = await pageSizeInput.inputValue();
        console.log(`    当前值: "${val}"`);
      }
    }

    // ── Step 5: 模拟签收操作流程 ──
    console.log('\n[Step 5] 模拟签收操作...');

    // 5a. 设置日期为当天
    console.log('  5a. 设置日期...');
    if (dateRangeInput) {
      await dateRangeInput.click();
      await page.waitForTimeout(800);

      // 尝试用 .is-left/.is-right 选择器填入日期
      const now = new Date();
      const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      
      let startFilled = false;
      let endFilled = false;
      
      // 尝试1: .is-left / .is-right
      const leftInput = await page.$('.el-date-range-picker__time-header .is-left input');
      const rightInput = await page.$('.el-date-range-picker__time-header .is-right input');
      
      if (leftInput) {
        await leftInput.fill(dateStr);
        startFilled = true;
        console.log(`    ✓ .is-left input 填入: ${dateStr}`);
      }
      if (rightInput) {
        await rightInput.fill(dateStr);
        endFilled = true;
        console.log(`    ✓ .is-right input 填入: ${dateStr}`);
      }

      // 尝试2: placeholder 选择器
      if (!startFilled) {
        const startInput = await page.$('.el-date-range-picker__time-header input[placeholder="开始日期"]');
        if (startInput) {
          await startInput.fill(dateStr);
          startFilled = true;
          console.log(`    ✓ placeholder="开始日期" 填入: ${dateStr}`);
        }
      }
      if (!endFilled) {
        const endInput = await page.$('.el-date-range-picker__time-header input[placeholder="结束日期"]');
        if (endInput) {
          await endInput.fill(dateStr);
          endFilled = true;
          console.log(`    ✓ placeholder="结束日期" 填入: ${dateStr}`);
        }
      }

      if (!startFilled || !endFilled) {
        console.warn(`    ⚠ 日期填入失败: start=${startFilled}, end=${endFilled}`);
        // 打印日期面板完整 HTML
        const pickerHTML = await page.evaluate(() => {
          const picker = document.querySelector('.el-date-range-picker, .el-picker-panel');
          return picker?.innerHTML.slice(0, 1000) || 'NOT FOUND';
        });
        console.log('    日期面板HTML(前1000):', pickerHTML);
      }

      // 点击确定
      const confirmBtn = await page.$('.el-picker-panel__footer .el-button--primary')
        || await page.$('.el-picker-panel__footer .el-button--default');
      if (confirmBtn) {
        await confirmBtn.click();
        console.log('    ✓ 点击确定');
      } else {
        console.log('    ⚠ 未找到确定按钮');
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(500);
    }

    // 5b. 选择派件员（先不筛选，搜索全部记录）
    console.log('  5b. 派件员 — 不筛选，搜索全部记录以获取更多结果...');
    if (courierSelectInput) {
      await courierSelectInput.click();
      await page.waitForTimeout(800);

      // 查看下拉选项
      const dropdownOptions = await page.$$('div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item');
      console.log(`    下拉选项数量: ${dropdownOptions.length}`);
      for (const opt of dropdownOptions) {
        const text = (await opt.textContent())?.trim();
        const visible = await opt.isVisible().catch(() => false);
        console.log(`    - "${text}" (visible=${visible})`);
      }

      // 不选择具体派件员，先保持"请选择"或选回"请选择"以获取全部记录
      const qingxuanze = await page.$('div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("请选择")');
      if (qingxuanze) {
        await qingxuanze.click();
        console.log('    ✓ 选择"请选择"(全部)');
      } else {
        await page.keyboard.press('Escape');
        console.log('    → 关闭下拉，不筛选派件员');
      }
      await page.waitForTimeout(500);
    }

    // 5c. 点击搜索
    console.log('  5c. 点击搜索...');
    if (searchButton) {
      await searchButton.click();
      console.log('    ✓ 已点击搜索');
      await page.waitForTimeout(3000);
      await dismissAllPopups(page);
    }

    // 5d. 检查搜索结果
    const totalCountEl = await page.$('.el-pagination .el-pagination__total');
    if (totalCountEl) {
      const totalText = await totalCountEl.textContent();
      console.log(`    总数: ${totalText}`);
    }
    const rowCount = await page.$$('.el-table__body-wrapper table tbody tr.el-table__row');
    console.log(`    表格行数: ${rowCount.length}`);

    // 5e. 设置分页为100条/页
    console.log('  5e. 设置分页...');
    const pageSizeInput = await page.$('.el-pagination .el-pagination__sizes .el-input input');
    if (pageSizeInput) {
      await pageSizeInput.click();
      await page.waitForTimeout(500);

      // 查看分页选项
      const sizeOptions = await page.$$('div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item');
      for (const opt of sizeOptions) {
        const text = (await opt.textContent())?.trim();
        console.log(`    分页选项: "${text}"`);
      }

      // 选择100条/页
      const size100 = await page.$('div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("100条/页")');
      if (size100) {
        await size100.click();
        console.log('    ✓ 已选择 100条/页');
      }
      await page.waitForTimeout(2000);
      await dismissAllPopups(page);
    }

    await page.screenshot({ path: 'scripts/screenshots/05-after-search.png', fullPage: false });

    // 5f. 全选
    console.log('  5f. 全选...');
    if (rowCount.length > 0) {
      // 方式1: JS evaluate 点击全选 checkbox
      const jsResult = await page.evaluate(() => {
        const input = document.querySelector('.el-table__header-wrapper input[type="checkbox"]') as HTMLInputElement | null;
        if (input) {
          input.click();
          return { method: 'JS click', checked: input.checked };
        }
        return { method: 'JS', error: 'input not found' };
      });
      console.log(`    全选结果: ${JSON.stringify(jsResult)}`);
      await page.waitForTimeout(500);

      // 验证选中状态
      const checkedCount = await page.evaluate(() => {
        const rows = document.querySelectorAll('.el-table__body-wrapper table tbody tr.el-table__row');
        let count = 0;
        rows.forEach(row => {
          const cb = row.querySelector('td:first-child input[type="checkbox"]') as HTMLInputElement | null;
          if (cb?.checked) count++;
        });
        return count;
      });
      console.log(`    已勾选行数: ${checkedCount} / ${rowCount.length}`);
    } else {
      console.log('    ⚠ 无搜索结果，跳过全选');
    }

    await page.screenshot({ path: 'scripts/screenshots/06-select-all.png', fullPage: false });

    // 5g. 点击批量签收 → 验证签收弹窗结构
    console.log('  5g. 点击批量签收...');
    if (batchSignButton && rowCount.length > 0) {
      await batchSignButton.click();
      console.log('    ✓ 已点击批量签收');
      await page.waitForTimeout(2000);

      // 验证弹窗结构
      const signDialog = await page.$('.el-dialog__wrapper .el-dialog:visible');
      console.log(`    签收弹窗 (.el-dialog__wrapper .el-dialog:visible): ${signDialog ? '✓ 存在' : '✗ 不存在'}`);

      if (signDialog) {
        // 获取弹窗内容
        const dialogText = await signDialog.textContent().catch(() => '');
        console.log(`    弹窗文本(前200): "${dialogText.slice(0, 200)}"`);

        // 检查签收人输入框
        const signerInput = await page.$('.el-dialog__wrapper .el-dialog .el-input input');
        console.log(`    签收人输入框: ${signerInput ? '✓ 存在' : '✗ 不存在'}`);

        // 点击签收人输入框
        if (signerInput) {
          await signerInput.click();
          await page.waitForTimeout(800);

          // 查看签收人选项
          const signerOptions = await page.$$('div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item');
          console.log(`    签收人选项数量: ${signerOptions.length}`);
          const signerNames: string[] = [];
          for (const opt of signerOptions.slice(0, 15)) {
            const text = (await opt.textContent())?.trim() || '';
            signerNames.push(text);
          }
          console.log(`    签收人选项: [${signerNames.join(', ')}]`);

          // 选择"本人"
          const benren = await page.$('div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("本人")');
          if (benren) {
            await benren.click();
            console.log('    ✓ 已选择"本人"');
          } else {
            console.warn('    ⚠ 未找到"本人"选项');
          }
          await page.waitForTimeout(500);
        }

        // 检查确认/取消按钮
        const dialogConfirmBtn = await page.$('.el-dialog__wrapper .el-dialog .el-button--primary');
        console.log(`    确定按钮 (.el-button--primary): ${dialogConfirmBtn ? '✓' : '✗'}`);

        const dialogCancelBtns = await page.$$('.el-dialog__wrapper .el-dialog .el-button--default');
        console.log(`    取消按钮数量: ${dialogCancelBtns.length}`);

        // 获取弹窗 HTML 结构
        const dialogHTML = await signDialog.evaluate(el => el.innerHTML.slice(0, 800));
        console.log(`    弹窗HTML(前800): ${dialogHTML}`);

        await page.screenshot({ path: 'scripts/screenshots/07-sign-dialog.png', fullPage: false });

        // 不点击确定（DRY RUN模式，不真实签收）
        // 点取消关闭弹窗
        if (dialogCancelBtns.length > 0) {
          await dialogCancelBtns[0].click();
          console.log('    ✓ 已点击取消，关闭弹窗');
        } else {
          await page.keyboard.press('Escape');
          console.log('    ✓ 已按 Escape 关闭弹窗');
        }
      } else {
        // 弹窗可能以不同结构出现
        console.log('    检查其他弹窗形式...');
        const msgBox = await page.$('.el-message-box');
        console.log(`    .el-message-box: ${msgBox ? '✓ 存在' : '✗ 不存在'}`);
        if (msgBox) {
          const msgBoxText = await msgBox.textContent().catch(() => '');
          console.log(`    内容: "${msgBoxText.slice(0, 200)}"`);
        }
        await page.screenshot({ path: 'scripts/screenshots/07-no-dialog.png', fullPage: false });
      }
    } else {
      console.log('    ⚠ 无搜索结果或无批量签收按钮，跳过签收弹窗验证');
    }

    // ── Step 6: 总结 ──
    console.log('\n=== 验证完成 ===');
    console.log('截图已保存到 scripts/screenshots/ 目录');
    console.log('请根据以上日志确认选择器是否需要调整。');

  } catch (err) {
    console.error('\n❌ 验证过程出错:', (err as Error).message);
    await page.screenshot({ path: 'scripts/screenshots/error.png', fullPage: true });
  } finally {
    // 保持浏览器打开 10 秒供手动检查
    console.log('\n浏览器将在10秒后关闭...');
    await sleep(10000);
    await browser.close();
  }
}

// ── 辅助函数 ──

async function dismissAllPopups(page: any) {
  try {
    // 1. 关闭 el-message / el-notification toasts
    await page.waitForSelector('.el-message, .el-notification', { state: 'hidden', timeout: 2000 }).catch(() => {});
    
    // 2. 关闭 el-dialog (点取消/关闭按钮)
    const dialogWrappers = await page.$$('.el-dialog__wrapper:not([style*="display: none"])').catch(() => []);
    for (const wrapper of dialogWrappers) {
      const visible = await wrapper.isVisible().catch(() => false);
      if (!visible) continue;
      // 按取消按钮
      const cancelBtn = await wrapper.$('button:has-text("取消"), button:has-text("关闭"), .el-button--default').catch(() => null);
      if (cancelBtn) {
        await cancelBtn.click().catch(() => {});
        console.log('  [dismiss] 关闭了一个弹窗');
        await sleep(500);
        continue;
      }
      // 按 X 按钮
      const closeBtn = await wrapper.$('.el-dialog__headerbtn').catch(() => null);
      if (closeBtn) {
        await closeBtn.click().catch(() => {});
        console.log('  [dismiss] 通过X按钮关闭了一个弹窗');
        await sleep(500);
      }
    }

    // 3. 关闭 el-message-box
    const msgBoxes = await page.$$('.el-message-box:not([style*="display: none"])').catch(() => []);
    for (const box of msgBoxes) {
      const visible = await box.isVisible().catch(() => false);
      if (!visible) continue;
      const cancelBtn = await box.$('button:has-text("取消"), button:has-text("关闭"), .el-button--default').catch(() => null);
      if (cancelBtn) {
        await cancelBtn.click().catch(() => {});
        console.log('  [dismiss] 关闭了一个 message-box');
        await sleep(500);
      }
    }

    // 4. Escape + overlay
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  } catch (e) {
    // 忽略
  }
}

async function ensureSidebarExpanded(page: any) {
  const isExpanded = await page.evaluate(() => {
    const app = document.querySelector('.app-wrapper');
    return app?.classList.contains('openSidebar') ?? false;
  }).catch(() => false);

  if (isExpanded) {
    console.log('  ✓ 侧边栏已展开');
    return;
  }

  console.log('  侧边栏收起，尝试展开...');
  const hamburger = await page.$('.hamburger-container, .hamburger, #hamburger-container').catch(() => null);
  if (hamburger) {
    await hamburger.click();
    await page.waitForTimeout(2000);
    const nowExpanded = await page.evaluate(() => {
      const app = document.querySelector('.app-wrapper');
      return app?.classList.contains('openSidebar') ?? false;
    }).catch(() => false);
    console.log(`  展开后状态: ${nowExpanded ? '已展开' : '仍收起'}`);
  }
}

main();
