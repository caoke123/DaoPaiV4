// 诊断脚本：扫描所有 LISTENING 端口，列出每个 CDP 端口下的所有标签页
// 用于排查"天南大-孟德海"窗口未找到 CDP 的问题
import axios from 'axios';
import { execSync } from 'child_process';

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  CDP 端口全面诊断');
  console.log('═══════════════════════════════════════════\n');

  // 1. 获取所有 LISTENING 端口（不限制范围）
  const output = execSync('netstat -ano -p tcp', {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  const listenPorts = new Set<number>();
  for (const line of output.split('\n')) {
    if (line.includes('LISTENING')) {
      const match = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)\s/);
      if (match) {
        const ip = match[1];
        const port = parseInt(match[2], 10);
        // 排除 EasyBR 自身端口 3001 和常见系统端口
        if ((ip === '127.0.0.1' || ip === '0.0.0.0') && port !== 3001) {
          listenPorts.add(port);
        }
      }
    }
  }

  const ports = Array.from(listenPorts).sort((a, b) => a - b);
  console.log(`[诊断] 所有 LISTENING 端口 ${ports.length} 个:`);
  console.log(ports.join(', '));
  console.log('');

  // 2. 逐一探测 CDP（不限制端口范围）
  console.log('[诊断] 开始探测 CDP 端口...\n');
  const cdpEndpoints: { port: number; version: any; tabs: any[] }[] = [];

  const batchSize = 20;
  for (let i = 0; i < ports.length; i += batchSize) {
    const batch = ports.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (port) => {
      try {
        const resp = await axios.get(`http://127.0.0.1:${port}/json/version`, {
          timeout: 1000,
          validateStatus: () => true,
        });
        if (resp.status === 200 && resp.data && (resp.data.webSocketDebuggerUrl || resp.data.Browser)) {
          // 获取标签页列表
          let tabs: any[] = [];
          try {
            const tabsResp = await axios.get(`http://127.0.0.1:${port}/json/list`, { timeout: 1000 });
            if (Array.isArray(tabsResp.data)) {
              tabs = tabsResp.data.filter((t: any) => t.type === 'page');
            }
          } catch {}
          return { port, version: resp.data, tabs };
        }
      } catch {}
      return null;
    }));

    for (const r of results) {
      if (r) cdpEndpoints.push(r);
    }
  }

  console.log(`[诊断] 共发现 ${cdpEndpoints.length} 个 CDP 端口\n`);

  // 3. 详细列出每个 CDP 端口的标签页
  for (const ep of cdpEndpoints) {
    console.log(`┌─ CDP 端口 ${ep.port} ─────────────────────────`);
    console.log(`│ Browser: ${ep.version.Browser}`);
    console.log(`│ 标签页数: ${ep.tabs.length}`);
    for (const tab of ep.tabs) {
      console.log(`│   • [${tab.type}] ${tab.title}`);
      console.log(`│     URL: ${tab.url}`);
    }
    console.log(`└──────────────────────────────────────────\n`);
  }

  // 4. 获取 EasyBR 窗口列表
  console.log('[诊断] EasyBR 已开启窗口列表:');
  try {
    const resp = await axios.get('http://127.0.0.1:3001/auto/openedList', { timeout: 5000 });
    if (resp.data && resp.data.code === 0 && Array.isArray(resp.data.data)) {
      for (const w of resp.data.data) {
        console.log(`  • browerid: ${w.browerid}`);
        console.log(`    browername: ${w.browername}`);
        console.log(`    isopen: ${w.isopen}`);
        // 检查是否有匹配的 CDP 端口
        const matched = cdpEndpoints.find(ep =>
          ep.tabs.some(tab => tab.url.includes(w.browerid) || tab.title === w.browername)
        );
        if (matched) {
          console.log(`    → 匹配 CDP 端口: ${matched.port}`);
        } else {
          console.log(`    → ❌ 未找到匹配的 CDP 端口`);
        }
        console.log('');
      }
    }
  } catch (e) {
    console.log(`  获取 EasyBR 窗口列表失败: ${(e as Error).message}`);
  }

  // 5. 检查是否有 bnsy.benniaosuyun.com 标签页
  console.log('[诊断] 含 bnsy.benniaosuyun.com 标签页的 CDP 端口:');
  for (const ep of cdpEndpoints) {
    const bnsyTabs = ep.tabs.filter(t => t.url.includes('bnsy.benniaosuyun.com'));
    if (bnsyTabs.length > 0) {
      console.log(`  • 端口 ${ep.port}: ${bnsyTabs.length} 个标签页`);
      for (const t of bnsyTabs) {
        console.log(`    - ${t.title} | ${t.url}`);
      }
    }
  }
}

main().catch(console.error);
