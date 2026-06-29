/**
 * PG-05: JSON → PostgreSQL 历史数据迁移脚本
 *
 * 用途：将 data/db.json 中的历史任务及运单结果迁移到 Docker PostgreSQL
 * 运行：npx tsx scripts/migrate-json-to-pg.ts
 *
 * 特性：
 *   - idempotent（ON CONFLICT DO NOTHING，重复执行安全）
 *   - 批量事务（每 100 条提交一次）
 *   - 输出迁移前后统计 + 一致性校验
 */

import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';

// ── 配置 ──────────────────────────────────────────────

const DB_JSON_PATH = path.join(process.cwd(), 'data', 'db.json');

const PG_CONFIG = {
  host: process.env.PG_HOST || '127.0.0.1',
  port: parseInt(process.env.PG_PORT || '5435', 10),
  user: process.env.PG_USER || 'daopai',
  password: process.env.PG_PASSWORD || 'daopai_secret',
  database: process.env.PG_DATABASE || 'daopai_next',
};

const BATCH_SIZE = 100;

// ── 类型 ──────────────────────────────────────────────

interface JsonTask {
  id: string;
  type: string;
  site: string;
  status: string;
  total_count: number;
  done_count: number;
  fail_count: number;
  input_data: string | null; // JSON string
  created_at: string;
  finished_at: string | null;
  result_data: string | null; // JSON string array
}

interface JsonWaybillResult {
  waybillNo: string;
  success: boolean;
  message: string;
  timestamp: number;
  status: string | null;
}

