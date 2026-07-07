# DaoPai V3 Deploy-0D-Fix-2 自动登录与关闭窗口修复报告

## 1. 问题现象

- **P1**：窗口启动后 Chrome 正常打开，进入 `bnsy.benniaosuyun.com/login` 登录页，但没有执行自动登录
- **P2**：前端 Header 点击关闭窗口后，Chrome 窗口没有关闭

## 2. 根因定位

### 2.1 自动登录为什么没有执行

[`LocalWindowRuntime.ts`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/local-runtime/LocalWindowRuntime.ts) 的 `executeOpenWindow` 函数在 Deploy-0D 中只做了三件事：
1. 启动便携 Chrome
2. 连接 CDP
3. 导航到 BNSY 首页

但**从未调用登录逻辑**。导航后页面停在 `/login` 登录页，函数直接返回 `success: true`。

### 2.2 close_window 为什么无法关闭

[`ChromeProcessGuard.ts`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/ChromeProcessGuard.ts) 的 `killV3ChromeByPid` 内部调用 `isV3ChromeProcess` 进行安全校验，其中要求：

```typescript
// 校验 2: commandLine 必须包含全局 userDataDir
if (!info.commandLine.includes(getExpectedUserDataDir())) {
    return false;
}
```

`getExpectedUserDataDir()` 返回 `agent.json` 中的全局 `browser.userDataDir`（如 `runtime/chrome-data`），但 LocalWindowRuntime 为每个窗口使用隔离的 profile 目录（`profiles/{tenantId}/{siteId}/{windowId}`）。两者不匹配，导致 `isV3ChromeProcess` 返回 `false`，`killV3ChromeByPid` 拒绝执行关闭。

## 3. 修改文件列表

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent/src/local-runtime/LocalWindowRegistry.ts` | **新建** | 本地窗口注册表，windowId → chromePid/cdpEndpoint/profilePath |
| `packages/agent/src/local-runtime/LocalWindowRuntime.ts` | 修改 | 自动登录接入 + close 用 killChromeByUserDataDir |
| `packages/agent/src/browser/ChromeProcessGuard.ts` | 修改 | 新增 killChromeByUserDataDir，绕过全局 userDataDir 校验 |
| `packages/agent/src/index.ts` | 修改 | open_window 结果集成 loginRequired/isDashboardReady |
| `frontend/src/components/layout/Header.tsx` | 修改 | 命令状态轮询 + 失败 toast 提示 |

**不变项确认**：未修改以下文件
- `packages/agent/src/executors/ArrivalExecutor.ts`
- `packages/agent/src/executors/DispatchExecutor.ts`
- `packages/agent/src/executors/IntegratedExecutor.ts`
- `packages/agent/src/executors/SignExecutor.ts`
- dryRunMode 逻辑
- ENABLE_REAL_SUBMIT 逻辑
- Task Center 日志策略
- EasyBR 清理结果

## 4. 自动登录修复

### 4.1 凭据来源

优先级：
1. **设置中心 settings.json** — `AgentSettingsLoader.getLoginCredentialForStaff(siteId, staffName)`
2. **网点首位凭据** — `AgentSettingsLoader.getLoginCredentialForSite(siteId)`（兜底）
3. **开发兜底** — 仅本地无 settings.json 时，注释标注

密码在 settings.json 中以 Base64 存储，AgentSettingsLoader 读取时自动解码。

### 4.2 登录执行逻辑

复用已有 Agent 侧 V3 Playwright 自动登录模块（不重新硬写选择器）：

| 复用模块 | 用途 |
|----------|------|
| [`BnsyLoginDetector.detectBnsyLoginPage()`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/BnsyLoginDetector.ts#L54) | 检测是否在登录页、是否已登录 |
| [`BnsyLoginExecutor.loginToBnsy()`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/BnsyLoginExecutor.ts#L43) | 填写账号密码、点击登录、等待跳转 |
| [`AgentSettingsLoader.getLoginCredentialForStaff()`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/AgentSettingsLoader.ts#L211) | 按 siteId + staffName 获取凭据 |

`executeOpenWindow` 流程（Fix-2）：

```
启动 Chrome → 连接 CDP → 导航到 BNSY
  ↓
collectWindowStatus → 检测 isLoginPage
  ↓
是登录页？
  ├─ 是 → getLoginCredentialForStaff(siteId, staffName)
  │        ├─ 找到凭据 → detectBnsyLoginPage → loginToBnsy
  │        │    ├─ 登录成功 → 等待 dashboard → 标记 isDashboardReady=true
  │        │    └─ 登录失败 → 标记 loginRequired=true
  │        └─ 无凭据 → 标记 loginRequired=true
  └─ 否 → 已是 dashboard → isDashboardReady=true
  ↓
最终状态检测 → 登记 registry → 返回结果
```

### 4.3 READY 判断

- `isCdpReady` = CDP `http://127.0.0.1:{debugPort}/json/version` 可访问
- `isDashboardReady` = `!isLoginPage && isDashboardReady(collectWindowStatus)`
- `isLoginPage` = URL 包含 `/login`
- 只有 Dashboard Ready 才上报 `status: ready`

### 4.4 登录失败处理

| 场景 | window_status.status | command 结果 |
|------|---------------------|-------------|
| 凭据缺失 | `login_required` | `success=true, loginRequired=true` |
| 登录失败 | `login_required` | `success=true, loginRequired=true` |
| 登录异常 | `login_required` | `success=true, loginRequired=true` |
| 代码异常 | `error` | `status=failed, error=原因` |

