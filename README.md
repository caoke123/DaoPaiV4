# DaoPai V2

DaoPai V2（目录名 `bnsyV2`）是 DaoPai 网点操作系统的独立升级项目。

- 本项目**不依赖 EasyBR**（legacy 代码保留待替换）。
- 本项目**不影响 V1 生产项目**（`bnsy-operator`）。
- 本项目使用**独立前端、后端、数据库、runtime、配置和 Git 仓库**。
- 本项目使用 **Playwright 原生管理浏览器窗口**，后续将增加会员隔离系统。

> **命名约定：**
> - **V1** = `bnsy-operator` = 旧版 / EasyBR 生产稳定版（只读参考，严禁修改）
> - **V2** = `bnsyV2` = 新版 / Playwright Chrome 改造版（后续开发主线）
>
> ⚠️ 原 EasyBR 时代的开发支撑文档已统一归档至 [`archive-legacy-docs/`](./archive-legacy-docs/)，仅作历史存档，不作为本项目开发依据。新项目指导文档位于 [`docs/`](./docs/)。

---

## 快速开始

### 1. 启动 PostgreSQL + Redis（Docker）

```bash
cd bnsyV2
docker compose up -d postgres redis
```

### 2. 启动后端

```bash
npm install
npm run dev
# 后端运行在 http://localhost:3300
```

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
# 前端运行在 http://localhost:5176
```

### 4. 安装 Playwright 浏览器（Playwright 模式使用）

```bash
npx playwright install chromium
```

### 5. 切换 Runtime 模式

> **Phase 4-A 起：V2 测试主运行模式为 `playwright`（真实 Chrome），`legacy_easybr` 退为备用回退路径。**

**V2 推荐测试启动（playwright 模式）：**

`.env` 文件已默认设置 `WINDOW_RUNTIME_MODE=playwright`，直接启动即可：

```bash
npm run dev
# runtimeMode=playwright（由 .env 加载）
```

**回退到 legacy 模式（备用）：**

```powershell
# 修改 .env 文件：WINDOW_RUNTIME_MODE=legacy_easybr
# 或通过 PowerShell 环境变量覆盖
$env:WINDOW_RUNTIME_MODE="legacy_easybr"; npm run dev
```

**安全保障：** `getRuntimeMode()` 代码默认值仍是 `legacy_easybr`，env 配错或未设置时安全回退。legacy 路径（BrowserPool / EasyBRClient）完整保留，未删除。

详见 [V2 启动调试回滚指南](./docs/v2-start-debug-rollback-guide.md)。

---

## 资源隔离一览

| 资源 | V1 / bnsy-operator | V2 / bnsyV2 | V3 / DaoPaiV3 |
| --- | --- | --- | --- |
| 前端端口 | 5173 | 5275 | **5176** |
| 后端端口 | 3100 | 3200 | **3300** |
| PostgreSQL 端口 | 5434 | 5435 | **5436** |
| Redis 端口 | 6379 | 6380 | **6381** |
| 数据库名 | bnsy_operator | daopai_next | **daopai_v3** |
| DB 用户 | bnsy | daopai | **daopai** |
| Docker 容器名 | bnsy-* | daopai-next-* | **daopai-v3-*** |
| Docker volume | （bind mount） | daopai_next_* | **daopai_v3_*** |
| runtime 根目录 | logs/ + screenshots/ | **runtime/**（profiles/screenshots/logs/downloads） |
| settings.json | bnsy-operator/data/settings.json | **bnsyV2/data/settings.json** |
| 浏览器管理 | EasyBR 指纹浏览器 | **Playwright 原生**（legacy EasyBR 代码保留待替换） |
| GitHub 仓库 | 原仓库（已解绑） | **待用户新建** |

---

## 目录结构

```
bnsyV2/
├── backend/                    # 后端源码（TypeScript + Express + Playwright）
│   ├── api/                    # REST 路由
│   ├── browser/                # 浏览器池、导航、弹窗、会话管理（含 legacy EasyBR）
│   ├── config/                 # SettingsManager + credentials 兜底 + runtimeMode
│   ├── db/                     # Database（JSON/SQLite）+ PgDatabase（PostgreSQL）
│   ├── easybr/                 # ⚠️ LEGACY: EasyBR 集成（待替换为 Playwright 原生）
│   ├── modules/                # AssignmentEngine + Handlers
│   ├── operations/             # 到件/派件/签收/到派一体扫描业务
│   ├── playwright-runtime/     # Playwright 原生运行时（PlaywrightRuntime / P0Verifier / pocRoutes）
│   ├── window-adapter/         # PlaywrightWindowAdapter（Engine 层接入）
│   ├── runtime/                # RuntimeMetrics
│   ├── screenshots/            # 异常截图
│   ├── types/                  # API 契约
│   ├── utils/                  # Logger / TaskEventBus / TaskLogManager
│   └── index.ts                # 后端入口（端口 3200）
├── frontend/                   # 前端源码（React + Vite + Tailwind）
│   └── src/
├── database/
│   ├── schema/                 # init-schema.sql（PostgreSQL 建表脚本）
│   ├── migrations/             # 预留：后续迁移脚本
│   └── seed/                   # 预留：后续种子数据
├── runtime/                    # 运行时数据（与 V1 隔离）
│   ├── profiles/               # Playwright 浏览器 profile（持久化 context）
│   ├── screenshots/            # 自动截图
│   ├── logs/                   # 操作日志 JSONL
│   └── downloads/              # 下载文件
├── data/                       # 本地配置数据（settings.json / db.json）
├── docs/                       # 新项目指导文档
├── archive-legacy-docs/        # 原 EasyBR 时代历史文档（仅存档，不作开发依据）
├── scripts/                    # 维护脚本 + 验证脚本
├── docker-compose.yml          # 容器编排（daopai-next-* 前缀）
├── Dockerfile                  # 后端镜像构建
├── .env.example                # 环境变量模板
├── .env                        # 本地环境变量（不提交）
├── .gitignore
├── package.json                # 后端依赖与脚本
├── tsconfig.json               # TypeScript 配置（rootDir: ./backend）
└── vitest.config.ts            # 测试配置
```

---

## 当前阶段

### 已完成

- ✅ **Phase 0**：项目初始化与全面隔离（端口/数据库/Docker/runtime/配置）
- ✅ **Phase 1**：Playwright 原生浏览器 POC（launchPersistentContext + session 持久化）
- ✅ **Phase 2-A/B/C**：PlaywrightWindowAdapter 设计与实现 + Engine 层接入方案设计
- ✅ **Phase 2-D**：sign 任务接入 Playwright Runtime（Engine 层 + WINDOW_RUNTIME_MODE 开关）
- ✅ **Phase 2-D-Run**：真实 Chrome 可视化端到端验收（channel=chrome, headless=false, P0 前置, 密码弹窗禁用）
- ✅ **Phase 2-E**：arrival / dispatch / integrated 批量接入 Playwright Runtime（46/46 检查通过）
- ✅ **Phase 3**：全链路回归与生产化收敛（文档统一 / 启动指南 / 异常路径验证 / 生产前清单）
- ✅ **Phase 4-A**：Playwright 主运行模式启用，legacy 退为备用（.env 设置 playwright，代码默认值仍为 legacy_easybr）
- ✅ **Phase 4-B**：Header runtimeMode 适配 + Chrome READY 守卫 + 单标签页 + P0 passed 作为 READY 标准 + PostgreSQL Docker 独立配置 + 任务中心 HTTP 500 修复
- ✅ **Phase 4-C**：任务执行后任务中心持久化修复（4 个根因：sites FK / tasks.type CHECK / task_logs.id UUID / waybill_results.status CHECK）

### 当前版本状态（基线）

- Playwright 主运行模式已通过人工验证
- Header READY / P0 守卫已通过
- legacy_easybr 保留为备用回退
- V2 PostgreSQL Docker 数据库独立运行（容器 `daopai-next-postgres`，端口 5435）
- 任务执行链路 PG 持久化已通过（arrival / dispatch / integrated / sign 四类任务均能在任务中心显示）
- 任务中心 HTTP 500 已修复

### 已验证模块

| 模块 | taskType | Playwright Runtime | 真实 Chrome | P0 前置 | 窗口复用 |
|------|----------|--------------------|-------------|---------|----------|
| 签收录入 | sign | ✅ | ✅ | ✅ | ✅ |
| 到件扫描 | arrival | ✅ | ✅ | ✅ | ✅ |
| 派件扫描 | dispatch | ✅ | ✅ | ✅ | ✅ |
| 到派一体 | integrated | ✅ | ✅ | ✅ | ✅ |

详细路线图见 [`docs/upgrade-plan.md`](./docs/upgrade-plan.md)。

---

## 开发约束

所有贡献者必须遵守 [`docs/development-rules.md`](./docs/development-rules.md)。核心约束：

1. 本项目是 `bnsyV2`（V2），不是 `bnsy-operator`（V1）。
2. 本项目不使用 EasyBR（legacy 代码保留待替换，通过 WINDOW_RUNTIME_MODE 控制）。
3. 本项目不读取、不引用、不修改 `bnsy-operator/`（V1）。测试脚本可只读 V1 的 `data/settings.json`。
4. 本项目不复用 V1 数据库、端口、runtime、settings.json、GitHub 仓库。
5. 本项目浏览器运行层目标是 Playwright 自管窗口。
6. V1 EasyBR 文档均为历史资料，不作为本项目开发依据。
7. `WINDOW_RUNTIME_MODE` 代码默认值必须是 `legacy_easybr`（安全保障）。Phase 4-A 起 V2 测试环境通过 `.env` 显式设置为 `playwright`，使 Playwright 成为测试主模式；legacy 路径完整保留为备用回退。

---

## V1/V2 数据关系

- V2 测试脚本允许**只读** `../bnsy-operator/data/settings.json`（提取测试网点/员工信息）
- V2 业务代码**不得** import V1 代码
- V2 运行时**不得**依赖 V1 的 EasyBR / 数据库 / 端口
- 严禁修改 V1（`bnsy-operator/`）

---

## Git 状态

本项目已解除 V1 GitHub remote 绑定，使用独立 GitHub 仓库：

```
https://github.com/caoke123/bnsyv2.git
```

首次推送：

```bash
cd bnsyV2
git init
git add .
git commit -m "chore: save DaoPai V2 playwright baseline"
git remote add origin https://github.com/caoke123/bnsyv2.git
git push -u origin main
```

**严禁**使用 V1 GitHub 地址 `caoke123/bnsy` 或任何 V1 关联仓库。

### 部署前安全检查

- `.env` 已在 `.gitignore` 中（不会提交，复制 `.env.example` 后填入本机值）
- `data/settings.json` 已在 `.gitignore` 中（不会提交，参考 `data/settings.example.json`）
- `backend/config/credentials.ts` 已在 `.gitignore` 中（不会提交，参考 `credentials.example.ts`）
- `runtime/profiles/` `runtime/screenshots/` `runtime/logs/` 均已忽略
- 真实账号密码严禁写入代码或文档（测试中应使用 mock 占位符）
