# DaoPai V3 Phase 0 已知问题与处理意见

## 1. 当前阶段结论

DaoPai V3 初始化冒烟测试已通过。
当前问题均不阻塞 V3 进入 SaaS 架构设计阶段。
本阶段不进行代码修复，仅记录问题和后续处理策略。

已通过项：

- V3 前端 5176 启动成功
- V3 后端 3300 启动成功
- V3 PostgreSQL 5436 / daopai_v3 启动成功
- V3 Redis 6381 启动成功
- settings.json 可读取
- 天南大 / 和苑配置可同步
- 前端页面 /arrival、/settings、/tasks 可访问
- API 请求未误连 V2
- 前后端 build 通过
- Git 工作区干净

## 2. 已知问题列表

| 编号 | 问题 | 级别 | 是否阻塞 | 当前处理 | 后续建议 |
| -- | -- | -- | ---- | ---- | ---- |
| ISSUE-001 | better-sqlite3 原生编译失败 | P1 | 否（dev 模式） | 不修复，用 --ignore-scripts 绕过 | 数据存储依赖收敛阶段处理 |
| ISSUE-002 | BrowserPool 本地连接失败日志 | P1 | 否 | 不修复 | Cloud / Agent 拆分阶段处理 |
| ISSUE-003 | docker-compose version 字段过时警告 | P3 | 否 | 不处理 | 云端 Docker 部署整理阶段移除 |
| ISSUE-004 | favicon.ico 404 | P3 | 否 | 不处理 | UI/品牌资源整理阶段补 favicon |
| ISSUE-005 | 前端 bundle 超过 500kB 提示 | P3 | 否 | 不处理 | 前端性能优化阶段处理 |
| ISSUE-006 | 未知 API 路径超时 | P2 | 否 | 不修复 | Cloud API 网关和错误处理阶段统一处理 |
| ISSUE-007 | 源码中仍有 Phase 3 / Phase 4 历史注释 | P3 | 否 | 保留 | 文档/注释清理阶段单独处理 |

---

### ISSUE-001：better-sqlite3 原生编译失败

现象：

```text
npm install 失败，better-sqlite3 原生编译需要 Visual Studio C++ Build Tools。
当前 Node v22.18.0 环境下未找到可用预编译二进制。
使用 npm install --ignore-scripts 可绕过。
```

判断：

```text
当前 dev 模式不受影响。
Database.ts 中 better-sqlite3 仅在 production 模式动态 require。
V3 当前运行链路使用 JSON dev 模式 + PostgreSQL，冒烟测试通过。
```

影响：

```text
可能影响未来 Docker 构建、生产环境安装、新电脑初始化。
```

处理意见：

```text
当前不修复。
后续在 V3 数据存储依赖收敛阶段处理。
如果 V3 确定以 PostgreSQL 为主，可评估移除 SQLite / better-sqlite3 fallback。
也可评估升级 better-sqlite3 到支持当前 Node 版本预编译的版本。
```

建议归属阶段：

```text
Phase 后续：数据存储依赖收敛 / 生产部署准备阶段
```

---

### ISSUE-002：BrowserPool 本地连接失败日志

现象：

```text
后端启动时出现 BrowserPool 初始化失败：ECONNREFUSED 127.0.0.1:3001。
```

判断：

```text
本地浏览器相关服务未运行时出现该日志。
当前 runtimeMode=playwright，不影响 V3 前后端启动和页面访问。
V2 时代也存在类似表现。
```

影响：

```text
不会阻塞当前 V3 基线。
但未来 SaaS 化后，云端平台不应启动本地浏览器连接逻辑。
本地浏览器执行能力应属于 DaoPai Local Agent。
```

处理意见：

```text
当前不修复。
后续在 Cloud Platform / Local Agent 职责拆分时处理。
云端平台应避免启动本地 BrowserPool。
Local Agent 才负责本地浏览器检测和执行。
```

建议归属阶段：

```text
Phase 后续：Cloud / Agent 拆分阶段
```

