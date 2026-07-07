-- ══════════════════════════════════════════════════════════════
-- Migration 001: V3 多租户数据库基础
--
-- 内容：
--   1. 新增 tenants / workstations / agent_heartbeats 基础表
--   2. 插入默认租户 tenant-default
--   3. 给所有业务表补 tenant_id（NOT NULL + FK + 索引）
--   4. 给 waybill_results / task_logs 补 site_id（通过 task_id 回填）
--   5. 给 tasks / task_logs 补 workstation_id（可空，Agent 未拆分）
--
-- 幂等说明：
--   - CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS 保证可重复执行
--   - FK 约束使用 DO 块检查 pg_constraint 避免重复创建报错
--   - 数据回填用 WHERE ... IS NULL 避免覆盖已有值
-- ══════════════════════════════════════════════════════════════
-- 注：事务由 migrations.ts runner 统一包裹（BEGIN/COMMIT），此处不再重复
-- ══════════════════════════════════════════════════════════════

-- ══ 1. tenants 表 ══
CREATE TABLE IF NOT EXISTS tenants (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'expired', 'deleted')),
    expires_at       TIMESTAMPTZ NULL,
    max_workstations INTEGER NOT NULL DEFAULT 3,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenants IS '租户表（多租户隔离基石）';
COMMENT ON COLUMN tenants.id IS '租户唯一标识，如 tenant-default';
COMMENT ON COLUMN tenants.status IS 'active=正常, suspended=暂停, expired=过期, deleted=已删除';
COMMENT ON COLUMN tenants.max_workstations IS '该租户允许的最大工作站数';

-- 默认租户（ON CONFLICT 保证幂等）
INSERT INTO tenants (id, name, status)
VALUES ('tenant-default', '默认租户', 'active')
ON CONFLICT (id) DO NOTHING;

-- ══ 2. workstations 表 ══
CREATE TABLE IF NOT EXISTS workstations (
    id                TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES tenants(id)
                          ON DELETE CASCADE,
    site_id           TEXT NULL,
    name              TEXT NOT NULL,
    agent_token       TEXT NULL,
    status            TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'disabled', 'deleted')),
    online_status     TEXT NOT NULL DEFAULT 'offline'
                        CHECK (online_status IN ('online', 'offline', 'unknown')),
    browser_status    TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (browser_status IN ('ready', 'login', 'p0', 'unknown')),
    last_heartbeat_at TIMESTAMPTZ NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workstations_tenant ON workstations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workstations_site ON workstations(site_id);

COMMENT ON TABLE workstations IS '工作站表（DaoPai Local Agent 标识）';
COMMENT ON COLUMN workstations.agent_token IS 'Local Agent 认证 token（未来 Phase 使用）';
COMMENT ON COLUMN workstations.online_status IS 'online=Agent 在线, offline=离线, unknown=未上报';
COMMENT ON COLUMN workstations.browser_status IS 'ready=浏览器就绪, login=待登录, p0=P0异常, unknown=未上报';

-- ══ 3. agent_heartbeats 表 ══
CREATE TABLE IF NOT EXISTS agent_heartbeats (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL REFERENCES tenants(id)
                        ON DELETE CASCADE,
    workstation_id  TEXT NOT NULL REFERENCES workstations(id)
                        ON DELETE CASCADE,
    status          TEXT NOT NULL,
    reported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_tenant_ws ON agent_heartbeats(tenant_id, workstation_id);
CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_reported ON agent_heartbeats(reported_at DESC);

COMMENT ON TABLE agent_heartbeats IS 'Local Agent 心跳表';

-- ══════════════════════════════════════════════════════════════
-- 4. 给现有业务表补 tenant_id
--    策略：ADD COLUMN → 回填 tenant-default → SET NOT NULL → 加 FK → 加索引
-- ══════════════════════════════════════════════════════════════

-- ── 4.1 sites ──
ALTER TABLE sites ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE sites SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
ALTER TABLE sites ALTER COLUMN tenant_id SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sites_tenant') THEN
        ALTER TABLE sites ADD CONSTRAINT fk_sites_tenant
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_sites_tenant ON sites(tenant_id);
COMMENT ON COLUMN sites.tenant_id IS '所属租户（多租户隔离）';

-- ── 4.2 windows ──
ALTER TABLE windows ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE windows SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
ALTER TABLE windows ALTER COLUMN tenant_id SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_windows_tenant') THEN
        ALTER TABLE windows ADD CONSTRAINT fk_windows_tenant
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_windows_tenant ON windows(tenant_id);

-- ── 4.3 tasks ──
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE tasks SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
ALTER TABLE tasks ALTER COLUMN tenant_id SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_tenant') THEN
        ALTER TABLE tasks ADD CONSTRAINT fk_tasks_tenant
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);

