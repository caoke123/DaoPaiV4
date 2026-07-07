-- ══════════════════════════════════════════════════════════════
-- 009: window_status — Agent 窗口状态持久化（Phase Deploy-0C）
--
-- 目标：
--   1. Agent 定期上报本地窗口状态到 Cloud
--   2. Cloud 持久化到 PostgreSQL，Header 从中读取
--   3. 每个窗口由 (tenant_id, site_id, workstation_id, window_id) 唯一定位
--   4. 超过 60 秒未更新的窗口视为 offline
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS window_status (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         TEXT NOT NULL DEFAULT 'tenant-default'
                          REFERENCES tenants(id) ON DELETE CASCADE,
    site_id           TEXT NOT NULL,
    workstation_id    TEXT NOT NULL,
    window_id         TEXT NOT NULL,
    staff_name        TEXT NOT NULL,

    -- Core status
    status            TEXT NOT NULL DEFAULT 'offline'
                          CHECK (status IN ('offline', 'starting', 'login_required', 'logging_in', 'ready', 'busy', 'error')),
    status_text       TEXT NOT NULL DEFAULT '',

    -- Runtime state
    current_url       TEXT,
    is_process_alive  BOOLEAN NOT NULL DEFAULT false,
    is_cdp_ready      BOOLEAN NOT NULL DEFAULT false,
    is_dashboard_ready BOOLEAN NOT NULL DEFAULT false,
    is_login_page     BOOLEAN NOT NULL DEFAULT false,

    -- Metadata
    last_error        TEXT,
    cdp_endpoint      TEXT,
    profile_path      TEXT,
    chrome_pid        INTEGER,

    -- Timestamps
    last_heartbeat_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraint: one row per window
    CONSTRAINT uq_window_status UNIQUE (tenant_id, site_id, workstation_id, window_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_window_status_site ON window_status(tenant_id, site_id);
CREATE INDEX IF NOT EXISTS idx_window_status_ws ON window_status(tenant_id, site_id, workstation_id);
CREATE INDEX IF NOT EXISTS idx_window_status_updated ON window_status(updated_at DESC);

COMMENT ON TABLE window_status IS 'Agent 窗口状态持久化表（Phase Deploy-0C）';
COMMENT ON COLUMN window_status.window_id IS '窗口唯一标识（如 staff-张三）';
COMMENT ON COLUMN window_status.status IS 'offline / starting / login_required / logging_in / ready / busy / error';
