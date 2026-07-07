-- ══════════════════════════════════════════════════════════════
-- 010: window_commands — Window Command 持久化表（Phase Deploy-0D）
--
-- 目标：
--   1. Cloud 创建窗口命令（open_window / close_window 等）
--   2. Agent 拉取并执行命令
--   3. Agent 上报执行结果
--   4. Header 通过命令状态跟踪窗口操作进度
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS window_commands (
    id                TEXT PRIMARY KEY,

    tenant_id         TEXT NOT NULL,
    site_id           TEXT NOT NULL,
    workstation_id    TEXT NOT NULL,
    window_id         TEXT NOT NULL,
    staff_name        TEXT NOT NULL,

    type              TEXT NOT NULL
                          CHECK (type IN ('open_window', 'close_window', 'restart_window', 'refresh_status')),
    status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'claimed', 'running', 'done', 'failed', 'cancelled')),

    params            JSONB NOT NULL DEFAULT '{}'::jsonb,
    result            JSONB,

    error             TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at        TIMESTAMPTZ,
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_window_commands_claim
    ON window_commands(tenant_id, workstation_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_window_commands_site
    ON window_commands(tenant_id, site_id, workstation_id, window_id);

CREATE INDEX IF NOT EXISTS idx_window_commands_status
    ON window_commands(status, updated_at DESC);

COMMENT ON TABLE window_commands IS '窗口命令持久化表（Phase Deploy-0D）';
COMMENT ON COLUMN window_commands.type IS 'open_window / close_window / restart_window / refresh_status';
COMMENT ON COLUMN window_commands.status IS 'pending / claimed / running / done / failed / cancelled';
COMMENT ON COLUMN window_commands.params IS '命令参数（JSONB）';
COMMENT ON COLUMN window_commands.result IS '执行结果（JSONB）';
