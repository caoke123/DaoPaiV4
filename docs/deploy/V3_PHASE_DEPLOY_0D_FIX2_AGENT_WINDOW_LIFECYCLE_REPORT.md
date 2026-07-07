# DaoPai V3 Deploy-0D-Fix-2 Agent 窗口生命周期修复报告

## 1. 问题现象

- 从 Header 点击到窗口打开需要 10～15 秒，响应太慢
- 窗口打开后停在登录页，没有自动登录
- 前端点击关闭窗口后，窗口不能正常关闭
- Agent 和 Header 之间缺少状态反馈，用户不知道卡在哪里

## 2. 根因定位

### 2.1 通信为什么慢

| 瓶颈 | 旧值 | 影响 |
|------|------|------|
| Agent command poll 间隔 | 3000ms | 最坏 3 秒才拉到命令 |
| Header 命令轮询间隔 | 2000ms × 10 次 = 20s | 反馈迟钝 |
| open_window 无阶段式上报 | 一次性全部执行完才报告 | 用户看不到进度 |
| 无 P0 检测和弹窗清理 | 缺失 | 登录完成也未必 ready |

### 2.2 自动登录代码存在但未生效

上一轮的 [`LocalWindowRuntime.ts`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/local-runtime/LocalWindowRuntime.ts) 已写入 `BnsyLoginExecutor.loginToBnsy` 调用，但：
- 没有使用 `ensureBnsyLoggedIn`（完整流程含 P0 + 弹窗清理）
- 缺少 P0 检测，登录成功后页面可能被弹窗阻塞但误判为 ready

### 2.3 close_window 根因

[`killV3ChromeByPid`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/ChromeProcessGuard.ts) 内 `isV3ChromeProcess` 校验全局 `userDataDir`，与 per-window profile 路径不匹配，拒绝关闭。上一轮已新增 `killChromeByUserDataDir` 解决此问题。

## 3. 修改文件列表

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent/src/index.ts` | 修改 | poll 1s、预注册窗口、立即上报 starting、onPhase 回调 |
| `packages/agent/src/local-runtime/LocalWindowRuntime.ts` | 修改 | onPhase 回调、`ensureBnsyLoggedIn`（登录 + P0 + 弹窗）、耗时日志 |
| `packages/agent/src/browser/BnsySessionManager.ts` | 修改 | 导出 `cleanBlockingPopups` |
| `frontend/src/components/layout/Header.tsx` | 修改 | poll 1s×15 次、状态过渡显示（pending/claimed/running/done/failed） |

## 4. 通信加速结果

### 4.1 Agent 命令轮询

- `COMMAND_POLL_MS`: 3000ms → **1000ms**
- Agent 启动后立即执行第一次 `pullWindowCommandsLoop`
- 拉到命令后立即执行，不等待下一轮 interval

### 4.2 Header 命令状态轮询

- 轮询间隔：2000ms → **1000ms**
- 最大轮询次数：10 → **15**（15 秒总超时）
- 新增状态过渡显示：

| 状态 | Header 显示 |
|------|------------|
| `pending` (第1秒) | "等待本地执行套件响应..." |
| `pending` (≥10秒) | "本地执行套件暂未响应 (xxx)，请确认 Agent 已启动" |
| `claimed` | "启动中 (xxx): 本地执行套件已接收" |
| `running` | "启动中 (xxx): 正在执行" |
| `done` | 不显示（成功） |
| `failed` | "启动失败 xxx: {error}" |

### 4.3 窗口阶段式上报

`executeOpenWindow` 新增 `onPhase` 回调，在各阶段实时上报 `window_status`：

```
Agent claim command
  → 立即上报 window_status=starting "启动中"
  → activeWindows 预注册（window_status 采集器立即可见）

open_window 内部：
  → onPhase('starting', '正在启动 Chrome')
  → Chrome 启动 → onPhase('starting', '正在连接 CDP')
  → 导航到 BNSY
  → onPhase('logging_in', '正在自动登录')
  → ensureBnsyLoggedIn（登录 + P0 + 弹窗）
  → onPhase('ready', '就绪') 或 onPhase('login_required', '待登录')
```

### 4.4 预计耗时对比

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 点击 → 命令创建 | ~200ms | ~200ms |
| 命令创建 → Agent claim | 0-3000ms | 0-1000ms |
| Agent claim → Header 看到"启动中" | 5s (下一轮) | 立即 |
| Chrome 打开 | 取决于 Chrome 启动速度 | 不变 |
| 登录完成 → ready 上报 | 5s (下一轮) | 立即 |

## 5. open_window 修复

### 5.1 Chrome 启动

便携 Chrome 路径：[`computeChromePath()`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/local-runtime/LocalWindowRuntime.ts#L84)，优先级：
1. `agent.json` → `browser.executablePath`
2. `{localRoot}/Chrome/App/chrome.exe`

Per-window profile：[`computeProfilePath()`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/local-runtime/LocalWindowRuntime.ts#L76)，格式：
```
{localRoot}/profiles/{tenantId}/{siteId}/{windowId}
```

Debug 端口：[`computeDebugPort()`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/local-runtime/LocalWindowRuntime.ts#L98)，基于 `windowId` 稳定 hash → `31000 + hash % 100`。

### 5.2 CDP 连接

使用 [`BrowserManager`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/BrowserManager.ts) 管理 CDP 连接生命周期。

### 5.3 自动登录 + P0 + 弹窗清理

复用 [`ensureBnsyLoggedIn`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/BnsySessionManager.ts#L117)，一个函数完成全部流程：

```
ensureBnsyLoggedIn(page, credential)
  ↓
