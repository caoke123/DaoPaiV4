# DaoPai V3 交付前全链路稳定性审查报告

## 1. 审查结论
经过静态代码审查、配置检查与全链路逻辑梳理，DaoPai V3 稳定版整体状态良好，未发现阻碍交付的 P0 级代码架构缺陷。
项目已彻底剥离 V4 的 AgentWebSocket 及 command 等实验性机制，核心的 `HTTP 轮询 + PlaywrightRuntime` 窗口管理及四业务 `Agent Local Executor` 均稳固在 V3 设定。
- **是否适合交付天南大真实使用**：**是**，在完成少量配置补充及修复一个 TypeScript 类型问题后，可立即交付。
- **是否存在 P0**：**否**（代码层面无 P0，但交付部署时必须执行一次清理数据库环境的操作）。
- **是否存在必须交付前修复的问题**：**是**（1 个前端编译报错，以及缺失的环境配置模板）。
- **当前建议**：**修复后交付（执行极小规模的 Fix 后即可封版部署）**。

## 2. 当前代码基线
- **Commit Hash**：`c3dda56cc7ab30f9f2cb7367a12c967111e06e2d`
- **Git Status**：处于 `master` 分支，与 origin 同步，有少量运行时生成的未追踪文件（如 `backend/data/` 等），属正常现象。
- **GitHub 地址**：`https://github.com/caoke123/DaoPaiV3.git`
- **V4 残留情况**：清理非常彻底。全仓未检索到 `AgentWebSocket`、`command_available`、`window_commands`。仅前端发现 `EventSource` 的使用（位于 `useTaskLiveLogs.ts`），但这属于合法的任务实时日志查看逻辑，并非控制链路。

## 3. TypeScript / 构建检查结果
- **backend**：✅ 0 errors
- **agent**：✅ 0 errors
- **frontend**：❌ 1 error
  - **报错位置**：`frontend/src/components/shared/WindowStateProvider.tsx(139,33)`
  - **报错信息**：`Property 'staffName' does not exist on type 'PlaywrightSiteWindowState'.`
  - **原因分析**：在执行 Cloud 状态与 Playwright 状态合并时，误用了 `pw.staffName`，该类型上实际定义的属性为 `employeeName`。这会导致离线回退状态时发生匹配失败。

## 4. 全链路架构现状
- **前端**：通过 `WindowStateProvider` 统一轮询窗口状态。状态真理源设定为 `getSitePlaywrightWindows`（PlaywrightRuntime 内存状态），而 `getCloudWindowStatus` 仅作离线补充。
- **后端**：Express 提供标准的 REST API（包含 `/api/playwright-poc` 等兼容链路）。对于任务执行，后端 `routes.ts` 仅将任务标记为 `pending`，通过 PG 写入任务记录。
- **Agent**：采用 `HTTP 轮询` 机制拉取任务（`pullTask`）。拉取到任务后，使用本地的 `ArrivalExecutor`、`DispatchExecutor` 等执行。
- **Playwright / Chrome**：窗口操作均在 Agent 进程内（`Agent 本地执行器`）完成，调用本机 Portable Chrome。
- **PostgreSQL**：统一作为主数据库使用，并在获取状态失败时降级到 SQLite（Fallback）。

## 5. Header 与窗口状态审查
- **启动与关闭**：调用链清晰，前端 `handleLaunchAll` 与 `handleCloseWindow` 正确调用 `/playwright-windows/ensure` 和 `close`。
- **状态显示与稳定**：已具备 `P0Passed` 检查，`status` 判定逻辑完整。
- **V4 残留**：完全没有 V4 的窗口接管逻辑，当前仍通过 HTTP 调用云端触发状态变更。

## 6. 四个业务任务审查
四个业务链路（Arrival / Dispatch / Integrated / Sign）代码结构清晰，且：
- Agent 侧执行器正确透传和处理 `dryRunMode`。
- 多员工并发机制在 Dispatch 和 Integrated 等任务中已受到正确的支持和验证。

## 7. 真实生产模式安全审查
- **ENABLE_REAL_SUBMIT**：经排查，4 个业务执行器及后端 Operations 中，全部保留了 `process.env.ENABLE_REAL_SUBMIT !== 'true'` 的硬性安全门保护。在真实提交前，都会被强制拦截并输出日志。
- **试运行模式标识**：前端有明显的 `dryRunMode` UI 提示及橘色/蓝色背景区分。
- **结论**：不存在误真实提交的风险，安全门生效。在给天南大真实使用时，需显式在 `.env` 中开启 `ENABLE_REAL_SUBMIT=true` 才能发送真实请求。

