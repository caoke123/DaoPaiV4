# DaoPai V3 天南大现场部署手册

## 1. 部署目标

本版本为 DaoPai V3 稳定生产交付版，采用本地一体化运行方式，依赖 HTTP 轮询及 PlaywrightRuntime 的内存状态作为主链路，专为天南大现场业务定制，旨在提供稳定、可靠的派单环境。

## 2. 推荐部署架构

- **前端**：本地运行
- **后端**：本地运行
- **Agent**：本地运行
- **便携浏览器**：Portable Chrome 本地运行
- **数据库**：PostgreSQL 建议先本地 Docker 运行
- **数据保障**：数据库需每日备份

## 3. 电脑环境要求

- **操作系统**：Windows 10 / 11
- **运行时**：Node.js LTS (推荐 v18 或 v20)
- **数据库**：Docker Desktop 或本地 PostgreSQL 安装
- **网络**：需要稳定外网以连接 BNSY 系统
- **系统设置**：关闭自动休眠，防止任务运行中断
- **注意**：绝对不要删除 `runtime/profiles` 目录，否则将导致登录态丢失

## 4. 目录结构

建议按照如下目录结构进行部署：

```text
DaoPaiV3/
  backend/
  frontend/
  packages/agent/
  Chrome/
  runtime/profiles/
  runtime/logs/
  backend/data/settings.json
```

## 5. 环境配置

- 将 `backend/.env.example` 复制为 `backend/.env`
- 修改 `DATABASE_URL`，指向实际部署的 PostgreSQL 实例
- **重要保护**：`ENABLE_REAL_SUBMIT` 默认必须设为 `false`
- 仅在真实生产且通过人工验证后，才可将 `ENABLE_REAL_SUBMIT` 改为 `true`

## 6. settings.json 配置

- 将 `backend/data/settings.example.json` 复制为 `backend/data/settings.json`
- 也可以启动项目后，在前端的设置中心界面统一进行配置
- 配置天南大站点、员工窗口及账号信息
- **注意**：由于包含加密盐和可能存在的敏感信息，**不要把 `settings.json` 上传到 GitHub**

## 7. 数据库初始化

1. 创建 PostgreSQL 数据库实例及库名（如 `daopai_v3`）
2. 运行后端 Prisma migrations 初始化表结构
3. **重要清理**：
   - 交付前建议使用**全新数据库**。
   - 如果必须复用测试库，必须清理掉 `window_status` 表内的脏数据，避免测试时的 UUID 和离线状态影响生产：
     ```sql
     DELETE FROM window_status;
     ```
   - 如果测试过 V4 架构并留下了相关表，请删除：
     ```sql
     DROP TABLE IF EXISTS window_commands;
     ```
   - 正式交付库中绝不能带有 V4 的 `window_commands` 残留。

## 8. 启动顺序

请严格按照以下顺序启动：

1. 启动 PostgreSQL
2. 启动 `backend`
3. 启动 `frontend`
4. 启动 `Agent`
5. 在浏览器中打开系统页面 (如 `http://localhost:5175`)

## 9. 首次登录窗口

1. 在系统 Header 中点击启动对应的员工窗口
2. 窗口弹出后，人工在页面内完成 BNSY 登录
3. 确认登录成功并进入 Dashboard（仪表盘）页面
4. 观察系统 Header 状态是否变更为 **ready**
5. 关闭窗口然后再重启，确认无需再次输入账号密码（登录态保留成功）

## 10. 试运行模式

- 系统默认处于**试运行模式**（界面会有显著提示）。
- 该模式下，即使到达最后一步也**不会真实提交**任何单号数据。
- 强烈建议在部署验收时，先使用试运行模式完成全链路测试。

## 11. 真实生产模式

**【重要警告】**

- 必须确认真实单号和执行流程无误后，才可设置 `.env` 中的 `ENABLE_REAL_SUBMIT=true`，并重启后端。
- 初次进行真实操作时，建议采用 **1～3 单小批量测试**。
- 测试完成后，人工核对 BNSY 后台的结果是否准确。
- 确认完全无误后，再逐步放量至正常生产状态。

## 12. 日常使用流程

1. 启动整体系统（按启动顺序）
2. 检查 Header 中的窗口状态，确认所需员工窗口处于 **ready**
3. 在系统页面内创建任务（如到件、派件、一体等）
4. 通过前端实时日志区域查看任务执行进度
5. 通过 Task Center (任务中心) 查看历史记录与最终结果

## 13. 每日备份建议

为确保数据安全：

- 每天定时备份 PostgreSQL 数据库
- 备份 `backend/data/settings.json` 配置文件
- 备份最近的运行日志
- **不建议**将 Chrome profile (包含敏感登录态) 备份或上传到 GitHub

## 14. 常见问题

- **Header 不 ready**：检查窗口是否停留在登录页、页面是否被重定向，或者是否之前意外崩溃未清理状态。
- **窗口打不开**：检查 Chrome 路径是否正确，或是否已有残留的僵尸 Chrome 进程占用该 profile。
- **窗口关闭失败**：可手动在任务管理器结束 Chrome 进程，然后等待前端自动恢复为 offline。
- **任务卡 running**：重启后端，后端在启动时会自动将僵尸任务回退为 failed。
- **数据库连接失败**：检查 `.env` 中的 `DATABASE_URL` 账号密码及端口是否正确。
- **登录态失效**：可能是 BNSY 强制下线，或 profile 文件夹被移动/删除，需重新人工登录一次。
- **真实提交被拦截**：说明 `ENABLE_REAL_SUBMIT` 未设置为 `true`，请修改 `.env` 后重启后端。

## 15. 回滚方案

如果在使用中遇到不可恢复的问题：

- 通过 GitHub release tag 下载并恢复上一稳定版本。
- 还原上一版本的 `settings.json` 及 `.env`。
- 如果数据库表结构损坏，可通过备份文件恢复 PostgreSQL 数据库。
