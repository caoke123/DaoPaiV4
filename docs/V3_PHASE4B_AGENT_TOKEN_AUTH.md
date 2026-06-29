# DaoPai V3 Phase 4-B：Agent Token 与 workstation 鉴权设计

> 版本：v1.0
> 日期：2026-06-29
> 阶段：Phase 4-B（鉴权设计，仅文档，不写 Agent 闭环代码）
> 前置 commit：`f4c0dc9` — docs: define Local Agent boundary
> 关联文档：V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md / V3_ARCHITECTURE.md / V3_DATA_MODEL.md / V3_DECISIONS.md

---

## 1. 设计总结

```
用户 JWT 代表人，Agent Token 代表设备。
两者鉴权模型必须分离，不可互换。

用户 JWT → /api/* → 前端 Web 页面
Agent Token → /agent/* → Local Agent 程序
```

本阶段设计 Agent Token 的完整生命周期（生成、存储、校验、撤销、轮换），以及 `/agent/*` 路径的鉴权中间件和 AgentPrincipal 类型。不实现完整 Agent 程序，不做任务拉取闭环。

---

## 2. Agent Token 与用户 JWT 区分

### 2.1 对照表

| 维度 | 用户 JWT | Agent Token |
|------|----------|-------------|
| 使用者 | Web 前端用户 | Local Agent 程序 |
| 代表 | 人（user） | 工作站设备（workstation） |
| 访问路径 | `/api/*` | `/agent/*` |
| 能否登录前端 | 可以 | 不可以 |
| 能否访问 `/api/auth/*` | 可以 | 不可以 |
| 能否访问 `/api/cloud/*` | 可以 | 不可以 |
| 能否访问 `/agent/*` | 不可以 | 可以 |
| 有效期 | access 15 分钟 / refresh 7 天 | 长期有效，支持撤销 |
| 刷新机制 | refresh token 轮换 | 撤销后重新生成 |
| 存储位置 | 前端 localStorage | Agent 本地 agent.json |
| 数据库存储 | users 表 + refresh_tokens 表 | workstations 表 agent_token_hash |

### 2.2 路径隔离规则

```
请求路径           →  鉴权方式
─────────────────────────────────
/api/auth/*        →  用户 JWT（或匿名，取决于 AUTH_REQUIRED）
/api/cloud/*       →  用户 JWT
/api/operations/*  →  用户 JWT
/api/tasks/*       →  用户 JWT
/api/settings/*    →  用户 JWT
/api/status        →  无需鉴权
/agent/*           →  Agent Token（必须）
```

### 2.3 鉴权中间件分离

当前 `backend/auth/authMiddleware.ts` 只处理用户 JWT。需要新增独立的 Agent Token 鉴权中间件，两者不混用：

| 中间件 | 文件 | 注册路径 | 鉴权方式 |
|--------|------|----------|----------|
| `authMiddleware` | `backend/auth/authMiddleware.ts`（已存在） | `/api/*` | 解析 Bearer JWT → UserPrincipal |
| `requireAgent` | `backend/auth/agentAuth.ts`（已有占位，待实现） | `/agent/*` | 解析 Bearer agentToken → AgentPrincipal |

---

## 3. AgentPrincipal 设计

### 3.1 当前定义（已存在）

`backend/auth/types.ts` 中已有 `AgentPrincipal` 类型定义：

```ts
/** Agent 身份 — 通过本地执行端 agentToken 鉴权获得 */
export interface AgentPrincipal {
  type: 'agent';
  tenantId: string;
  workstationId: string;
}
```

### 3.2 建议补充 siteId

Phase 4-A 已明确 `workstation.site_id` 可空（允许先注册工作站、后绑定站点）。建议 AgentPrincipal 补充可选的 `siteId`：

```ts
export interface AgentPrincipal {
  type: 'agent';
  tenantId: string;
  workstationId: string;
  siteId?: string | null;   // 可选，工作站可能尚未绑定站点
}
```

### 3.3 约束

- AgentPrincipal 只在 `/agent/*` 路径下生效
- 不污染 `UserPrincipal` 类型
- 不影响现有前端登录流程
- `requestContext` 中间件从 `AgentPrincipal` 提取 `tenantId` 注入 `req.tenantId`

---

## 4. workstation 字段设计

### 4.1 现有 workstations 表（来自 migration 001）

