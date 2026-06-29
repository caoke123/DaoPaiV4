/**
 * PG-01 独立连接测试脚本
 * 
 * 用途：验证 PostgreSQL 连接，不依赖项目任何模块
 * 运行：npx tsx scripts/test-pg.ts
 */

import { Pool, Client } from 'pg';

const CONFIGS = [
  {
    label: 'loadConfig() 默认配置（daopai_next）',
    config: {
      host: process.env.PG_HOST || '127.0.0.1',
      port: parseInt(process.env.PG_PORT || '5435', 10),
      user: process.env.PG_USER || 'daopai',
      password: process.env.PG_PASSWORD || 'daopai_secret',
      database: process.env.PG_DATABASE || 'daopai_next',
    },
  },
  {
    label: 'postgres 超管（daopai_secret）',
    config: {
      host: '127.0.0.1',
      port: 5435,
      user: 'postgres',
      password: 'daopai_secret',
      database: 'postgres',
    },
  },
  {
    label: 'postgres 超管（postgres）',
    config: {
      host: '127.0.0.1',
      port: 5435,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
    },
  },
  {
    label: 'daopai / daopai_next（空密码）',
    config: {
      host: '127.0.0.1',
      port: 5435,
      user: 'daopai',
      password: '',
      database: 'daopai_next',
    },
  },
];

async function testConfig(label: string, cfg: Record<string, any>) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`测试: ${label}`);
  console.log(`连接: postgresql://${cfg.user}:***@${cfg.host}:${cfg.port}/${cfg.database}`);
  
  const client = new Client({
    ...cfg,
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
    console.log('  ✅ TCP 连接成功');
    
    const res = await client.query('SELECT version()');
    console.log(`  ✅ 认证成功`);
    console.log(`  📋 版本: ${(res.rows[0] as any).version}`);
    
    // 检查数据库列表
    const dbs = await client.query(
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
    );
    console.log(`  📋 数据库: ${dbs.rows.map((r: any) => r.datname).join(', ')}`);
    
    // 检查用户列表
    const users = await client.query(
      `SELECT usename FROM pg_user ORDER BY usename`
    );
    console.log(`  📋 用户: ${users.rows.map((r: any) => r.usename).join(', ')}`);
    
    return true;
  } catch (e: any) {
    console.log(`  ❌ 失败: ${e.message}`);
    // 输出完整堆栈
    if (e.stack) {
      console.log(`  📋 堆栈:\n${e.stack.split('\n').map(l => '    ' + l).join('\n')}`);
    }
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  PG-01 PostgreSQL 连接诊断');
  console.log(`  时间: ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════════════');

  let success = false;
  for (const c of CONFIGS) {
    const ok = await testConfig(c.label, c.config);
    if (ok) success = true;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`结论: ${success ? '至少一种凭据组合可用 ✅' : '所有凭据组合均失败 ❌'}`);
  console.log(`${'='.repeat(60)}\n`);
  
  process.exit(success ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
