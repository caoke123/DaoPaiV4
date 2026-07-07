-- ══════════════════════════════════════════════════════════════
-- 011: M5-2 — 扩展 window_status CHECK constraint
--
-- 将 status 约束从旧的 7 态扩展为完整的 M5-2 分段状态集，
-- 包括启动中间状态（opening → process_started → cdp_connecting
-- → cdp_connected → login_checking → p0_checking → popup_cleaning
-- → ready_checking → ready）。
--
-- 方法：
--   1. DROP 旧约束
--   2. ADD 新约束（含所有新状态 + 向后兼容别名）
--   3. 不修改已有数据（默认值仍为 'offline'）
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- 1. 移除旧 CHECK constraint
ALTER TABLE window_status DROP CONSTRAINT IF EXISTS window_status_status_check;

-- 2. 添加新 CHECK constraint（M5-2 完整状态集）
ALTER TABLE window_status
  ADD CONSTRAINT window_status_status_check
  CHECK (status IN (
    -- M5-2 granular phases
    'offline',
    'opening',
    'process_started',
    'cdp_connecting',
    'cdp_connected',
    'login_checking',
    'login_required',
    'p0_checking',
    'popup_cleaning',
    'ready_checking',
    'ready',
    'busy',
    'closing',
    'closed',
    'failed',
    -- backward compat aliases
    'starting',
    'logging_in',
    'error',
    'connecting',
    'connected',
    'degraded'
  ));

COMMIT;
