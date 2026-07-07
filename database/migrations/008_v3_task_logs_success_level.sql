-- ============================================================================
-- DaoPai V3 Migration 008: task_logs.level 增加 'success' 级别
-- Phase 5-E: Agent 上报任务完成日志使用 level='success'，
--            但 task_logs_level_check 只允许 ('info', 'warning', 'error')，
--            导致 /agent/tasks/:id/logs 返回 500。
-- ============================================================================
-- 目标:
--   1. task_logs.level CHECK 增加 'success'
--   2. 幂等执行（可重复运行不报错）
-- ============================================================================

-- ══ task_logs.level 增加 'success'（幂等） ══
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name LIKE '%task_logs_level_check%'
          AND check_clause LIKE '%success%'
    ) THEN
        ALTER TABLE task_logs DROP CONSTRAINT IF EXISTS task_logs_level_check;
        ALTER TABLE task_logs ADD CONSTRAINT task_logs_level_check
            CHECK (level IN ('info', 'success', 'warning', 'error'));
    END IF;
END $$;
