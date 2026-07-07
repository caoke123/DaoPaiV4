-- ============================================================================
-- DaoPai V3 Migration 004: Agent Token 鉴权字段
-- Phase 4-E: 执行电脑授权码存储与在线状态字段
-- ============================================================================
-- 目标:
--   1. 给 workstations 表增加 agent_token 相关字段
--   2. 给 workstations 表增加在线状态辅助字段
--   3. 建立 agent_token_hash 索引
--   4. 幂等执行（可重复运行不报错）
-- ============================================================================

-- ══ 1. 重命名 agent_token → agent_token_hash（幂等） ══
-- 注意：不能直接 ALTER TABLE RENAME COLUMN，需先检查字段是否存在
DO $$
BEGIN
    -- 如果 agent_token 列存在且 agent_token_hash 列不存在，则重命名
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'workstations' AND column_name = 'agent_token'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'workstations' AND column_name = 'agent_token_hash'
    ) THEN
        ALTER TABLE workstations RENAME COLUMN agent_token TO agent_token_hash;
    END IF;
END $$;

-- 如果 agent_token_hash 列仍然不存在（agent_token 也不存在），则新增
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS agent_token_hash TEXT NULL;

-- 清空旧明文 token（兼容旧数据）
UPDATE workstations SET agent_token_hash = NULL WHERE agent_token_hash IS NOT NULL AND agent_token_hash NOT LIKE '%a%'
   OR agent_token_hash IS NOT NULL AND LENGTH(agent_token_hash) < 32;

-- ══ 2. 新增 agent token 管理字段 ══
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS agent_token_created_at TIMESTAMPTZ NULL;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS agent_token_last_used_at TIMESTAMPTZ NULL;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS agent_token_revoked_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN workstations.agent_token_hash IS '执行电脑授权码 SHA-256 hash（明文创建时展示一次）';
COMMENT ON COLUMN workstations.agent_token_created_at IS '当前授权码创建时间';
COMMENT ON COLUMN workstations.agent_token_last_used_at IS '授权码最近一次鉴权成功时间';
COMMENT ON COLUMN workstations.agent_token_revoked_at IS '授权码撤销时间，NULL 表示有效';

-- ══ 3. 新增 Agent 信息字段 ══
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS agent_version TEXT NULL;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS machine_fingerprint TEXT NULL;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS last_ip TEXT NULL;

COMMENT ON COLUMN workstations.agent_version IS '本地执行端版本号';
COMMENT ON COLUMN workstations.machine_fingerprint IS '本机指纹（可选，用于设备识别）';
COMMENT ON COLUMN workstations.last_ip IS '最近一次心跳来源 IP';

-- ══ 4. 建立索引 ══
CREATE INDEX IF NOT EXISTS idx_workstations_token_hash ON workstations(agent_token_hash)
    WHERE agent_token_hash IS NOT NULL;