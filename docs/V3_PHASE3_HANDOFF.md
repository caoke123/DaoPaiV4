# DaoPai V3 Phase 3 交接文档

> 最后更新：2026-06-29
> 最新 commit：`4f83515` — fix: protect frontend routes and simplify system navigation

---

## 1. 项目当前状态

### 构建状态

| 项目 | 命令 | 结果 |
|------|------|------|
| Backend | `npm run build` | 通过 |
| Frontend | `npm run build` | 通过 |
| Backend 测试 | `npm test` | 132 tests：128 passed，4 failed（ISSUE-008） |

### 运行方式

```bash
# 后端（端口 3300）
cd backend && npm run dev

# 前端（端口 5176）
cd frontend && npm run dev
```

### 环境变量

```bash
# 数据库
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/daopai_v3

# JWT
JWT_SECRET=<your-secret>

# Bootstrap 管理员
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<your-password>

# 认证保护开关
AUTH_REQUIRED=false   # 兼容模式（匿名可访问业务 API）
AUTH_REQUIRED=true    # 保护模式（需 Bearer JWT）
```

---

## 2. 前端页面说明

### 路由表

| 路由 | 页面 | 认证要求 | 说明 |
|------|------|----------|------|
| `/login` | LoginPage | 无需登录 | 唯一未登录可访问页面 |
| `/` | RootRedirect | 需登录 | 未登录 → `/login`，已登录 → `/arrival` |
| `/arrival` | ArrivalPage | 需登录 | 到件扫描 |
| `/dispatch` | DispatchPage | 需登录 | 派件扫描 |
| `/integrated` | IntegratedPage | 需登录 | 到派一体 |
| `/sign` | SignPage | 需登录 | 签收录入 |
| `/tasks` | TasksPage | 需登录 | 任务中心 |
| `/system` | SystemManagementPage | 需登录 | 系统管理（3 个 Tab） |
| `/settings` | SettingsPage | 需登录 | 设置中心 |
| `/cloud` | LegacyRedirect | 需登录 | 旧路由 → `/system?tab=overview` |
| `/organization` | LegacyRedirect | 需登录 | 旧路由 → `/system?tab=organization` |
| `/users` | LegacyRedirect | 需登录 | 旧路由 → `/system?tab=users` |

### 路由保护机制

- `ProtectedRoute` 组件包裹所有业务页面
- 未登录自动跳转 `/login`，携带 `location.state.from` 记录来源路径
- 登录成功后回跳原页面，无来源默认 `/arrival`
- `/login` 已登录用户自动跳转 `/arrival`

### 侧边栏导航

```
执行中心
  - 到件扫描
  - 派件扫描
  - 到派一体
  - 签收录入
────────────────
监控中心
  - 任务中心
────────────────
系统                    ← 仅 super_admin / tenant_admin 可见
  - 系统管理
  - 设置中心
```

### 角色权限

| 角色 | 系统分区 | 系统管理 | 设置中心 |
|------|----------|----------|----------|
| super_admin | 可见 | 可见 | 可见 |
| tenant_admin | 可见 | 可见 | 可见 |
| operator | 隐藏 | 隐藏 | 隐藏 |

---

## 3. 后端接口说明

### 认证接口（无需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录，返回 accessToken + refreshToken |
| GET | `/api/auth/me` | 验证 token，返回当前用户信息 |
| POST | `/api/auth/refresh` | 刷新 access token |
| POST | `/api/auth/logout` | 撤销 refresh token |

### 业务接口（AUTH_REQUIRED=true 时需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/operations/arrive` | 执行到件扫描 |
| POST | `/api/operations/dispatch` | 执行派件扫描 |
| POST | `/api/operations/integrated` | 执行到派一体 |
| POST | `/api/operations/sign` | 执行签收录入 |
| POST | `/api/windows/init` | 初始化窗口 |
| GET | `/api/operations/stats` | 任务统计 |
| GET | `/api/tasks/:id/logs` | 任务日志 |
| GET | `/api/tasks/:id/summary` | 任务摘要 |

### 系统管理接口（需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 后端存活 + 运行时状态 |
| GET | `/api/cloud/tenant` | 当前租户信息 |
| GET | `/api/cloud/sites` | 站点列表 |
| GET | `/api/cloud/workstations` | 工作站列表 |
| GET | `/api/cloud/users` | 用户列表 |

### 设置中心接口（需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/settings/config` | 获取配置（密码 Base64 解码） |
| PUT | `/api/settings/config` | 保存配置（需 PIN 验证） |
| POST | `/api/settings/verify-pin` | 验证 PIN |
| GET | `/api/settings/data-retention` | 数据保留策略 |
| PUT | `/api/settings/data-retention` | 更新数据保留策略 |
| GET/PUT | `/api/runtime/mode` | 运行模式（试运行/真实） |

### 运行时状态（始终可用）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 返回 `{ alive, authRequired, runtime, runtimeError }` |

---

## 4. 数据来源说明