---

### ISSUE-003：docker-compose version 字段过时警告

现象：

```text
docker compose 提示 version: "3.8" 字段过时。
```

判断：

```text
Docker Compose 新版本会忽略 version 字段。
不影响 PostgreSQL / Redis 启动。
```

处理意见：

```text
当前不处理。
后续整理 Docker 部署文件时可移除。
```

建议归属阶段：

```text
Phase 后续：云端 Docker 部署整理阶段
```

---

### ISSUE-004：favicon.ico 404

现象：

```text
前端页面出现 favicon.ico 404。
```

判断：

```text
纯 UI 资源缺失，不影响业务功能。
```

处理意见：

```text
当前不处理。
后续 UI 品牌化或前端整理时补 favicon。
```

建议归属阶段：

```text
Phase 后续：UI/品牌资源整理阶段
```

---

### ISSUE-005：前端 bundle 超过 500kB 提示

现象：

```text
vite build 提示部分 chunk size > 500kB。
```

判断：

```text
构建成功，仅为性能优化提示。
当前 V3 还处于架构迁移前阶段，不应优先处理。
```

处理意见：

```text
当前不处理。
后续前端性能优化时再考虑 code splitting / lazy loading。
```

建议归属阶段：

```text
Phase 后续：前端性能优化阶段
```

---

### ISSUE-006：未知 API 路径超时

现象：

```text
测试错误路径 /api/settings 时出现约 15s 超时，而不是快速 404。
正确路径 /api/settings/config 正常。
```

判断：

```text
前端实际使用正确 API，不影响当前功能。
但后续云端 API 化后，应统一错误处理中间件，避免错误路径长时间挂起。
```

处理意见：

```text
当前不修复。
后续 Cloud API 设计时统一处理 404 / timeout / error response。
```

建议归属阶段：

```text
Phase 后续：Cloud API 网关和错误处理阶段
```

---

### ISSUE-007：源码中仍有 Phase 3 / Phase 4 历史注释

现象：

```text
backend/api/windowRuntimeRoutes.ts
backend/api/routes.ts
backend/playwright-runtime/*.ts
backend/db/PgDatabase.ts
frontend/src/**

仍存在 Phase 3 / Phase 4 / Phase 4-B / Phase 4-C / Phase 4-I 等历史注释。
```

判断：

```text
这些是源码注释，不是运行配置，不影响 V3 启动。
当前不应为了清理注释去改动稳定业务代码。
```

处理意见：

```text
当前保留。
后续如有必要，单独做“注释去历史化”任务。
该任务只允许改注释，不允许改逻辑。
```

建议归属阶段：

```text
Phase 后续：文档/注释清理阶段
```

## 3. 当前不处理原则

```text
当前不要修复上述问题。
当前不要改业务逻辑。
当前不要改 BrowserPool。
当前不要改窗口状态。
当前不要改 READY / LOGIN 判断。
当前不要改任务执行链路。
当前不要改 settings.json 结构。
当前不要开始 tenantId / workstationId 改造。
当前不要开始 SaaS 拆分。
```

## 4. 优先级判断

```text
P1：better-sqlite3 原生依赖问题
P1：Cloud Platform / Local Agent 拆分后 BrowserPool 启动边界问题
P2：未知 API 路径超时
P3：docker-compose version warning
P3：favicon 404
P3：前端 bundle size
P3：源码历史注释
```

说明：

```text
P1 不代表现在立刻修，而是进入对应阶段前必须处理。
```

## 5. 后续处理路线

```text
Phase 1：先讨论并冻结 V3 SaaS 架构，不处理这些问题。
Phase 2：设计 Cloud Platform / Local Agent 边界时，处理 BrowserPool 启动边界。
Phase 3：设计数据存储和部署策略时，处理 better-sqlite3。
Phase 4：设计 Cloud API 时，处理未知 API 路径超时。
Phase 5：进入生产部署前，再处理 Docker warning / favicon / bundle / 注释清理。
```