```sql
CREATE TABLE IF NOT EXISTS workstations (
    id                TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id           TEXT NULL,           -- 已可空
    name              TEXT NOT NULL,
    agent_token       TEXT NULL,           -- 当前存明文，需改为 hash
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
```

### 4.2 建议补充字段

当前 `agent_token` 字段存明文，安全风险高。建议：

1. 将 `agent_token` 重命名为 `agent_token_hash`（只存 hash）
2. 新增以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_token_hash` | TEXT NULL | Agent Token 的 SHA-256 哈希值（不存明文） |
| `agent_token_created_at` | TIMESTAMPTZ NULL | Token 创建时间 |
| `agent_token_last_used_at` | TIMESTAMPTZ NULL | Token 最后使用时间 |
| `agent_token_revoked_at` | TIMESTAMPTZ NULL | Token 撤销时间（NULL = 未撤销） |
| `agent_version` | TEXT NULL | Agent 版本号 |
| `machine_fingerprint` | TEXT NULL | 机器指纹（可选） |
| `last_ip` | TEXT NULL | 最后心跳来源 IP |

### 4.3 建议 migration

```sql
-- 004_v3_agent_token_auth.sql

-- 1. 重命名 agent_token → agent_token_hash
ALTER TABLE workstations RENAME COLUMN agent_token TO agent_token_hash;

-- 2. 新增字段
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS agent_token_created_at TIMESTAMPTZ;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS agent_token_last_used_at TIMESTAMPTZ;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS agent_token_revoked_at TIMESTAMPTZ;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS agent_version TEXT;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS machine_fingerprint TEXT;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS last_ip TEXT;

-- 3. 增加索引
CREATE INDEX IF NOT EXISTS idx_workstations_token_hash ON workstations(agent_token_hash)
    WHERE agent_token_hash IS NOT NULL;

-- 4. 对现有默认工作站清空旧明文 token（安全加固）
UPDATE workstations SET agent_token_hash = NULL
WHERE agent_token_hash IS NOT NULL AND agent_token_hash NOT LIKE '$%';
```

**说明**：本阶段仅设计 migration，不执行。Phase 4-C 或 4-D 再实际执行。

### 4.4 状态值说明

| 维度 | 字段 | 取值 | 含义 |
|------|------|------|------|
| 授权 | `status` | `active` / `disabled` / `deleted` | 管理员手动控制 |
| 在线 | `online_status` | `online` / `offline` / `unknown` | 心跳推导 |
| 浏览器 | `browser_status` | `ready` / `login` / `p0` / `unknown` | Agent 上报 |

**注意**：当前 `browser_status` CHECK 约束为 `(ready, login, p0, unknown)`，与 Phase 4-A 建议的 `(ready, browser_missing, degraded, unknown)` 不一致。建议后续统一，但不在本阶段修改（避免影响现有执行链路）。

---

## 5. Agent Token 生成策略

### 5.1 生成时机

超级管理员在 Cloud 后台创建 workstation 记录时，同步生成 agentToken。

### 5.2 生成方式

```ts
// 建议函数签名（backend/auth/agentToken.ts）
function generateAgentToken(): { plaintext: string; hash: string }
```

流程：

```
1. 生成 32 字节随机数（crypto.randomBytes）
2. 编码为 hex 或 base64url
3. 拼接前缀：daopai_agent_{random}
4. 对明文做 SHA-256 哈希（crypto.createHash('sha256')）
5. 返回 { plaintext, hash }
```

### 5.3 明文展示

- 明文 token **仅在创建时展示一次**
- 管理员需复制保存到 agent.json 中下发
- 刷新页面后不再展示明文
- 数据库只保存 hash

### 5.4 格式建议

```
daopai_agent_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
```

### 5.5 撤销策略

- 管理员可撤销某 workstation 的 token
- 撤销后 `agent_token_revoked_at` 设为当前时间
- 已撤销的 token 立即不可用（鉴权中间件返回 401）
- 撤销不影响已分配的任务（已 running 的任务可继续执行）

### 5.6 轮换策略

- 管理员可重新生成 token（旧 token 自动撤销）
- 旧 token 的 `agent_token_revoked_at` 设为当前时间
- 新 token 覆盖 `agent_token_hash` 和 `agent_token_created_at`
- 旧 Agent 使用旧 token 请求时收到 401，需等待重新配置

### 5.7 最后使用时间

- 每次 Agent 鉴权成功时更新 `agent_token_last_used_at`
- 可用于审计和闲置 workstation 检测

---

## 6. 鉴权中间件设计

### 6.1 当前占位代码

`backend/auth/agentAuth.ts` 已有两个占位函数：

```ts
// 当前状态：都是占位，不做真实验证
export function parseAgentToken(_req: Request): AgentPrincipal | null {
  return null;  // TODO Phase 3-B: 实现真实 agentToken 解析
}

