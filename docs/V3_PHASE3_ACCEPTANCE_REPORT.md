# DaoPai V3 Phase 3 总体验收报告

## 1. Phase 3 总体验收结论

**验收通过。** Phase 3 成功建立了 Cloud Auth Boundary（云端认证边界），实现了最小 JWT 登录基础、业务 API 认证保护开关、前端登录闭环、后端与浏览器运行时解耦，以及 Cloud 管理入口（系统管理、设置中心）。

系统当前可正常构建、测试、运行，4 个已知测试失败（ISSUE-008）与 Phase 3 无关，不阻塞验收。

---

## 2. 各阶段完成项

### Phase 3-A：Cloud Auth Boundary

- Principal 类型体系：`UserPrincipal` / `AgentPrincipal` / `AnonymousPrincipal`
- 用户认证与 Agent 鉴权分离
- `authMiddleware`：验证 JWT 并注入 `req.principal`
- `requestContext`：从 `UserPrincipal.tenantId` 注入 `req.tenantId`

### Phase 3-B / 3-B-1：最小 JWT 登录基础

- `users` 表：`tenant_id`, `username`, `password_hash`, `role` (super_admin/tenant_admin/operator), `status` (active/disabled)
- `refresh_tokens` 表：`token_hash`, `expires_at`, `revoked_at`
- 密码加盐哈希（scrypt）
- JWT access token（15 分钟）+ refresh token（7 天）
- 接口：`POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/refresh`, `POST /api/auth/logout`
- Bootstrap admin 用户（环境变量）
- Auth 测试基线：7 组 59 tests

### Phase 3-C：业务 API 认证保护开关

- `AUTH_REQUIRED` 环境变量：`false`（兼容模式，允许匿名）/ `true`（保护模式，需 Bearer JWT）
- `requireUserIfAuthRequired` 中间件
- JWT `tenantId` 进入 `requestContext`

### Phase 3-D：前端登录闭环

- `/login` 页面：用户名 + 密码表单，loading 状态，错误提示
- `AuthProvider`：token 持久化（localStorage），启动时 `/api/auth/me` 验证
- `fetchWithAuth`：自动附 `Authorization: Bearer`，401 自动 refresh
- Header 显示当前用户名和退出按钮
- 退出清空 token + 跳转 `/login`

### Phase 3-D-2 / D-3：运行时解耦与提示

- 后端不再因浏览器运行时（BrowserPool/EasyBR）初始化失败而退出
- `RuntimeStatus`：available / unavailable / degraded
- 执行接口（arrive/dispatch/integrated/sign/init）在运行时不可用时返回 503 JSON
- 前端显示本地运行环境提示（橙色 banner），30 秒轮询
- 前端不显示 EasyBR 用户文案

### Phase 3-E / F / G：Cloud 管理入口

- `/system` 系统管理页面：系统总览、组织与站点、用户信息三个 Tab
- 租户/站点/工作站/用户只读（从 PostgreSQL 查询，tenant_id 过滤）
- 按角色显示系统入口：super_admin / tenant_admin 可见，operator 隐藏
- 设置中心命名恢复："系统设置" → "设置中心"
- `/cloud` → `/system?tab=overview`，`/organization` → `/system?tab=organization`，`/users` → `/system?tab=users`

### Phase 3-G-2：未登录路由保护

- `ProtectedRoute` 组件：未登录自动跳转 `/login`（携带 from 路径）
- 根路径 `/` 未登录 → `/login`，已登录 → `/arrival`
- 登录成功后回跳原页面
- `/login` 是唯一未登录可访问页面

### Phase 3-H / I：设置中心审计

- `/settings` 设置中心可用，全中文显示
- `data/settings.json` 是业务配置真理源
- 网点/员工/密码/运行模式/数据保留策略均在 settings.json
- credentials.ts 仅占位兜底

---

## 3. 构建与测试结果

| 项目 | 结果 |
|------|------|
| Backend `npm run build` | 通过 |
| Frontend `npm run build` | 通过 |
| Backend `npm test` | 132 tests：128 passed，4 failed |

### 测试失败详情

4 个失败均为 **ISSUE-008**（credentials.ts 占位数据导致 fallback 测试失败）：

