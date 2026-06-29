// 详细检查签收页面下拉框 DOM
import { chromium } from 'playwright';

const CDP_WS = 'ws://127.0.0.1:15397/devtools/browser/f612762c-d52d-480e-bb67-e41c338ed1d9';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_WS);
  const pages = browser.contexts()[0].pages();
  const bnsyPage = pages.find(p => p.url().includes('bnsy.benniaosuyun.com'))!;
  console.log(`当前页面: ${bnsyPage.url()}`);

  // 先关闭可能已打开的下拉框
  await bnsyPage.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 500));

  // 点击 courier select 打开下拉
  console.log('\n=== 点击 courier select 打开下拉 ===');
  const courierInput = bnsyPage.locator('.search-wrap .inputs .el-select input').first();
  await courierInput.click();
  await new Promise(r => setTimeout(r, 1000));

  // 检查下拉框的完整信息
  const dropdownInfo = await bnsyPage.evaluate(() => {
    const dropdowns = document.querySelectorAll('.el-select-dropdown');
    const results: any[] = [];
    for (const dd of dropdowns) {
      const style = window.getComputedStyle(dd);
      if (style.display === 'none') continue;
      
      const items = dd.querySelectorAll('.el-select-dropdown__item');
      results.push({
        tag: dd.tagName,
        className: dd.className,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        zIndex: style.zIndex,
        popperClass: dd.classList.contains('el-popper'),
        itemCount: items.length,
        items: Array.from(items).map(item => ({
          tag: item.tagName,
          className: item.className,
          text: item.textContent?.trim(),
          innerHTML: item.innerHTML.slice(0, 200),
          rect: item.getBoundingClientRect(),
        })),
      });
    }
    return results;
  });
  console.log(JSON.stringify(dropdownInfo, null, 2));

  // Playwright 方式检查
  console.log('\n=== Playwright locator 检查 ===');
  const pwDropdown = bnsyPage.locator('.el-select-dropdown:not([style*="display: none"])');
  const pwCount = await pwDropdown.count();
  console.log(`.el-select-dropdown 可见数量: ${pwCount}`);
  
  const pwItems = bnsyPage.locator('div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item');
  const pwItemCount = await pwItems.count();
  console.log(`div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item 数量: ${pwItemCount}`);
  
  for (let i = 0; i < pwItemCount; i++) {
    const text = await pwItems.nth(i).textContent().catch(() => '');
    console.log(`  [${i}] "${text?.trim()}"`);
  }

  // :has-text 检查
  console.log('\n=== :has-text("刘磊") 检查 ===');
  const liulei = bnsyPage.locator('div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("刘磊")');
  const liuleiCount = await liulei.count();
  console.log(`匹配数量: ${liuleiCount}`);
  if (liuleiCount > 0) {
    const text = await liulei.first().textContent().catch(() => '');
    console.log(`文本: "${text?.trim()}"`);
  }

  await browser.close();
}
main();
