-- ══════════════════════════════════════════════════════════════
-- bnsy-operator-next PostgreSQL Schema v1.0
-- 严格基于 src/types/api-contracts.ts (SSoT) 设计
--
-- 设计原则:
--   1. 一行一条运单结果，废弃旧的批次 JSON 大列
--   2. 所有外键显式声明 + ON DELETE CASCADE
--   3. input_data 使用 JSONB + GIN 索引（支持运单号直接查任务）
--   4. waybill_no 建索引（对账核心查询路径）
--   5. 使用 CREATE TABLE IF NOT EXISTS 实现幂等初始化
-- ══════════════════════════════════════════════════════════════

-- ══ 扩展 ══
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- 提供 gen_random_uuid()

-- ══════════════════════════════════════════════════════════════
-- 0. tenants — 租户表（多租户隔离基石，Phase 2-B）
-- ══════════════════════════════════════════════════════════════
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

-- 默认租户（ON CONFLICT 保证幂等）
INSERT INTO tenants (id, name, status)
VALUES ('tenant-default', '默认租户', 'active')
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════════════════════
-- 0b. workstations — 工作站表（DaoPai Local Agent 标识，Phase 2-B）
-- ══════════════════════════════════════════════════════════════
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

-- ══════════════════════════════════════════════════════════════
-- 0c. agent_heartbeats — Local Agent 心跳表（Phase 2-B）
-- ══════════════════════════════════════════════════════════════
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
-- 1. sites — 网点表（对应 api-contracts.ts Site 接口）
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sites (
    id          TEXT PRIMARY KEY,                          -- 网点唯一标识，如 "tiannanda", "heyuan"
    name        TEXT NOT NULL,                             -- 网点显示名称，如 "天南大网点"
    code        TEXT,                                      -- 网点代码（可选），如 "TJ-ND"
    enabled     BOOLEAN NOT NULL DEFAULT true,             -- 是否启用
    tenant_id   TEXT NOT NULL DEFAULT 'tenant-default'
                    REFERENCES tenants(id) ON DELETE CASCADE,  -- 所属租户（Phase 2-B）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sites IS '网点表';
COMMENT ON COLUMN sites.id IS '网点唯一标识';
COMMENT ON COLUMN sites.name IS '网点显示名称';
COMMENT ON COLUMN sites.code IS '网点代码（可选）';
COMMENT ON COLUMN sites.enabled IS '是否启用';
-- 注：sites.tenant_id 的 COMMENT 与 idx_sites_tenant 由 migration 001 创建
-- （避免现有库 tenant_id 列缺失时 init-schema.sql 整体回滚）

-- ══════════════════════════════════════════════════════════════
-- 2. windows — 窗口配置表（对应 api-contracts.ts WindowInfo 接口）
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS windows (
    id              TEXT PRIMARY KEY,                      -- EasyBR browerid
    name            TEXT NOT NULL,                         -- EasyBR 窗口名称
    cdp_port        INTEGER NOT NULL DEFAULT 0,           -- CDP 调试端口（当前固定为 0）
    role            TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
                                                           -- 窗口角色
    site_id         TEXT NOT NULL REFERENCES sites(id)
                        ON DELETE CASCADE,                 -- 所属网点
    staff_name      TEXT,                                  -- 登录员工姓名（管理员窗口为 null）
    is_connected    BOOLEAN NOT NULL DEFAULT false,       -- 当前连接状态
    enabled         BOOLEAN NOT NULL DEFAULT true,        -- 用户手动 toggle 状态
    tenant_id       TEXT NOT NULL DEFAULT 'tenant-default'
                        REFERENCES tenants(id) ON DELETE CASCADE,  -- 所属租户（Phase 2-B）
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_windows_site ON windows(site_id);
CREATE INDEX IF NOT EXISTS idx_windows_role ON windows(role);
-- idx_windows_tenant 由 migration 001 创建

COMMENT ON TABLE windows IS 'EasyBR 窗口配置表';
COMMENT ON COLUMN windows.id IS 'EasyBR browerid（窗口唯一标识）';
COMMENT ON COLUMN windows.role IS 'admin=管理员窗口, staff=员工窗口';
COMMENT ON COLUMN windows.staff_name IS '登录的员工姓名（仅员工窗口有值）';
COMMENT ON COLUMN windows.enabled IS '用户手动 toggle 的状态，重启后可恢复';

-- ══════════════════════════════════════════════════════════════
-- 3. tasks — 任务表（对应 api-contracts.ts Task 接口）
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                                                           -- 任务唯一 ID
    type            TEXT NOT NULL CHECK (type IN ('arrive', 'dispatch', 'sign', 'integrated', 'init_window')),
                                                           -- 任务类型
    site_id         TEXT NOT NULL REFERENCES sites(id)
                        ON DELETE CASCADE,                 -- 所属网点
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
                                                           -- 任务生命周期状态
    total_count     INTEGER NOT NULL DEFAULT 0,           -- 运单总数
    done_count      INTEGER NOT NULL DEFAULT 0,           -- 已处理运单数
    fail_count      INTEGER NOT NULL DEFAULT 0,           -- 失败运单数
    input_data      JSONB,                                 -- ★ 原始请求参数（JSONB + GIN 索引，支持运单号反查）
    tenant_id       TEXT NOT NULL DEFAULT 'tenant-default'
                        REFERENCES tenants(id) ON DELETE CASCADE,  -- 所属租户（Phase 2-B）
    workstation_id  TEXT NULL,                             -- 执行该任务的工作站 ID（Phase 2-B，Agent 未拆分时为 NULL）
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- 创建时间
    finished_at     TIMESTAMPTZ                            -- 完成时间（null = 未结束）
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
CREATE INDEX IF NOT EXISTS idx_tasks_site ON tasks(site_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
-- idx_tasks_tenant 由 migration 001 创建
-- ★ GIN 索引：支持 jsonb 查询，例如查找包含某运单号的任务
-- 查询示例: SELECT * FROM tasks WHERE input_data @? '$.waybillNos[*] ? (@ == "YT1234567890")';
CREATE INDEX IF NOT EXISTS idx_tasks_input_data_gin ON tasks USING GIN (input_data jsonb_path_ops);

COMMENT ON TABLE tasks IS '任务表';
COMMENT ON COLUMN tasks.input_data IS 'JSONB 格式原始请求参数，支持 GIN 索引运单号反查';
COMMENT ON COLUMN tasks.status IS 'pending → running → done/failed/cancelled';

-- ══════════════════════════════════════════════════════════════
-- 4. waybill_results — 运单明细表（对应 api-contracts.ts WaybillResult 接口）
-- ★ 核心改进：一行一条运单结果，废弃旧的 batch JSON 大列
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS waybill_results (
    id              BIGSERIAL PRIMARY KEY,                 -- 自增主键（高性能）
    task_id         UUID NOT NULL REFERENCES tasks(id)
                        ON DELETE CASCADE,                 -- 所属任务
    batch_seq       INTEGER NOT NULL,                     -- 批次序号（同一任务内递增）
    waybill_no      TEXT NOT NULL,                        -- 运单号（对账核心）
    staff_name      TEXT,                                  -- 处理该运单的员工姓名
    success         BOOLEAN NOT NULL,                     -- 是否成功
    message         TEXT,                                  -- 结果描述
    timestamp       BIGINT NOT NULL,                      -- 操作时间戳（毫秒）
    status          TEXT CHECK (status IN ('SUCCESS', 'PARTIAL', 'FAILED', 'UNKNOWN_NEEDS_MANUAL_CHECK', 'DRY_RUN_SKIPPED')),
                                                           -- 详细状态（DRY_RUN_SKIPPED = 试运行模式跳过最终提交）
    tenant_id       TEXT NOT NULL DEFAULT 'tenant-default'
                        REFERENCES tenants(id) ON DELETE CASCADE,  -- 所属租户（Phase 2-B）
    site_id         TEXT,                                  -- 所属网点（Phase 2-B，通过 task_id 回填）
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 复合索引：按任务 + 批次查询（前端轮询进度）
CREATE INDEX IF NOT EXISTS idx_wr_task_batch ON waybill_results(task_id, batch_seq);
-- 单列索引：按运单号查询（对账核心）
CREATE INDEX IF NOT EXISTS idx_wr_waybill_no ON waybill_results(waybill_no);
-- 索引：按任务查所有运单
CREATE INDEX IF NOT EXISTS idx_wr_task_id ON waybill_results(task_id);
-- 索引：按员工查询（绩效统计）
CREATE INDEX IF NOT EXISTS idx_wr_staff ON waybill_results(staff_name) WHERE staff_name IS NOT NULL;
-- ★ 复合索引：按任务+员工查询（员工维度运单过滤）
CREATE INDEX IF NOT EXISTS idx_wr_task_staff ON waybill_results(task_id, staff_name);
-- 注：idx_wr_tenant / idx_wr_site 由 migration 001 创建（避免现有库列缺失时 init 失败）

COMMENT ON TABLE waybill_results IS '运单操作明细表（一行一条运单结果）';
COMMENT ON COLUMN waybill_results.batch_seq IS '批次序号，同一任务内递增';
COMMENT ON COLUMN waybill_results.status IS 'SUCCESS=全成功, PARTIAL=部分成功, FAILED=失败, UNKNOWN_NEEDS_MANUAL_CHECK=需人工核实';

-- ══════════════════════════════════════════════════════════════
-- 5. task_logs — 任务日志表（对应 api-contracts.ts TaskLogEntry 接口）
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS task_logs (
    id              UUID PRIMARY KEY,                      -- 日志唯一 ID
    task_id         UUID NOT NULL REFERENCES tasks(id)
                        ON DELETE CASCADE,                 -- 所属任务
    timestamp       BIGINT NOT NULL,                      -- 日志时间戳（毫秒）
    level           TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
                                                           -- 日志级别
    message         TEXT NOT NULL,                        -- 日志内容
    source          TEXT NOT NULL,                        -- 来源模块 (Engine / api / DispatchHandler 等)
    staff_name      TEXT,                                  -- 结构化追踪：员工姓名
    window_id       TEXT,                                  -- 结构化追踪：窗口 ID
    tenant_id       TEXT NOT NULL DEFAULT 'tenant-default'
                        REFERENCES tenants(id) ON DELETE CASCADE,  -- 所属租户（Phase 2-B）
    site_id         TEXT,                                  -- 所属网点（Phase 2-B，通过 task_id 回填）
    workstation_id  TEXT,                                  -- 产生该日志的工作站 ID（Phase 2-B，可空）
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_time ON task_logs(task_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_task_logs_level ON task_logs(task_id, level);
-- idx_task_logs_tenant / idx_task_logs_site 由 migration 001 创建

COMMENT ON TABLE task_logs IS '任务执行日志表（持久化 TaskLogManager）';
COMMENT ON COLUMN task_logs.source IS '来源模块，如 Engine / api / DispatchHandler';

-- ══════════════════════════════════════════════════════════════
-- 6. metrics_snapshots — 指标快照表（持久化 RuntimeMetrics）
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS metrics_snapshots (
    id                          BIGSERIAL PRIMARY KEY,
    popup_dismiss_count         INTEGER NOT NULL DEFAULT 0,
    session_recover_count       INTEGER NOT NULL DEFAULT 0,
    session_recover_success_count INTEGER NOT NULL DEFAULT 0,
    session_recover_fail_count  INTEGER NOT NULL DEFAULT 0,
    navigation_fix_count        INTEGER NOT NULL DEFAULT 0,
    task_success_count          INTEGER NOT NULL DEFAULT 0,
    task_fail_count             INTEGER NOT NULL DEFAULT 0,
    start_time                  TEXT,                      -- ISO 8601
    snapshot_time               TEXT NOT NULL,             -- ISO 8601
    uptime_ms                   BIGINT NOT NULL,          -- 运行时长（毫秒）
    tenant_id                   TEXT NOT NULL DEFAULT 'tenant-default'
                                    REFERENCES tenants(id) ON DELETE CASCADE,  -- 所属租户（Phase 2-B）
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics_snapshots(created_at DESC);
-- idx_metrics_snapshots_tenant 由 migration 001 创建

COMMENT ON TABLE metrics_snapshots IS '运行时指标快照表';

-- ══════════════════════════════════════════════════════════════
-- 7. waybill_pool — 运单状态池（对账基石）
-- ★ 使用 INSERT ... ON CONFLICT ... DO UPDATE 维护每个运单的最新状态
--   这是未来"总部/商户对账找差集"的核心基础设施
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS waybill_pool (
    waybill_no      TEXT PRIMARY KEY,                      -- 运单号（唯一）
    site_id         TEXT NOT NULL,                         -- 所属网点
    status          TEXT NOT NULL,                         -- 最新状态
    task_id         UUID REFERENCES tasks(id)
                        ON DELETE SET NULL,               -- 最后一次处理此运单的任务
    tenant_id       TEXT NOT NULL DEFAULT 'tenant-default'
                        REFERENCES tenants(id) ON DELETE CASCADE,  -- 所属租户（Phase 2-B）
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waybill_pool_site ON waybill_pool(site_id);
CREATE INDEX IF NOT EXISTS idx_waybill_pool_status ON waybill_pool(status);
-- idx_waybill_pool_tenant 由 migration 001 创建

COMMENT ON TABLE waybill_pool IS '运单状态池——每个运单只存最新状态，INSERT ON CONFLICT DO UPDATE 驱动更新';
COMMENT ON COLUMN waybill_pool.status IS '运单当前状态（对账找差集用）';

-- ══════════════════════════════════════════════════════════════
-- 8. 系统设置表（持久化 SettingsManager 配置）
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS system_settings (
    key             TEXT PRIMARY KEY,                      -- 配置键
    value           TEXT NOT NULL,                         -- 配置值（JSON 字符串）
    tenant_id       TEXT NOT NULL DEFAULT 'tenant-default'
                        REFERENCES tenants(id) ON DELETE CASCADE,  -- 所属租户（Phase 2-B）
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- idx_system_settings_tenant 由 migration 001 创建

COMMENT ON TABLE system_settings IS '系统设置键值表（替代 settings.json 文件）';
