/**
 * Migration Runner — 最小迁移执行器
 *
 * 设计目标：
 *   1. 维护 schema_migrations 表，记录已应用的 migration
 *   2. 扫描 database/migrations/*.sql，按文件名排序后逐个执行
 *   3. 每个 migration 在独立事务中执行，失败则 ROLLBACK 并中止
 *   4. 已应用的 migration 不会重复执行
 *
 * 启动时调用：
 *   import { runMigrations } from './db/migrations';
 *   await runMigrations(pgDatabase.getPool());
 *
 * 不破坏 init-schema.sql 幂等启动：
 *   - init-schema.sql 仍负责 CREATE TABLE IF NOT EXISTS（建表）
 *   - migration 负责结构演进（加列、加约束、回填数据）
 *   - 两者最终状态一致，先执行谁都不影响
 */

import path from 'path';
import fs from 'fs';
import type { Pool } from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * 解析 migrations 目录路径
 *
 * 兼容两种运行场景：
 *   - tsx dev: process.cwd() = 项目根
 *   - node dist: process.cwd() = 项目根（由 package.json start 脚本保证）
 */
function resolveMigrationsDir(): string {
  const candidates = [
    path.join(process.cwd(), 'database', 'migrations'),
    path.join(process.cwd(), '..', 'database', 'migrations'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

/**
 * 执行所有未应用的 migration
 *
 * @param pool  PgDatabase 的连接池
 * @returns { applied: 已应用文件名列表, skipped: 已跳过文件名列表 }
 */
export async function runMigrations(pool: Pool): Promise<MigrationResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

  // 1. 确保 schema_migrations 表存在（幂等）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum   TEXT
    )
  `);

  // 2. 读取 migrations 目录
  const migrationsDir = resolveMigrationsDir();
  if (!fs.existsSync(migrationsDir)) {
    console.log('[Migrations] migrations 目录不存在，跳过:', migrationsDir);
    return { applied, skipped };
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[Migrations] 无 migration 文件');
    return { applied, skipped };
  }

  console.log(`[Migrations] 发现 ${files.length} 个 migration 文件`);

  // 3. 逐个执行未应用的 migration
  const client = await pool.connect();
  try {
    for (const filename of files) {
      // 检查是否已应用
      const checkResult = await client.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations WHERE filename = $1',
        [filename]
      );
      if (checkResult.rows.length > 0) {
        skipped.push(filename);
        continue;
      }

      const filepath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(filepath, 'utf8');
      console.log(`[Migrations] 应用 ${filename} ...`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [filename]
        );
        await client.query('COMMIT');
        applied.push(filename);
        console.log(`[Migrations] ✓ ${filename} 已应用`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[Migrations] ✗ ${filename} 失败:`, (err as Error).message);
        throw err;
      }
    }
  } finally {
    client.release();
  }

  if (applied.length > 0) {
    console.log(`[Migrations] 本次应用 ${applied.length} 个，跳过 ${skipped.length} 个`);
  } else {
    console.log(`[Migrations] 全部 ${skipped.length} 个 migration 已是最新`);
  }

  return { applied, skipped };
}
