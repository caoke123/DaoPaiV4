-- ============================================================================
-- DaoPai V3 Migration 006: Agent Arrival 任务类型
-- Phase 5-B: Arrival 到件扫描 Agent DRY-RUN 闭环
-- ============================================================================
-- 目标:
--   1. tasks.type 增加 'arrival' 类型（Agent 到件扫描任务）
--   2. 不影响 agent_test 和旧 arrive 类型
--   3. 幂等执行（可重复运行不报错）
-- ============================================================================

-- ══ tasks.type 增加 'arrival'（幂等） ══
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name LIKE '%tasks_type_check%'
          AND check_clause LIKE '%arrival%'
    ) THEN
        ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;
        ALTER TABLE tasks ADD CONSTRAINT tasks_type_check
            CHECK (type IN ('arrive', 'dispatch', 'sign', 'integrated', 'init_window', 'agent_test', 'arrival'));
    END IF;
END $$;