export function requireAgent(_req: Request, res: Response, next: NextFunction): void {
  next();  // TODO Phase 3-B: 实现真实 Agent 鉴权
}
```

### 6.2 建议实现

```ts
// backend/auth/agentToken.ts（新增）

import crypto from 'crypto';

/**
 * 对 Agent Token 明文做 SHA-256 哈希
 */
export function hashAgentToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/**
 * 生成 Agent Token（明文 + hash）
 */
export function generateAgentToken(): { plaintext: string; hash: string } {
  const random = crypto.randomBytes(32).toString('hex');
  const plaintext = `daopai_agent_${random}`;
  const hash = hashAgentToken(plaintext);
  return { plaintext, hash };
}

/**
 * 验证 Agent Token 是否匹配数据库中的 hash
 */
export function verifyAgentToken(plaintext: string, storedHash: string): boolean {
  return hashAgentToken(plaintext) === storedHash;
}
```

```ts
// backend/auth/agentAuth.ts（改造）

import type { Request, Response, NextFunction } from 'express';
import type { AgentPrincipal } from './types';
import { hashAgentToken } from './agentToken';
import { pgDb } from '../db/PgDatabase';

/**
 * 从请求中解析 Agent Token 并验证，返回 AgentPrincipal 或 null
 */
export async function parseAgentToken(req: Request): Promise<AgentPrincipal | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  const plaintext = parts[1];
  const tokenHash = hashAgentToken(plaintext);

  // 从数据库查询匹配的 workstation
  const ws = await pgDb.getWorkstationByTokenHash(tokenHash);
  if (!ws) return null;

  // 检查 token 是否被撤销
  if (ws.agentTokenRevokedAt) return null;

  // 检查 workstation 是否被禁用
  if (ws.status === 'disabled' || ws.status === 'deleted') return null;

  return {
    type: 'agent',
    tenantId: ws.tenantId,
    workstationId: ws.id,
    siteId: ws.siteId,
  };
}

/**
 * requireAgent 中间件
 *
 * 要求当前请求携带有效 Agent Token，否则返回 401/403。
 * 用于 /agent/* 路由保护。
 */
export async function requireAgent(req: Request, res: Response, next: NextFunction): Promise<void> {
  const principal = await parseAgentToken(req);

  if (!principal) {
    res.status(401).json({
      ok: false,
      code: 'AGENT_TOKEN_INVALID',
      message: 'Agent Token 无效或已过期',
    });
    return;
  }

  // 注入 principal 到 request
  req.principal = principal;
  req.tenantId = principal.tenantId;
  req.workstationId = principal.workstationId;

  next();
}
```

### 6.3 错误响应

| 场景 | HTTP 状态码 | 错误码 | 说明 |
|------|------------|--------|------|
| 无 Authorization header | 401 | `AGENT_TOKEN_MISSING` | 未携带 Token |
| Token 格式错误 | 401 | `AGENT_TOKEN_INVALID` | 格式不是 Bearer xxx |
| Token 不匹配 | 401 | `AGENT_TOKEN_INVALID` | hash 不匹配任何 workstation |
| Token 已撤销 | 401 | `AGENT_TOKEN_REVOKED` | agent_token_revoked_at 不为空 |
| workstation 已禁用 | 403 | `WORKSTATION_DISABLED` | status = disabled |
| workstation 已删除 | 403 | `WORKSTATION_DELETED` | status = deleted |

### 6.4 统一响应格式

```json
{
  "ok": false,
  "code": "AGENT_TOKEN_INVALID",
  "message": "Agent Token 无效或已过期",
  "timestamp": "2026-06-29T12:00:00Z"
}
```

---

## 7. 用户端 workstation 管理边界

### 7.1 建议 API（用户 JWT 访问）

这些是 Cloud 管理接口，由用户 JWT 鉴权，用于管理员管理 workstation：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/cloud/workstations` | 查看 workstation 列表（已实现） |
| POST | `/api/cloud/workstations` | 创建 workstation 记录 + 生成 agentToken |
| POST | `/api/cloud/workstations/:id/token` | 重新生成 agentToken（轮换） |
| POST | `/api/cloud/workstations/:id/disable` | 禁用 workstation |
| POST | `/api/cloud/workstations/:id/enable` | 启用 workstation |

