-- ============================================================================
-- DaoPai V3 Migration 005: Agent 任务管道字段
-- Phase 4-F: 任务拉取与结果回传最小闭环
-- ============================================================================
-- 目标:
--   1. tasks.status 增加 'assigned' 状态
--   2. tasks.type 增加 'agent_test' 类型
--   3. 给 tasks 增加 assigned_at / progress 字段
--   4. 幂等执行（可重复运行不报错）
-- ============================================================================

-- ══ 1. tasks.status 增加 'assigned'（幂等） ══
-- PostgreSQL 不支持直接修改 CHECK，需 DROP + ADD
DO $$
BEGIN
    -- 检查当前 CHECK 约束中是否已包含 'assigned'
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name LIKE '%tasks_status_check%'
          AND check_clause LIKE '%assigned%'
    ) THEN
        ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
        ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
            CHECK (status IN ('pending', 'assigned', 'running', 'done', 'failed', 'cancelled'));
    END IF;
END $$;

-- ══ 2. tasks.type 增加 'agent_test'（幂等） ══
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name LIKE '%tasks_type_check%'
          AND check_clause LIKE '%agent_test%'
    ) THEN
        ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;
        ALTER TABLE tasks ADD CONSTRAINT tasks_type_check
            CHECK (type IN ('arrive', 'dispatch', 'sign', 'integrated', 'init_window', 'agent_test'));
    END IF;
END $$;

-- ══ 3. 新增 assigned_at 字段 ══
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN tasks.assigned_at IS '任务被 Agent 拉取的时间';

-- ══ 4. 新增 progress 字段 ══
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN tasks.progress IS '任务执行进度（0-100）';

-- ══ 5. 新增索引 ══
CREATE INDEX IF NOT EXISTS idx_tasks_workstation_status ON tasks(workstation_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks(tenant_id, status);