密码不打印、不写入 result、不写入 window_status。

## 5. 关闭窗口修复

### 5.1 本地窗口注册表

新建 [`LocalWindowRegistry.ts`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/local-runtime/LocalWindowRegistry.ts)：

```typescript
windowId → {
  tenantId, siteId, workstationId,
  staffName, chromePid, cdpEndpoint,
  debugPort, profilePath, launchedAt
}
```

- `open_window` 成功后调用 `registerWindow()`
- `close_window` 调用 `unregisterWindow()`
- 支持 `findWindow(windowId)` / `findWindowByStaff(staffName)`

### 5.2 close_window 流程

```
收到 close_window command
  ↓
检查 runningTaskId busy → 如是则 fail
  ↓
查找 registry: findWindow(windowId) → 获取 chromePid / cdpEndpoint
  ↓
尝试 CDP Browser.close()
  → GET /json/version → 获取 webSocketDebuggerUrl
  → GET /json/close/{id}
  → waitForProcessExit(5s)
  ↓
按 profilePath 查找进程: findV3ChromeProcesses(profilePath)
  ↓
合并 registry PID + residues PID → Set<pid>
  ↓
逐个 killChromeByUserDataDir(pid, profilePath)
  ↓
注销 registry → complete command
```

### 5.3 killChromeByUserDataDir

[`ChromeProcessGuard.ts`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/ChromeProcessGuard.ts) 新增函数：

- 只校验 `executablePath`（便携 Chrome 路径）
- **不校验**全局 `userDataDir`（因为 per-window profiles 路径不同）
- `findV3ChromeProcesses` 已按 executablePath + profilePath 过滤，所以校验 executablePath 已足够安全

### 5.4 busy 保护

- `pullWindowCommandsLoop` 中检查 `runningTaskId`，任务运行时拒绝 `close_window` / `restart_window`
- 错误信息："当前窗口正在执行任务，不能关闭"

## 6. Header 错误提示

[`Header.tsx`](file:///e:/网站开发/DaoPaiV3/frontend/src/components/layout/Header.tsx) 修改内容：

1. 新增 `pollCommandStatus(commandId, staffName, action)` 函数
   - 创建 command 后轮询最多 10 次（每 2 秒）
   - 检测到 `failed` 状态 → `setLaunchMsg("启动失败/关闭失败 ${staffName}: ${error}")`
   - 超时 20 秒无响应 → `setLaunchMsg("本地执行套件暂未响应 (${staffName})，请确认 Agent 已启动")`
2. `handleInitWindow` 和 `handleCloseWindow` 创建 command 后调用 `pollCommandStatus`

## 7. Playwright fallback

`windowControlMode = command | playwright` 机制保留：

- 当前默认使用 `command` 模式（通过 `isPlaywright` 变量判断）
- 前端 `client.ts` 中保留了 `ensurePlaywrightWindow`、`launchAllPlaywrightWindows` 等 Playwright 直接 API
- 如果配置切到 `playwright`，Header 走原 V3 Playwright 路径
- fallback 不使用 EasyBR

## 8. 验证结果

### 8.1 TypeScript 检查

```
cd backend  && npx tsc --noEmit  → ✅ 0 errors
cd frontend && npx tsc --noEmit  → ✅ 0 errors
cd packages/agent && npx tsc --noEmit → ✅ 0 errors
```

### 8.2 待人工测试

#### A. 启动 + 自动登录测试
1. 重启 backend / frontend / Agent
2. Header 点击启动窗口
3. Chrome 打开
4. 如果有账号密码，自动登录
5. 登录后进入 dashboard / 首页
6. Header 状态变为 ready
7. window_status 中：status=ready, is_login_page=false, is_dashboard_ready=true, cdp_endpoint 不为空, chrome_pid 不为空

如果账号密码不可用：
- Header 显示"待登录"
- window_status = login_required
- 不能误显示 ready

#### B. 关闭窗口测试
1. Header 点击关闭窗口
2. 目标 Chrome 窗口关闭
3. window_status 变为 offline
4. command 状态 done
5. 不影响其他窗口

#### C. 一键启动 / 一键关闭测试
1. 一键启动可以逐个打开窗口
2. 不重复打开同一员工窗口
3. Header 状态能更新

#### D. 任务执行测试（至少 2 个任务）
1. 前端创建试运行任务
2. `/agent/window-connections` 返回 ready 窗口
3. Executor 能 connectExisting(cdpEndpoint)
4. 任务执行正常
5. 日志正常回传

#### E. 忙碌关闭保护
1. 执行任务时尝试关闭窗口
2. close_window 应 fail
3. 错误："当前窗口正在执行任务，不能关闭"
4. 任务不被中断

## 9. 不变项确认

确认以下代码**零修改**：
- `ArrivalExecutor.ts` — 到件扫描执行器
- `DispatchExecutor.ts` — 派件扫描执行器
- `IntegratedExecutor.ts` — 到派一体执行器
- `SignExecutor.ts` — 签收录入执行器
- `dryRunMode` 逻辑
- `ENABLE_REAL_SUBMIT` 逻辑
- Task Center 日志策略
- EasyBR 清理结果

## 10. 是否提交 Git

否，等待人工测试通过后由用户确认。