-- ── 4.4 waybill_results ──
ALTER TABLE waybill_results ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE waybill_results SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
ALTER TABLE waybill_results ALTER COLUMN tenant_id SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_waybill_results_tenant') THEN
        ALTER TABLE waybill_results ADD CONSTRAINT fk_waybill_results_tenant
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_wr_tenant ON waybill_results(tenant_id);

-- ── 4.5 task_logs ──
ALTER TABLE task_logs ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE task_logs SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
ALTER TABLE task_logs ALTER COLUMN tenant_id SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_task_logs_tenant') THEN
        ALTER TABLE task_logs ADD CONSTRAINT fk_task_logs_tenant
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_task_logs_tenant ON task_logs(tenant_id);

-- ── 4.6 waybill_pool ──
ALTER TABLE waybill_pool ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE waybill_pool SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
ALTER TABLE waybill_pool ALTER COLUMN tenant_id SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_waybill_pool_tenant') THEN
        ALTER TABLE waybill_pool ADD CONSTRAINT fk_waybill_pool_tenant
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_waybill_pool_tenant ON waybill_pool(tenant_id);

-- ── 4.7 metrics_snapshots ──
ALTER TABLE metrics_snapshots ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE metrics_snapshots SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
ALTER TABLE metrics_snapshots ALTER COLUMN tenant_id SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_metrics_snapshots_tenant') THEN
        ALTER TABLE metrics_snapshots ADD CONSTRAINT fk_metrics_snapshots_tenant
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_tenant ON metrics_snapshots(tenant_id);

-- ── 4.8 system_settings ──
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE system_settings SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
ALTER TABLE system_settings ALTER COLUMN tenant_id SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_system_settings_tenant') THEN
        ALTER TABLE system_settings ADD CONSTRAINT fk_system_settings_tenant
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_system_settings_tenant ON system_settings(tenant_id);

-- ══════════════════════════════════════════════════════════════
-- 5. 给 waybill_results / task_logs 补 site_id
--    通过 task_id 关联 tasks.site_id 回填
-- ══════════════════════════════════════════════════════════════

-- ── 5.1 waybill_results.site_id ──
ALTER TABLE waybill_results ADD COLUMN IF NOT EXISTS site_id TEXT;
UPDATE waybill_results wr
SET site_id = (SELECT t.site_id FROM tasks t WHERE t.id = wr.task_id)
WHERE wr.site_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_wr_site ON waybill_results(site_id) WHERE site_id IS NOT NULL;

-- ── 5.2 task_logs.site_id ──
ALTER TABLE task_logs ADD COLUMN IF NOT EXISTS site_id TEXT;
UPDATE task_logs tl
SET site_id = (SELECT t.site_id FROM tasks t WHERE t.id = tl.task_id)
WHERE tl.site_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_task_logs_site ON task_logs(site_id) WHERE site_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- 6. 给 tasks / task_logs 补 workstation_id（可空）
--    本轮 Agent 未拆分，允许为 NULL；Phase 2-C+ 再回填
-- ══════════════════════════════════════════════════════════════

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workstation_id TEXT NULL;
ALTER TABLE task_logs ADD COLUMN IF NOT EXISTS workstation_id TEXT NULL;

COMMENT ON COLUMN tasks.workstation_id IS '执行该任务的工作站 ID（可空，Agent 未拆分时为 NULL）';
COMMENT ON COLUMN task_logs.workstation_id IS '产生该日志的工作站 ID（可空）';
