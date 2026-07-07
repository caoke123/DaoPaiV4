-- ============================================================================
-- DaoPai V3 Migration 002: 默认工作站落地
-- Phase 2-D: workstation_id 最小注入与默认本机工作站
-- ============================================================================
-- 目标:
--   1. 创建默认本机工作站 ws-local-default
--   2. 给 tasks.workstation_id / task_logs.workstation_id 建索引
--   3. 幂等执行（可重复运行不报错）
-- ============================================================================

-- ══ 1. 确保 tenant-default 存在 ══
INSERT INTO tenants (id, name, max_workstations, status)
VALUES ('tenant-default', 'DaoPai V3 默认租户', 3, 'active')
ON CONFLICT (id) DO NOTHING;

-- ══ 2. 创建默认工作站 ══
INSERT INTO workstations (
    id, tenant_id, site_id, name, status, online_status, browser_status
)
VALUES (
    'ws-local-default',
    'tenant-default',
    NULL,
    '本机默认工作站',
    'active',
    'online',
    'unknown'
)
ON CONFLICT (id) DO UPDATE SET
    name          = EXCLUDED.name,
    status        = EXCLUDED.status,
    online_status = EXCLUDED.online_status,
    updated_at    = NOW();

-- ══ 3. 给 tasks.workstation_id 建索引 ══
CREATE INDEX IF NOT EXISTS idx_tasks_workstation ON tasks(workstation_id);

-- ══ 4. 给 task_logs.workstation_id 建索引 ══
CREATE INDEX IF NOT EXISTS idx_task_logs_workstation ON task_logs(workstation_id);

-- ══ 5. 回填现有任务的 workstation_id（可选，逐步迁移） ══
-- 当前所有任务由本机默认工作站执行，统一设为 ws-local-default
UPDATE tasks
SET workstation_id = 'ws-local-default'
WHERE workstation_id IS NULL
  AND tenant_id = 'tenant-default';

UPDATE task_logs
SET workstation_id = 'ws-local-default'
WHERE workstation_id IS NULL
  AND tenant_id = 'tenant-default';