```
┌─────────────────────────────────────────────────────────┐
│                    PostgreSQL (云端)                       │
│  tenants / users / refresh_tokens / workstations          │
│  sites (只读同步) / tasks / task_logs / waybill_results   │
│  waybill_pool / metrics_snapshots                         │
└─────────────────────────────────────────────────────────┘
                           ↑
                    认证、任务、运单
                           │
┌─────────────────────────────────────────────────────────┐
│                  settings.json (本地)                      │
│  网点 / 员工窗口 / 账号密码 / 浏览器绑定 / 运行模式        │
│                     数据保留策略                           │
└─────────────────────────────────────────────────────────┘
                           ↑
                  设置中心读写 (真理源)
                           │
┌─────────────────────────────────────────────────────────┐
│              credentials.ts (legacy 兜底)                  │
│  占位数据 (员工A/B/C/D)，仅当 settings.json 找不到时使用    │
│  ISSUE-008：不应作为生产配置来源                           │
└─────────────────────────────────────────────────────────┘
```

### 执行链路数据流

```
任务执行 (arrive/dispatch/integrated/sign)
  → SettingsManager.resolveWorkerCredential()
    → 1. settings.json (优先，按 browserId 或 staffName 匹配)
    → 2. credentials.ts (兜底，占位数据)
  → BrowserPool.getLoginCredential()
    → settings.json (按 browserId 匹配)
    → credentials.ts (兜底)
```

---

## 5. 登录与权限说明

### JWT 认证流程

```
1. 前端启动 → 读取 localStorage token
2. 有 token → GET /api/auth/me → 验证成功 → isAuthenticated=true
3. 验证失败 → 清空 token → isAuthenticated=false
4. 无 token → isAuthenticated=false
5. 业务请求 → fetchWithAuth 自动附 Bearer token
6. 401 → 自动 refresh → 重新请求
7. refresh 失败 → 清空 token → 跳转 /login
```

### Token 规格

| 类型 | 有效期 | 存储位置 |
|------|--------|----------|
| accessToken (JWT) | 15 分钟 | 内存 + localStorage |
| refreshToken | 7 天 | localStorage |
| refreshToken hash | — | PostgreSQL refresh_tokens 表 |

### 角色定义

| 角色 | 数据库值 | 权限 |
|------|----------|------|
| 超级管理员 | super_admin | 全部权限 + 系统管理入口 |
| 租户管理员 | tenant_admin | 全部权限 + 系统管理入口 |
| 操作员 | operator | 执行功能，无系统管理入口 |

---

## 6. 设置中心说明

### 功能

- **网点管理**：新增/重命名/删除网点
- **员工窗口**：每个网点下的员工姓名、登录账号、登录密码
- **运行模式**：试运行模式 / 真实执行模式
- **数据管理**：任务记录保留天数、自动清理频率

### 安全机制

- 保存配置需 PIN 验证（SHA-256 加盐哈希）
- 密码 Base64 编码存储（非明文）
- 原子写入（.tmp → rename）防断电损坏

### 数据流

```
SettingsPage 保存
  → PUT /api/settings/config
    → SettingsManager.updateConfig()
      → 密码 Base64 编码
      → 原子写入 data/settings.json
      → 异步同步 PG sites 表 (best-effort)
```

---

## 7. 已知问题

| 编号 | 问题 | 级别 | 处理 |
|------|------|------|------|
| ISSUE-008 | credentials.ts 占位数据导致 4 个 fallback 测试失败 | P2 | 后续通过 mock 或清理 fallback 解决 |
| EasyBR 依赖 | V2 残留，V3 前端已隐藏用户文案 | P2 | Local Agent 链路稳定后专项删除 |
| settings.json 上云 | 网点/员工/密码仍在本地 | P3 | 等 Local Agent 设计明确后处理 |
| PG sites 同步 | best-effort，失败不阻塞设置保存 | 信息 | 执行链路直接读 settings.json，不受影响 |

---

## 8. 下一阶段建议

### Phase 4-A：Local Agent 边界设计

- 定义 Local Agent 与 Cloud 的通信协议
- Agent 注册、心跳、任务分配流程
- 确定 workstation 与 Agent 的绑定关系

### Phase 4-B：Agent Token 鉴权设计

- Agent Principal 的 token 类型和签发流程
- 与现有 JWT 用户认证的隔离
- Agent Token 的权限范围（仅限任务执行，不可访问管理接口）

### Phase 4-C：workstation 与本地执行端绑定

- workstation 注册时关联 Agent
- 本地执行端状态上报
- workstation 在线状态管理

### Phase 4-D：浏览器执行配置边界拆分

- Cloud 侧：workstation 配置、站点绑定
- settings.json 侧：本地浏览器窗口绑定、账号密码
- Agent 侧：本地执行端参数、浏览器启动参数

### EasyBR 删除专项

- 放在 Local Agent / Playwright 执行链路稳定后进行
- 当前 V3 前端已隐藏 EasyBR 用户文案
- 后端代码中 EasyBR 引用暂保留

---

## 9. 禁止事项

以下操作在当前阶段**严禁执行**：

- 删除 EasyBR 依赖
- 修改 settings.json 结构
- 修改 BrowserPool / PlaywrightRuntime
- 修改 READY / LOGIN / P0 判断逻辑
- 触碰 V2 目录
- 新增/编辑/删除租户、站点、工作站、用户 CRUD
- 新增复杂 RBAC
- 新增 Agent Token
- 大规模迁移 settings.json 到 PostgreSQL