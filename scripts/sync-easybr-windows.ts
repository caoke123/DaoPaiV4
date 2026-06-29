// 同步 EasyBR 窗口配置到数据库
// 从 EasyBR API 拉取最新 browerid + browername，更新 data/db.json
import * as fs from 'fs';
import * as path from 'path';

const EASYBR_API = 'http://127.0.0.1:3001';
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

interface EasyBRBrowser {
  browerid: string;
  browername: string;
  groupname: string;
}

interface WindowRecord {
  id: string;
  name: string;
  cdp_port: number;
  role: 'admin' | 'staff';
  site: string;
  staff_name: string | null;
  is_connected: number;
  updated_at: string;
}

async function main() {
  console.log('=== 同步 EasyBR 窗口配置到数据库 ===\n');

  // 1. 从 EasyBR API 拉取最新浏览器列表
  console.log('[1] 拉取 EasyBR 浏览器列表...');
  const resp = await fetch(`${EASYBR_API}/auto/getBrowerList`);
  const json: any = await resp.json();
  if (json.code !== 0) {
    throw new Error(`EasyBR API 返回错误: ${json.msg}`);
  }
  const browsers: EasyBRBrowser[] = json.data;
  console.log(`    找到 ${browsers.length} 个浏览器配置:`);
  for (const b of browsers) {
    console.log(`    - ${b.browername} (id=${b.browerid}, group=${b.groupname})`);
  }

  // 2. 读取当前数据库
  console.log('\n[2] 读取当前数据库...');
  const dbRaw = fs.readFileSync(DB_PATH, 'utf-8');
  const db: { windows: WindowRecord[]; tasks: any[] } = JSON.parse(dbRaw);
  console.log(`    数据库中有 ${db.windows.length} 个窗口记录:`);
  for (const w of db.windows) {
    console.log(`    - ${w.name} (id=${w.id}, role=${w.role}, staff=${w.staff_name})`);
  }

  // 3. 构建 name → 新 id 映射
  const nameToNewId = new Map<string, string>();
  for (const b of browsers) {
    nameToNewId.set(b.browername, b.browerid);
  }

  // 4. 更新数据库中的窗口 ID
  console.log('\n[3] 更新窗口 ID...');
  let updated = 0;
  for (const w of db.windows) {
    const newId = nameToNewId.get(w.name);
    if (newId && newId !== w.id) {
      console.log(`    ${w.name}: ${w.id} → ${newId}`);
      w.id = newId;
      w.is_connected = 0;  // 重置连接状态
      w.updated_at = new Date().toISOString();
      updated++;
    } else if (newId && newId === w.id) {
      console.log(`    ${w.name}: ID 已是最新 (${w.id})`);
    } else {
      console.log(`    ⚠ ${w.name}: 在 EasyBR 中未找到对应配置!`);
    }
  }

  // 5. 检查是否有 EasyBR 中新增的窗口（数据库中没有的）
  const dbNames = new Set(db.windows.map(w => w.name));
  for (const b of browsers) {
    if (!dbNames.has(b.browername)) {
      console.log(`    + 新窗口: ${b.browername} (id=${b.browerid})，添加到数据库`);
      const role = b.browername.includes('管理员') ? 'admin' : 'staff';
      const staffName = role === 'admin' ? null : b.browername.split('-')[1] || null;
      db.windows.push({
        id: b.browerid,
        name: b.browername,
        cdp_port: 0,
        role: role as 'admin' | 'staff',
        site: 'tiannanda',
        staff_name: staffName,
        is_connected: 0,
        updated_at: new Date().toISOString(),
      });
      updated++;
    }
  }

  // 6. 写回数据库
  console.log(`\n[4] 写回数据库 (更新了 ${updated} 条记录)...`);
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
  console.log('    完成!');

  // 7. 验证
  console.log('\n[5] 验证更新结果:');
  const dbRaw2 = fs.readFileSync(DB_PATH, 'utf-8');
  const db2 = JSON.parse(dbRaw2);
  for (const w of db2.windows) {
    const easybrMatch = browsers.find(b => b.browerid === w.id);
    const matchStatus = easybrMatch ? '✓ 匹配' : '✗ 不匹配';
    console.log(`    ${w.name}: id=${w.id} [${matchStatus}]`);
  }

  console.log('\n=== 同步完成 ===');
}

main().catch(err => {
  console.error('同步失败:', err);
  process.exit(1);
});