### 7.2 创建 workstation 流程

```
POST /api/cloud/workstations
  Body: { name, siteId? }

1. 验证 tenantId（从用户 JWT 获取）
2. 检查租户 workstation 数量是否超过 max_workstations
3. 生成 workstationId（UUID）
4. 调用 generateAgentToken() 生成 token
5. INSERT INTO workstations (id, tenant_id, name, site_id, agent_token_hash, agent_token_created_at, ...)
6. 返回 { workstationId, name, agentToken (明文，仅此一次) }
```

### 7.3 重新生成 token 流程

```
POST /api/cloud/workstations/:id/token

1. 验证 tenantId 和 workstationId 归属
2. 调用 generateAgentToken() 生成新 token
3. UPDATE workstations SET agent_token_hash = newHash, agent_token_created_at = NOW(), agent_token_revoked_at = NOW()（旧 token 自动撤销）
4. 返回 { agentToken (明文，仅此一次) }
```

### 7.4 前端 UI（第一版最小）

- 在 `/system?tab=organization` 的"工作站列表"中增加"创建工作站"按钮
- 创建成功后弹窗展示 agentToken（明文，提示复制后关闭）
- "重新生成 Token"按钮（需二次确认）
- "禁用/启用"按钮
- 不展示 token 明文（已创建后不可查看）

---

## 8. Agent 端接口边界

### 8.1 鉴权要求

所有 `/agent/*` 路径必须经过 `requireAgent` 中间件。

### 8.2 建议接口（本阶段仅设计，不实现）

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/agent/me` | requireAgent | 验证 Agent Token 有效性，返回 workstation 信息 |
| POST | `/agent/heartbeat` | requireAgent | 心跳上报 + 任务通知 |
| POST | `/agent/tasks/pull` | requireAgent | 拉取待执行任务 |
| POST | `/agent/tasks/:id/progress` | requireAgent | 上报执行进度 |
| POST | `/agent/tasks/:id/logs` | requireAgent | 上报执行日志 |
| POST | `/agent/tasks/:id/complete` | requireAgent | 回传执行结果 |
| POST | `/agent/tasks/:id/fail` | requireAgent | 上报执行失败 |

### 8.3 GET /agent/me 响应示例

```json
{
  "ok": true,
  "data": {
    "workstationId": "ws-xxx",
    "tenantId": "tenant-default",
    "name": "天南大-前台01",
    "status": "active",
    "siteId": "site-xxx"
  }
}
```

### 8.4 用户 JWT 与 Agent 接口互斥

- 用户 JWT 请求 `/agent/*` → 401（不是 Agent Token）
- Agent Token 请求 `/api/cloud/*` → 401（不是用户 JWT）
- 中间件通过路径前缀 `/agent/` vs `/api/` 区分

---

## 9. PgDatabase 建议新增方法

### 9.1 按 token hash 查询 workstation

```ts
/**
 * 根据 agent_token_hash 查询 workstation
 * 用于 Agent Token 鉴权验证
 */
async getWorkstationByTokenHash(tokenHash: string): Promise<{
  id: string;
  tenantId: string;
  siteId: string | null;
  name: string;
  status: string;
  agentTokenRevokedAt: string | null;
} | null>
```

### 9.2 创建 workstation

```ts
/**
 * 创建 workstation 记录
 */
async createWorkstation(params: {
  tenantId: string;
  name: string;
  siteId?: string | null;
  agentTokenHash: string;
}): Promise<{ id: string; name: string }>
```

### 9.3 更新 token

```ts
/**
 * 轮换 agentToken（撤销旧 token + 设置新 hash）
 */
async rotateAgentToken(workstationId: string, tenantId: string, newTokenHash: string): Promise<void>
```

### 9.4 更新 token 最后使用时间

```ts
/**
 * 更新 agent_token_last_used_at
 */
async touchAgentToken(workstationId: string): Promise<void>
```

---

## 10. 路由注册设计

### 10.1 中间件挂载顺序

```ts
// backend/index.ts 建议结构

// 1. 全局中间件
app.use(shutdownGuard);
app.use(express.json());

// 2. 用户认证中间件 → /api/*
app.use('/api', authMiddleware);
app.use('/api', requestContext);

