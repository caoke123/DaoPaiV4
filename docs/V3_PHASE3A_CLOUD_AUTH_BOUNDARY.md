# DaoPai V3 Phase 3-A Cloud Platform 认证边界设计

## 1. 模块边界

```
┌─────────────────────────────────────────────────────┐
│                    Cloud Platform                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ 用户管理  │  │ 租户管理  │  │ 任务中心 / 日志中心 │  │
│  │ JWT 登录  │  │ 设备管理  │  │ 统计 / 监控      │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│                      │                               │
│              /api/* 用户接口                          │
└──────────────────────┼──────────────────────────────┘
                       │
┌──────────────────────┼──────────────────────────────┐
│                 Local Agent                           │
│  ┌──────────────────────────────────────────────┐   │
│  │ Agent Token 鉴权 → /agent/* 接口              │   │
│  │ 负责本地执行（BrowserPool / Playwright）        │   │
│  │ 不走普通用户登录                                │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## 2. 认证分离

### 用户认证（User Auth）

- 入口：`/api/*` Web 操作接口
- 方式：`Authorization: Bearer <jwt>`
- 认证结果：`UserPrincipal { userId, tenantId, role }`
- 未来支持 JWT + Refresh Token 双 Token 机制

### Agent 鉴权（Agent Auth）

- 入口：`/agent/*` 本地执行接口
- 方式：`X-Agent-Token: <token>` 或 `Authorization: Bearer <agentToken>`
- 认证结果：`AgentPrincipal { tenantId, workstationId }`
- Agent 不是普通用户，不访问 Cloud Web，不参与登录

### 匿名访问（Anonymous）

- 当前阶段：无 Token 时默认匿名
- 后续阶段：可限制匿名访问范围（如仅允许健康检查）

## 3. 角色定义

| 角色 | 标识 | 权限范围 |
|---|---|---|
| `super_admin` | 平台超级管理员 | 全平台管理，跨租户 |
| `tenant_admin` | 租户管理员 | 管理本租户网点、设备、操作员 |
| `operator` | 网点操作员 | 执行任务、查看本网点数据 |
| `agent` | 本地执行端 | 接收任务、上报状态、心跳 |

注意：`agent` 不是 RBAC 角色，是独立的 `PrincipalType`。

## 4. 类型定义

```ts
type UserRole = 'super_admin' | 'tenant_admin' | 'operator';
type PrincipalType = 'user' | 'agent' | 'anonymous';

interface UserPrincipal {
  type: 'user';
  userId: string;
  tenantId: string;
  role: UserRole;
}

interface AgentPrincipal {
  type: 'agent';
  tenantId: string;
  workstationId: string;
}

interface AnonymousPrincipal {
  type: 'anonymous';
}

type Principal = UserPrincipal | AgentPrincipal | AnonymousPrincipal;
```

## 5. 中间件顺序

```
shutdownGuard    → 拒绝停机期间新请求
authMiddleware   → 注入 req.principal（当前匿名）
requestContext   → 注入 req.tenantId / req.workstationId / req.requestId
router           → 业务路由
```

当前 `authMiddleware` 只注入 `{ type: 'anonymous' }`，不影响 `requestContext` 的默认注入。

## 6. 当前行为

- 无 JWT 登录，无 Agent Token 鉴权
- `req.principal = { type: 'anonymous' }`
- `req.tenantId = 'tenant-default'`（由 requestContext 注入）
- `req.workstationId = 'ws-local-default'`（由 requestContext 注入）
- 所有 `/api/*` 业务接口继续可用

## 7. 后续计划

| 阶段 | 内容 |
|---|---|
| Phase 3-B | 实现 JWT 登录 + Refresh Token |
| Phase 3-C | 实现 Agent Token 鉴权 |
| Phase 3-D | 实现角色权限控制（requireUser / requireRole） |
| Phase 3-E | 用户管理 / 租户管理后台 API |