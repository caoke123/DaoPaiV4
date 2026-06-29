/**
 * PG-03 PostgreSQL 连接自检脚本
 *
 * 用途：快速验证 PostgreSQL 连接是否正常
 * 运行：npx tsx scripts/check-pg.ts
 *
 * 返回码：0 = 成功，1 = 失败
 */

import { Client } from 'pg';

async function main() {
  const host = process.env.PG_HOST || '127.0.0.1';
  const port = parseInt(process.env.PG_PORT || '5435', 10);
  const user = process.env.PG_USER || 'daopai';
  const password = process.env.PG_PASSWORD || 'daopai_secret';
  const database = process.env.PG_DATABASE || 'daopai_next';

  console.log('═══════════════════════════════════════════');
  console.log('  PG-03 PostgreSQL 连接自检');
  console.log('═══════════════════════════════════════════');
  console.log(`  host    : ${host}`);
  console.log(`  port    : ${port}`);
  console.log(`  user    : ${user}`);
  console.log(`  database: ${database}`);
  console.log(`  password: *** (${password.length} chars)`);
  console.log('───────────────────────────────────────────');

  const client = new Client({
    host,
    port,
    user,
    password,
    database,
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
    console.log('  TCP 连接... OK');

    const ver = await client.query('SELECT version()');
    console.log(`  ✅ PostgreSQL connected`);
    console.log(`  📋 ${(ver.rows[0] as any).version}`);

    const now = await client.query('SELECT now()');
    console.log(`  📋 服务器时间: ${(now.rows[0] as any).now}`);

    // 统计核心表
    const tables = [
      { name: 'tasks', query: 'SELECT COUNT(*)::int AS cnt FROM tasks' },
      { name: 'waybill_results', query: 'SELECT COUNT(*)::int AS cnt FROM waybill_results' },
      { name: 'task_logs', query: 'SELECT COUNT(*)::int AS cnt FROM task_logs' },
      { name: 'windows', query: 'SELECT COUNT(*)::int AS cnt FROM windows' },
      { name: 'sites', query: 'SELECT COUNT(*)::int AS cnt FROM sites' },
    ];

    console.log('  ── 核心表统计 ──');
    for (const t of tables) {
      try {
        const r = await client.query(t.query);
        console.log(`  ${t.name}: ${(r.rows[0] as any).cnt} 行`);
      } catch (_) {
        console.log(`  ${t.name}: 表不存在或查询失败`);
      }
    }

    console.log('═══════════════════════════════════════════');
    console.log('  ✅ 全部自检通过');
    console.log('═══════════════════════════════════════════');
    process.exit(0);
  } catch (e: any) {
    console.log(`  ❌ PostgreSQL connection failed`);
    console.log(`  📋 ${e.message}`);
    if (e.stack) {
      console.log(`  📋 完整堆栈:\n${e.stack.split('\n').map((l: string) => '    ' + l).join('\n')}`);
    }
    console.log('═══════════════════════════════════════════');
    console.log('  ❌ 自检失败');
    console.log('═══════════════════════════════════════════');
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