// 3. Agent 认证中间件 → /agent/*
app.use('/agent', requireAgent);

// 4. 用户路由
app.use('/api/auth', authRoutes);
app.use('/api/cloud', cloudRoutes);
app.use('/api/operations', operationsRoutes);
// ...

// 5. Agent 路由（Phase 4-C/D 实现）
app.use('/agent', agentRoutes);
```

### 10.2 关键点

- `authMiddleware`（用户 JWT）和 `requireAgent`（Agent Token）是两个独立的中间件
- 分别挂载到不同的路径前缀
- 不互相污染
- 当前 `authMiddleware` 不处理 `/agent/*`，`requireAgent` 不处理 `/api/*`

---

## 11. 测试设计

### 11.1 后续测试项（Phase 4-C/D 实现时编写）

| 编号 | 测试项 | 验证点 |
|------|--------|--------|
| T1 | 生成 token 后数据库不保存明文 | `agent_token_hash` 不是明文，无法反推 |
| T2 | 正确 token 可通过鉴权 | `requireAgent` 注入 AgentPrincipal 并调用 next() |
| T3 | 错误 token 返回 401 | hash 不匹配 → 401 + `AGENT_TOKEN_INVALID` |
| T4 | 无 Authorization header 返回 401 | 401 + `AGENT_TOKEN_MISSING` |
| T5 | disabled workstation 返回 403 | status=disabled → 403 + `WORKSTATION_DISABLED` |
| T6 | revoked token 返回 401 | agent_token_revoked_at 不为空 → 401 |
| T7 | Agent Token 不能访问 `/api/cloud/*` | 请求 `/api/cloud/tenant` → 401 |
| T8 | 用户 JWT 不能访问 `/agent/*` | 请求 `/agent/me` → 401 |
| T9 | tenant 隔离正确 | 不同 tenant 的 token 不能跨租户鉴权 |
| T10 | token last_used_at 正常更新 | 每次鉴权成功后更新 |
| T11 | 轮换后旧 token 立即失效 | 旧 token 鉴权返回 401 |
| T12 | 创建 workstation 时检查 max_workstations | 超过限制返回 400 |

### 11.2 测试文件建议

```
backend/auth/__tests__/agentToken.test.ts       # hashAgentToken, generateAgentToken, verifyAgentToken
backend/auth/__tests__/agentAuth.test.ts        # requireAgent 中间件
backend/auth/__tests__/agentTokenIsolation.test.ts  # Agent Token 与 用户 JWT 隔离
```

---

## 12. 与现有文档的一致性

### 12.1 与 Phase 4-A 对齐

| Phase 4-A 设计 | Phase 4-B 落地 |
|----------------|---------------|
| 用户 JWT 与 Agent Token 分离 | 本文档 §2 明确路径隔离和中间件分离 |
| workstation 字段设计 | 本文档 §4 基于现有 workstations 表补充字段 |
| AgentPrincipal 类型 | 本文档 §3 基于现有类型补充 siteId |
| Agent Token 生成/撤销/轮换 | 本文档 §5 完整设计 |
| `/agent/*` 鉴权 | 本文档 §6 完整设计 |

### 12.2 与现有代码对齐

| 现有代码 | 本文档 |
|----------|--------|
| `backend/auth/types.ts` AgentPrincipal | 继承，补充 `siteId?` |
| `backend/auth/agentAuth.ts` requireAgent 占位 | 完整实现设计 |
| `backend/auth/authMiddleware.ts` | 不修改，仅处理用户 JWT |
| `database/migrations/001` workstations 表 | 补充字段设计 |
| `backend/db/PgDatabase.ts` getWorkstationById | 新增 getWorkstationByTokenHash 等方法 |

---

## 13. 本阶段禁止事项确认

本阶段（Phase 4-B）**仅设计，不实现完整 Agent 闭环**。以下事项已确认未执行：

- [x] 不写 Local Agent 程序
- [x] 不做任务拉取
- [x] 不做任务执行
- [x] 不做心跳闭环
- [x] 不改 BrowserPool
- [x] 不改 PlaywrightRuntime
- [x] 不改 AssignmentEngine
- [x] 不删除 EasyBR
- [x] 不迁移 settings.json
- [x] 不做前端复杂 UI
- [x] 不触碰 V2
- [x] 不执行数据库 migration（仅设计，Phase 4-C/4-D 再执行）