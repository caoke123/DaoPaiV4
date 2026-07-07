-- ============================================================================
-- DaoPai V3 Migration 007: tasks 表增加 updated_at 字段
-- Phase 5-E: 修复 pullPendingTask / updateTaskProgress / completeAgentTask /
--            failAgentTask 引用 updated_at 列但 schema 未定义导致的 500 错误
-- ============================================================================
-- 背景:
--   init-schema.sql 中 tasks 表只有 created_at / finished_at，
--   但 PgDatabase.ts 的 Agent 任务管道方法（pullPendingTask、updateTaskProgress、
--   completeAgentTask、failAgentTask）在 UPDATE 时引用了 updated_at = NOW()，
--   导致 /agent/tasks/pull 返回 500。
--
-- 目标:
--   1. 给 tasks 表增加 updated_at TIMESTAMPTZ 字段
--   2. 幂等执行（可重复运行不报错）
-- ============================================================================

-- ══ 1. 新增 updated_at 字段（幂等） ══
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- ══ 2. 回填存量数据：updated_at 默认等于 created_at ══
UPDATE tasks SET updated_at = created_at WHERE updated_at IS NULL;

-- ══ 3. 后续 UPDATE 时由应用层维护 updated_at = NOW() ══
COMMENT ON COLUMN tasks.updated_at IS '任务最后更新时间（应用层维护）';
