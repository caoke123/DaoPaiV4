/**
 * 开发环境执行电脑授权码生成脚本
 *
 * 用于在 Cloud 管理后台尚未完成执行电脑管理 UI 时，
 * 为默认工作站生成授权码，供本地执行端开发和测试使用。
 *
 * 使用方式：
 *   npx tsx backend/scripts/createAgentDevToken.ts
 *
 * 说明：
 *   - 为默认工作站 ws-local-default 生成授权码
 *   - 数据库保存 SHA-256 hash
 *   - 控制台只打印一次明文授权码
 *   - 请复制到 packages/agent/agent.json 的 agentToken 字段
 */

import { PgDatabase } from '../db/PgDatabase';
import { generateAgentToken, hashAgentToken } from '../auth/agentToken';

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  DaoPai V3 开发环境执行电脑授权码生成');
  console.log('========================================\n');

  const pg = PgDatabase.getInstance();

  // 检查数据库连接
  try {
    await pg.init();
  } catch (e) {
    console.error('错误：无法连接 PostgreSQL 数据库');
    console.error('请确认 PostgreSQL 已启动，且 .env 配置正确');
    console.error((e as Error).message);
    process.exit(1);
  }

  // 查询默认工作站
  const ws = await pg.getWorkstationById('tenant-default', 'ws-local-default');
  if (!ws) {
    console.error('错误：默认工作站 ws-local-default 不存在');
    console.error('请先执行 migration 002');
    process.exit(1);
  }

  // 生成新授权码
  const plainToken = generateAgentToken();
  const tokenHash = hashAgentToken(plainToken);

  // 保存到数据库
  await pg.getPool().query(
    `UPDATE workstations
     SET agent_token_hash        = $1,
         agent_token_created_at  = NOW(),
         agent_token_revoked_at  = NULL,
         agent_token_last_used_at = NULL,
         updated_at              = NOW()
     WHERE id = $2`,
    [tokenHash, ws.id]
  );

  console.log('执行电脑授权码已生成！\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  执行电脑名称：${ws.name}`);
  console.log(`  执行电脑编号：${ws.id}`);
  console.log(`  授权码（仅显示一次）：${plainToken}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('请将以上授权码复制到 packages/agent/agent.json 的 agentToken 字段：');
  console.log('');
  console.log('  {');
  console.log(`    "agentToken": "${plainToken}",`);
  console.log('    ...');
  console.log('  }');
  console.log('');
  console.log('⚠ 授权码仅显示一次，请妥善保存！');
  console.log('⚠ 下次执行此脚本将生成新授权码，旧授权码自动失效。');
  console.log('');

  process.exit(0);
}

main().catch((e) => {
  console.error('生成授权码失败:', e.message);
  process.exit(1);
});