1. detectBnsyDashboardP0 → 当前状态
   ├─ READY → 已有登录态，直接返回
   ├─ BLOCKED_POPUP → cleanBlockingPopups → 重新检测
   ├─ LOGIN_REQUIRED → loginToBnsy → 登录
   │    └─ BLOCKED_POPUP → cleanBlockingPopups → 重新检测
   └─ 其他异常 → 返回失败
```

弹窗清理策略（[`cleanBlockingPopups`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/BnsySessionManager.ts#L38)）：
- 扫描 Element UI 弹窗（`.el-dialog__wrapper`, `.el-message-box__wrapper`, `[role="dialog"]`）
- 只点击安全按钮（取消、确定、我知道了、关闭、×、知道了）
- 禁止点击业务按钮（到件、派件、签收、提交、批量、保存业务数据）
- 最多 5 轮，每轮等待 500-800ms

### 5.4 READY 判断

| 条件 | 检查方式 |
|------|---------|
| `isCdpReady` | CDP `/json/version` 可访问 |
| `isDashboardReady` | `ensureBnsyLoggedIn` 返回 `READY` |
| `isLoginPage` | CDP URL 含 `/login` 或密码框存在 |
| `cdpEndpoint` 存在 | CDP 连接时建立 |

### 5.5 耗时日志

Agent 输出关键节点耗时：
```
⏱ Chrome 启动耗时: xxxms
⏱ CDP 连接耗时: xxxms
⏱ 登录+P0 总耗时: xxxms
⏱ 总耗时: xxxms (Chrome=xxxms CDP=xxxms)
```

## 6. close_window 修复

### 6.1 窗口定位

- 优先从 [LocalWindowRegistry](file:///e:/网站开发/DaoPaiV3/packages/agent/src/local-runtime/LocalWindowRegistry.ts) 按 `windowId` 查找
- Registry 在 `open_window` 成功时登记，`close_window` 时注销
- 降级：如果 Registry 为空，通过 `findV3ChromeProcesses(profilePath)` 按 profile 路径查找

### 6.2 关闭流程

1. CDP `Browser.close()` — 优先优雅关闭
2. `killChromeByUserDataDir(pid, profilePath)` — CDP 失败时按 PID 强制关闭
3. `findV3ChromeProcesses(profilePath)` — 按 profile 查找并关闭所有匹配进程

### 6.3 busy 保护

[`pullWindowCommandsLoop`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/index.ts#L474) 在 `runningTaskId` 存在时拒绝 `close_window` / `restart_window` 命令。

## 7. Header 状态反馈

### 7.1 启动反馈

| 时机 | 显示内容 |
|------|---------|
| 立即 | "窗口命令已下发：{staffName} (commandId前8位...)" |
| ~1s | "等待本地执行套件响应..." |
| ~1-2s | "启动中 ({staffName}): 本地执行套件已接收" |
| ~10s (仍 pending) | "本地执行套件暂未响应 ({staffName})，请确认 Agent 已启动" |
| done | 无消息（正常完成） |
| failed | "启动失败 {staffName}: {error}" |

### 7.2 关闭反馈

| 时机 | 显示内容 |
|------|---------|
| 立即 | "已下发关闭命令：{staffName}" |
| ~1-2s | "关闭中 ({staffName}): 本地执行套件已接收" |
| failed | "关闭失败 {staffName}: {error}" |

### 7.3 状态显示来源

`window_status` 表由 Agent 每 5 秒上报。`open_window` 执行期间通过 `onPhase` 立即上报。
5s reporter 采集所有 `activeWindows` 的 CDP/进程状态。

## 8. 验证结果

### 8.1 TypeScript 检查

```
cd backend        && npx tsc --noEmit  → ✅ 0 errors
cd frontend       && npx tsc --noEmit  → ✅ 0 errors
cd packages/agent && npx tsc --noEmit  → ✅ 0 errors
```

### 8.2 待人工测试

#### A. 启动窗口 + 自动登录
1. 重启三端
2. Header 点击启动窗口
3. 1 秒内 Header 显示"等待本地执行套件响应..."
4. 1～2 秒内 Agent claim command，Header 显示"本地执行套件已接收"
5. Chrome 窗口打开
6. 自动登录执行（如有凭据）
7. P0 检测通过，弹窗清理
8. Header 显示 ready

#### B. 关闭窗口
1. Header 点击关闭窗口
2. 1 秒内显示"已下发关闭命令"
3. Agent claim close command
4. 指定窗口关闭
5. window_status 变 offline

#### C. 一键启动
1. 点击一键启动
2. 批量创建 open_window command
3. Agent 逐个执行
4. Header 状态逐个更新

#### D. 任务执行（至少 2 个任务）
1. `/agent/window-connections` 返回 ready 窗口
2. Executor 能 connectExisting(cdpEndpoint)
3. 任务执行正常

#### E. 忙碌关闭保护
1. 任务执行中尝试关闭窗口
2. close_window 应 fail
3. 任务不中断

## 9. 不变项确认

以下代码**零修改**：
- `ArrivalExecutor.ts` — 到件扫描执行器
- `DispatchExecutor.ts` — 派件扫描执行器
- `IntegratedExecutor.ts` — 到派一体执行器
- `SignExecutor.ts` — 签收录入执行器
- `dryRunMode` 逻辑
- `ENABLE_REAL_SUBMIT` 逻辑
- Task Center 日志策略
- EasyBR 清理结果

## 10. 是否提交 Git

否，等待用户测试确认。