// ── 主流程 ────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  PG-05 JSON → PostgreSQL 数据迁移');
  console.log('═══════════════════════════════════════════');

  // 1. 读取数据源
  if (!fs.existsSync(DB_JSON_PATH)) {
    console.error(`✗ 数据源不存在: ${DB_JSON_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(DB_JSON_PATH, 'utf8');
  const dbJson = JSON.parse(raw);
  const jsonTasks: JsonTask[] = dbJson.tasks || [];

  console.log(`\n📋 读取 data/db.json: ${jsonTasks.length} 条任务`);

  // 2. 连接 PG
  const pool = new Pool({
    ...PG_CONFIG,
    connectionTimeoutMillis: 5000,
  });

  try {
    // 测试连接
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL 连接成功');
    console.log(`   连接: postgresql://${PG_CONFIG.user}:***@${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}`);

    // 3. 迁移前统计
    const pgBefore = await pool.query('SELECT COUNT(*)::int AS cnt FROM tasks');
    console.log(`\n📊 迁移前 PG.tasks 数量: ${pgBefore.rows[0].cnt}`);

    const wrBefore = await pool.query('SELECT COUNT(*)::int AS cnt FROM waybill_results');
    console.log(`📊 迁移前 PG.waybill_results 数量: ${wrBefore.rows[0].cnt}`);

    console.log('\n── 准备：补录缺失的 sites ──');
    const jsonSites = new Set(jsonTasks.map(t => t.site));
    for (const siteId of jsonSites) {
      await pool.query(
        `INSERT INTO sites (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [siteId, siteId] // 用 id 作为默认 name
      );
      console.log(`  sites: ${siteId} (幂等插入)`);
    }

    // 4. 迁移 tasks
    console.log('\n── 迁移 tasks ──');
    let taskInserted = 0;
    let taskSkipped = 0;

    for (let i = 0; i < jsonTasks.length; i += BATCH_SIZE) {
      const batch = jsonTasks.slice(i, i + BATCH_SIZE);
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        for (const t of batch) {
          // 解析 input_data（JSON string → JSONB object）
          let inputData: unknown = null;
          if (t.input_data) {
            try {
              inputData = JSON.parse(t.input_data);
            } catch {
              inputData = t.input_data; // 保留原始字符串
            }
          }

          const result = await client.query(
            `INSERT INTO tasks (id, type, site_id, status, total_count, done_count, fail_count, input_data, created_at, finished_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [
              t.id,
              t.type,
              t.site,
              t.status,
              t.total_count,
              t.done_count,
              t.fail_count,
              inputData ? JSON.stringify(inputData) : null,
              t.created_at,
              t.finished_at || null,
            ]
          );

          if (result.rows.length > 0) {
            taskInserted++;
          } else {
            taskSkipped++;
          }
        }

        await client.query('COMMIT');
        console.log(`  批量 ${Math.floor(i / BATCH_SIZE) + 1}: ${Math.min(i + BATCH_SIZE, jsonTasks.length)}/${jsonTasks.length} (新增 ${taskInserted}, 跳过 ${taskSkipped})`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    // 5. 迁移 waybill_results
    console.log('\n── 迁移 waybill_results ──');
    let wrInserted = 0;
    let wrSkippedTasks = 0;

    const tasksWithResults = jsonTasks.filter(t => t.result_data);

    for (const task of tasksWithResults) {
      let results: JsonWaybillResult[] = [];
      try {
        results = JSON.parse(task.result_data!);
      } catch {
        wrSkippedTasks++;
        continue;
      }

      if (results.length === 0) {
        wrSkippedTasks++;
        continue;
      }

      for (let j = 0; j < results.length; j += BATCH_SIZE) {
        const batch = results.slice(j, j + BATCH_SIZE);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const values: unknown[] = [];
          const rows: string[] = [];
          const colCount = 6; // task_id, batch_seq, waybill_no, success, message, timestamp, status
          // Actually we have 7 columns (including status) but need to build correctly

          for (let k = 0; k < batch.length; k++) {
            const r = batch[k];
            const base = k * 7 + 1; // 7 columns per row
            values.push(
              task.id,
              1, // batch_seq default
              r.waybillNo,
              r.success,
              r.message,
              r.timestamp,
              r.status || null,
            );
            rows.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
          }

          await client.query(
            `INSERT INTO waybill_results (task_id, batch_seq, waybill_no, success, message, timestamp, status)
             VALUES ${rows.join(', ')}
             ON CONFLICT DO NOTHING`,
            values
          );

          await client.query('COMMIT');
          wrInserted += batch.length;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }
    }

    console.log(`  运单结果: ${wrInserted} 条 (${tasksWithResults.length - wrSkippedTasks} 个任务)`);

    // 6. task_logs — db.json 无日志数据，记录为 0
    console.log('\n── 迁移 task_logs ──');
    console.log('  db.json 无日志数据，跳过（task_logs 仅存在于运行时内存）');

    // 7. 迁移后统计
    console.log('\n═══════════════════════════════════════════');
    console.log('  迁移统计');
    console.log('═══════════════════════════════════════════');

    const pgAfter = await pool.query('SELECT COUNT(*)::int AS cnt FROM tasks');
    const wrAfter = await pool.query('SELECT COUNT(*)::int AS cnt FROM waybill_results');
    const tlAfter = await pool.query('SELECT COUNT(*)::int AS cnt FROM task_logs');

    console.log(`\n  Database tasks  : ${jsonTasks.length}`);
    console.log(`  PG tasks        : ${pgAfter.rows[0].cnt}`);
    console.log(`  tasks 新增      : ${taskInserted}`);
    console.log(`  tasks 跳过(重复): ${taskSkipped}`);

    console.log(`\n  Database 运单   : ${tasksWithResults.reduce((sum, t) => { try { return sum + JSON.parse(t.result_data!).length; } catch { return sum; } }, 0)}`);
    console.log(`  PG 运单         : ${wrAfter.rows[0].cnt}`);
    console.log(`  PG task_logs    : ${tlAfter.rows[0].cnt}`);

    // 8. 一致性校验
    console.log('\n── 一致性校验 ──');

    const expectedTasks = jsonTasks.length;
    const actualTasks = pgAfter.rows[0].cnt;
    const tasksMatch = actualTasks >= expectedTasks;
    console.log(`  tasks:        期望 ≥ ${expectedTasks}, 实际 ${actualTasks} ${tasksMatch ? '✅' : '❌'}`);

    // 验证几个随机任务存在
    const sampleIds = jsonTasks.slice(0, 5).map(t => t.id);
    const sampleResult = await pool.query(
      'SELECT id, type, status FROM tasks WHERE id = ANY($1::uuid[])',
      [sampleIds]
    );
    console.log(`  抽样验证 (5个): 找到 ${sampleResult.rows.length}/5 ${sampleResult.rows.length === 5 ? '✅' : '❌'}`);

    if (tasksMatch && sampleResult.rows.length === 5) {
      console.log('\n═══════════════════════════════════════════');
      console.log('  ✅ 迁移完成，数据一致');
      console.log('═══════════════════════════════════════════');
    } else {
      console.log('\n═══════════════════════════════════════════');
      console.log('  ⚠️  迁移完成，存在不一致项');
      console.log('═══════════════════════════════════════════');
    }

    await pool.end();
    process.exit(0);
  } catch (e: any) {
    console.error('\n❌ 迁移失败:', e.message);
    if (e.stack) {
      console.error(e.stack.split('\n').slice(0, 5).join('\n'));
    }
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