| 测试文件 | 失败数 | 原因 |
|----------|--------|------|
| `loginCredential.test.ts` | 3 (C2b, C4, C5) | `findCredential()` 返回 undefined（占位数据无刘磊、肖飞） |
| `resolveWorkerCredential.test.ts` | 1 (T3) | 同上 |

**结论：与 Phase 3 无关，不阻塞验收。** settings.json 优先路径（C1/C2/C3/C6/C7, T1/T2/T4/T5/T6/T7）均验证通过。

---

## 4. 人工验证结果

| 验证项 | 结果 |
|--------|------|
| 未登录访问 `/` → 跳转 `/login` | 通过 |
| 未登录访问 `/arrival` → 跳转 `/login` | 通过 |
| 未登录访问 `/dispatch` → 跳转 `/login` | 通过 |
| 未登录访问 `/tasks` → 跳转 `/login` | 通过 |
| 未登录访问 `/system` → 跳转 `/login` | 通过 |
| admin 登录成功 | 通过 |
| 登录后进入 `/arrival` | 通过 |
| 未登录 → `/tasks` → 登录后回到 `/tasks` | 通过 |
| `/system` 三个 Tab 正常（系统总览/组织与站点/用户信息） | 通过 |
| `/settings` 设置中心可访问 | 通过 |
| 侧边栏显示"系统管理"和"设置中心" | 通过 |
| admin 可见系统分区，operator 隐藏 | 通过 |
| `/cloud` → `/system?tab=overview` | 通过 |
| `/organization` → `/system?tab=organization` | 通过 |
| `/users` → `/system?tab=users` | 通过 |
| 页面不出现 EasyBR 字样 | 通过 |
| 设置中心不显示窗口 ID | 通过 |
| 退出登录后无法访问业务页面 | 通过 |

---

## 5. 数据边界

### PostgreSQL 当前负责

```
tenants          — 租户/机构信息
users            — 用户登录认证
refresh_tokens   — JWT refresh token
workstations     — 工作站注册信息
sites            — 站点名称同步副本（只读）
tasks            — 任务记录
task_logs        — 任务执行日志
waybill_results  — 运单结果
waybill_pool     — 运单池
metrics_snapshots — 指标快照
```

### settings.json 当前负责

```
网点配置 (sites)
员工窗口配置 (windows)
登录账号 (username)
登录密码 (password, Base64)
浏览器窗口绑定 (easybrBrowserId)
试运行模式 (dryRunMode)
数据保留策略 (dataRetention)
```

### credentials.ts 当前状态

```
仅 legacy fallback
当前为占位数据（员工A/B/C/D）
不应作为生产配置来源
对应 ISSUE-008
```

---

## 6. 已知问题

| 编号 | 问题 | 级别 | 阻塞 | 处理 |
|------|------|------|------|------|
| ISSUE-008 | credentials.ts 占位数据导致 4 个 fallback 测试失败 | P2 | 否 | Phase 3 不修复，后续通过 mock 或清理 fallback 解决 |
| EasyBR 依赖 | V2 残留，V3 前端已隐藏用户文案 | P2 | 否 | Local Agent / Playwright 链路稳定后专项删除 |
| settings.json 上云 | 网点/员工/密码仍在本地配置文件 | P3 | 否 | 等 Local Agent 设计明确后处理 |

---

## 7. 是否可进入 Phase 4

**是。** Phase 3 核心目标全部达成：

- 认证边界建立（JWT + AUTH_REQUIRED 开关）
- 前端登录闭环完整
- 后端与运行时解耦
- Cloud 管理入口（系统管理 + 设置中心）可用
- 未登录路由保护完善
- 构建与测试稳定（4 个已知失败不影响功能）

建议 Phase 4 方向：
- 4-A：Local Agent 边界设计
- 4-B：Agent Token 鉴权设计
- 4-C：workstation 与本地执行端绑定
- 4-D：浏览器执行配置从 Cloud / settings.json / Agent 的边界拆分

---

## 8. 未修改执行内核

本阶段仅文档工作，未修改 BrowserPool / PlaywrightRuntime / READY / LOGIN / P0。

## 9. 未触碰 V2

未触碰 V2 目录。