## 8. 数据库与持久化审查
- PG 迁移脚本完整，核心表清晰。
- **V4 残留风险**：代码中无 `window_commands`，但部署环境的物理数据库中如果存在该表，或者 `window_status` 表中有测试期间产生的脏数据（例如 `UUID` 作为 `siteId`），将导致 `WindowStateProvider` 发生匹配失效。
- 任务卡在 running 的处理方案：后端 `index.ts` 启动时已包含 `AssignmentEngine.recoverRunningTasks()`，会自动将僵尸任务置为 failed。

## 9. 配置与部署审查
- **配置模板缺失**：仓库中缺少 `backend/.env.example` 和 `backend/data/settings.example.json`，这对交付到客户现场部署非常不利，容易漏配参数。
- **硬编码风险**：
  - 未发现 `E:/网站开发` 这类绝对路径，文件路径管理良好。
  - 在 `frontend/vite.config.ts` 和 `packages/agent/agent.example.json` 中存在 `localhost:3300` 的硬编码。虽可通过 Nginx 反代或修改 JSON 解决，但需在部署手册中特别说明。

## 10. 日志、截图、异常处理审查
- 任务执行均有完整的 `taskLogManager` 日志落库逻辑，前端也可通过 SSE 查看实时日志。
- Agent 在崩溃或任务执行异常时，能通过 `try/catch` 调用 `failTask` 上报 Cloud 端，不会导致任务永久卡死。

## 11. 死代码 / 遗留代码审查
- **EasyBR 体系**：`backend/easybr/EasyBRClient.ts`、`BrowserPool.ts` 等大量代码仍存在。由于 V3 采用 Playwright 路线，这些属于历史兼容代码。目前没有对主流程产生干扰。
- **Mock / TODO**：`backend/auth/userAuth.ts` 中存在伪造的鉴权逻辑（`TODO Phase 3-B: 实现真实用户鉴权`）。若系统暴露在公网，存在安全隐患。

## 12. 风险清单

| 等级 | 模块 | 问题 | 影响 | 最小建议 | 是否交付前修 |
|------|------|------|------|----------|--------------|
| **P0** | 数据库部署 | 部署环境可能残留 V4 脏数据 | 导致窗口状态匹配失效或状态停滞 | 部署时执行物理清库，确保 `window_status` 为空 | **是（部署阶段执行）** |
| **P1** | 前端 | TypeScript 编译报错 | `WindowStateProvider.tsx` 合并离线状态时报错，引发状态异常 | 将 `pw.staffName` 修改为 `pw.employeeName` | **是** |
| **P1** | 配置部署 | 缺少环境配置模板文件 | 天南大现场部署时极易漏配关键参数导致系统无法启动 | 补充 `backend/.env.example` 和 `settings.example.json` | **是** |
| **P1** | Backend API | JWT Auth 鉴权为伪造实现 | 若系统开放公网，任意用户均可调用 API | 在内网环境部署或通过 Nginx 限制外网访问 | **是（通过部署限制）** |
| **P2** | Agent/前端 | `localhost:3300` 地址硬编码 | 在跨机器部署时 Agent 无法连接 Cloud | 在 Agent 配置和前端构建时修改对应 IP | 否（交付后优化） |
| **P3** | Backend API | 大量 EasyBR 遗留死代码 | 增加代码体积，降低可读性，存在误调风险 | 添加 `/** @deprecated */` 注释或移入归档目录 | 否（记录即可） |

## 13. 交付前必须完成清单
1. 修复 `WindowStateProvider.tsx` 139行的 `pw.staffName` 错误。
2. 补充完整的 `backend/.env.example`，必须包含 `ENABLE_REAL_SUBMIT` 的说明。
3. 补充完整的 `backend/data/settings.example.json`。
4. 整理《天南大现场部署手册》，明确数据库清理要求与 `localhost` IP 替换步骤。

## 14. 交付后优化建议
1. **清理死代码**：安全剥离 `EasyBRClient` 及其依赖的所有轮询链路，减少后端定时器开销。
2. **鉴权闭环**：实现真实的 JWT 和 RBAC 校验，确保系统能安全地在更开放的网络环境中运行。
3. **配置外化**：将 `agent.json` 的管理做成可视化界面，降低现场实施的配置难度。

## 15. 是否建议立即修改代码
**本次审查阶段未修改任何代码。**
由于存在影响状态显示的 P1 级编译错误及缺失的环境配置模板，**强烈建议进入极小规模的 Fix 阶段**，完成上述【交付前必须完成清单】后再打最终的 Release Tag 并交付天南大使用。