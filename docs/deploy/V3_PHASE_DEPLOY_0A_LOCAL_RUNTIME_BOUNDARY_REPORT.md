# DaoPai V3 Phase Deploy-0A 本地执行套件边界修复报告

> 生成日期：2026-07-04  
> 代码版本：V3 当前主干  
> 本阶段性质：审查 + 方案输出，不修改核心业务代码

---

## 1. 总体结论

**当前窗口管理系统不适合直接客户交付。** 主要原因：

1. **窗口启动由云端 Frontend → Backend API 驱动**，客户网页无法直接操作本地 Chrome 进程。
2. **Backend 的 PlaywrightRuntime 使用 `chromium.launchPersistentContext({ channel: 'chrome' })`**，依赖系统安装的 Chrome，而非打包的便携 Chrome。
3. **Agent 的 BrowserManager 使用便携 Chrome**（`Chrome/App/chrome.exe`），但仅供任务执行使用，不参与窗口生命周期管理。
4. **窗口状态由 Backend 内存缓存维护**（`PlaywrightWindowStateStore`），进程重启后状态丢失，Header 可能出现空白/不一致。
5. **Header 状态不稳定**的可能根因：
   - Backend 重启后内存缓存清空 → 所有窗口显示 `offline`
   - `refreshState` 需要访问 CDP 页面，如果页面挂起/超时 → 返回 `failed`
   - P0 守卫条件严格（pageCount===1、URL 含域名、不含 /login），任一条件不满足即降级
   - Frontend 本地 `initializingTasks` 状态与 Backend 状态不同步

---

## 2. 当前窗口启动链路

### 2.1 Playwright 模式（当前主力路径）

```
Header 点击「一键启动」按钮 (Header.tsx)
  ↓
Frontend API: launchAllPlaywrightWindows(siteId)
  ↓ POST /api/sites/:siteId/playwright-windows/launch-all
Backend windowRuntimeRoutes.ts
  ↓ 解析 siteId → siteCode → 构建 runtimeKey
  ↓ adapter.ensureWindowReady({ tenantId, siteId, windowId, staffName, ... })
PlaywrightWindowAdapter.ts
  ↓ 检查 PlaywrightWindowStateStore 缓存
  ↓ 不存在/closed/failed → runtime.launchWindow(...)
PlaywrightRuntime.ts
  ↓ PlaywrightProfileManager.resolveUserDataDir(tenantId, siteId, windowId)
  ↓ userDataDir = runtime/profiles/{tenantId}/{siteId}/{windowId}/
  ↓ chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: false })
  ↓ (使用系统 Chrome，channel: 'chrome' 走 Playwright 内置浏览器)
  ↓ normalizeTabsForWindow → 导航到 bnsy.benniaosuyun.com
  ↓ 检查登录态 → 如果 login_required → tryAutoLoginAfterEnsure
  ↓ 跑 P0 守卫检查
  ↓ 更新 PlaywrightWindowStateStore 缓存
  ↓
返回状态给 Frontend
  ↓
WindowStateProvider 计算 displayStatus
  ↓
Header 展示窗口状态
```

### 2.2 单个窗口启动

```
Header 点击单个窗口启动按钮
  ↓
Frontend API: ensurePlaywrightWindow(siteId, staffName)
  ↓ POST /api/sites/:siteId/playwright-windows/ensure
  ↓ (同上链路 PlaywrightWindowAdapter → PlaywrightRuntime)
```

### 2.3 Legacy EasyBR 模式（存量兼容）

```
Header 点击「一键启动」
  ↓ POST /api/sites/:siteId/windows/launch-all
Backend routes.ts
  ↓ EasyBRClient.checkHealth()
  ↓ EasyBRClient.getBrowerList() / openedList()
  ↓ BrowserPool.ensureWindowOpen(browserId)
  ↓ (EasyBR 指纹浏览器启动)
```

---

## 3. 当前窗口关闭链路

### 3.1 Playwright 模式

```
Header 点击单个窗口关闭按钮
  ↓
Frontend API: closePlaywrightWindow(siteId, staffName)
  ↓ POST /api/sites/:siteId/playwright-windows/close
Backend windowRuntimeRoutes.ts
  ↓ 检查 busy 状态（busy 禁止关闭）
  ↓ runtime.closeWindow(runtimeKey)
PlaywrightRuntime.ts
  ↓ 获取 context / page
  ↓ context.close() + 清理 state
  ↓ PlaywrightWindowStateStore 标记为 closed
```

### 3.2 Legacy EasyBR 模式

```
Header 点击 toggle
  ↓ POST /api/windows/:browerid/toggle
  ↓ BrowserPool.toggleWindow(browerid)
```

### 3.3 Agent 端 BrowserManager 关闭

```
Agent executor 使用便携 Chrome:
  browserManager.close()
  ↓ browser.close() (CDP Browser.close)
  ↓ 等待 PID 退出（最多 5s）
  ↓ 未退出 → killV3ChromeByPid
  ↓ 扫描 userDataDir 残留 chrome.exe
  ↓ clearSession()
```

---

## 4. 当前 Header 状态链路

### 4.1 状态数据来源

```
Header 通过 WindowStateProvider (window-status.ts) 计算 displayStatus

数据来源：两条路径

路径 A (Playwright):
  GET /api/sites/:siteId/playwright-windows
  → PlaywrightRuntime.getWindowStateJSON(runtimeKey)
  → PlaywrightWindowStateStore 内存缓存
  → status 字段：offline | connecting | login_required | ready | busy | degraded | failed

路径 B (EasyBR):
  GET /api/sites/:siteId/windows
  → EasyBRClient.openedList() + BrowserPool.getRuntimeState(browserId)
  → RuntimeState（内存缓存：isConnected + isP0Verified + isLoginRequired + isBusy + isDegraded）
  → status 字段：offline | connecting | login_required | connected | ready | busy | degraded
```

### 4.2 displayStatus 计算规则（window-status.ts）

| 后端 status | P0 守卫 | displayStatus 结果 |
|---|---|---|
| `busy` | - | `busy`（最高优先级，不可覆盖） |
| `ready` | p0Passed=true + pageCount=1 + URL 正常 | `ready` |
| `ready` | P0 未通过 + URL 含 /login | `login_required` |
| `ready` | P0 未通过 + 其他原因 | `degraded` |
| `login_required` | - | `login_required` |
| `degraded` / `failed` | - | `degraded` / `failed` |
| `offline` / `connecting` / `connected` + local `initializing` 标记 | - | `initializing` (启动中) |
| `offline` | - | `offline` |
| `connecting` / `connected` | - | `connecting` |

### 4.3 状态不稳定的可能原因

| 原因 | 影响 | 等级 |
|---|---|---|
| Backend 重启 → PlaywrightWindowStateStore 内存缓存丢失 | 所有窗口显示 `offline`，需重新轮询 | P1 |
| Backend PlaywrightRuntime 使用系统 Chrome（非便携），受系统 Chrome 更新影响 | 版本不匹配导致启动失败 | P1 |
| `refreshState` 访问 CDP 页面超时 | 状态显示 `degraded` / `failed` | P2 |
| P0 守卫 `pageCount !== 1` | Chrome 自启新标签页导致降级 | P2 |
| Frontend `initializingTasks` Set 与 Backend 状态不同步 | 卡在「启动中」不刷新 | P2 |
| Backend 在服务器运行，Chrome 在服务器上启动 | 客户访问云端网页，看不到客户本机窗口 | **P0（根本架构问题）** |

**根本问题：Backend 在服务器上操作 Chrome 进程，客户电脑上无法看到这些窗口。** 这是当前架构在客户交付场景下最大的问题。

---

## 5. 当前便携 Chrome 依赖

### 5.1 两套 Chrome 并存

| 用途 | 代码位置 | Chrome 来源 | 路径 |
|---|---|---|---|
| **Backend 窗口管理** | [PlaywrightRuntime.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightRuntime.ts#L26) | `import { chromium } from 'playwright'` → `channel: 'chrome'` | Playwright 内建 Chrome（系统路径） |
| **Agent 任务执行** | [BrowserManager.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/BrowserManager.ts#L49-123) | `agent.json` → `browser.executablePath` | `E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe` |

### 5.2 便携 Chrome 硬编码路径

在 Agent 测试文件中硬编码：
```
E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe           ← portable chrome.exe
E:/网站开发/DaoPaiV3/runtime/chrome-profile           ← Backend agent profile
E:/网站开发/DaoPaiV3/runtime/chrome-profile-test      ← test profile
```

[ChromeProcessGuard.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/ChromeProcessGuard.ts#L31) 中硬编码：
```ts
const EXPECTED_CHROME_PATH = 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe';
```

这些硬编码路径在客户交付时必须改为相对路径。

### 5.3 Profile 路径结构

**Backend 模式：**
```
runtime/profiles/{tenantId}/{siteId}/{windowId}/
```
由 [PlaywrightProfileManager.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightProfileManager.ts#L24) 管理，根路径为 `process.cwd() + runtime/profiles`。

**Agent 模式：**
```
{agent.json → browser.userDataDir}
```
如 `E:/网站开发/DaoPaiV3/runtime/chrome-profile`。

### 5.4 CDP 端口

| 来源 | 端口 |
|---|---|
| Backend PlaywrightRuntime | 动态分配（`findFreePort`），当前实现中端口不固定 |
| Agent BrowserManager | `agent.json` → `browser.debugPort`，默认 9223 |

---

## 6. 本地执行套件目标结构

```
DaoPai-Local/
  ├─ bin/
  │   ├─ DaoPaiAgent.exe          # Agent 主进程（拉取任务、调用 Runtime）
  │   └─ DaoPaiLocalRuntime.exe   # Local Runtime（窗口管理、状态上报）
  ├─ chrome/
  │   └─ chrome.exe               # 便携版 Chrome（随包交付）
  ├─ config/
  │   └─ agent.config.json        # 执行电脑配置（Cloud地址、授权码、workstationId）
  ├─ profiles/
  │   └─ {tenantId}/
  │       └─ {siteId}/
  │           └─ {windowId}/      # 每个窗口独立 profile（含登录态）
  ├─ logs/
  │   ├─ agent.log                # Agent 主进程日志
  │   ├─ runtime.log              # Local Runtime 日志
  │   └─ windows/                 # 每个窗口的执行日志
  │       └─ {windowId}/
  ├─ diagnostics/                 # 一键诊断包导出目录
  │   └─ {timestamp}/
  ├─ start.bat                    # 一键启动 Agent + Runtime
  ├─ stop.bat                     # 一键停止所有进程
  ├─ install-service.bat          # 安装为 Windows 服务
  ├─ uninstall-service.bat        # 卸载 Windows 服务
  └─ README_安装说明.txt          # 客户安装说明
```

**设计要求：**

1. 便携 Chrome 必须随包交付（`chrome/chrome.exe`）
2. 不依赖客户电脑系统 Chrome
3. 不依赖项目源码根目录
4. 所有路径支持相对 `DaoPai-Local/` 根目录解析
5. 每个窗口独立 profile（`profiles/{tenantId}/{siteId}/{windowId}/`）
6. 后续支持一键诊断包导出到 `diagnostics/`

---

## 7. Header 状态迁移方案

### 7.1 目标架构

```
Local Runtime 检测真实窗口状态
  ↓
Local Agent 上报 Cloud（通过 Agent HTTP API）
  ↓
Cloud 保存 latest window status（PostgreSQL）
  ↓
Frontend Header 读取 Cloud 状态展示
```

### 7.2 当前 Header 状态字段（window-status.ts DisplayStatus）

```
offline | initializing | connecting | ready | busy | login_required | degraded | failed
```

### 7.3 建议保留的展示状态

| 状态 | 中文文案 | 含义 |
|---|---|---|
| `offline` | 离线 | 本地执行套件未启动或窗口未启动 |
| `starting` | 启动中 | Chrome 进程正在启动 |
| `login_required` | 待登录 | 窗口已打开但需要手动登录 |
| `logging_in` | 登录中 | 正在自动填写凭据登录 |
| `ready` | 就绪 | 窗口已登录，P0 守卫通过，可执行任务 |
| `busy` | 工作中 | 窗口正在执行任务 |
| `error` | 异常 | 窗口出现异常（需诊断） |

### 7.4 本地上报的底层字段

Local Agent 通过 HTTP 上报到 Cloud 的 window status API：

```ts
interface AgentWindowStatusReport {
  tenantId: string;
  siteId: string;
  workstationId: string;
  windowId: string;
  staffName: string;

  // Core status
  status: WindowStatus;
  statusText: string;

  // Runtime state
  currentUrl: string;
  isProcessAlive: boolean;
  isCdpReady: boolean;
  isDashboardReady: boolean;   // P0 守卫通过
  isLoginPage: boolean;

  // Diagnosis
  lastHeartbeatAt: string;     // ISO datetime
  lastError: string | null;
  cdpEndpoint: string;
  profilePath: string;
  chromePid: number | null;
}
```

### 7.5 Cloud 需要保存的字段

| 字段 | 类型 | 来源 |
|---|---|---|
| tenant_id | UUID | Agent 认证上下文 |
| site_id | string | window 配置 |
| workstation_id | string | Agent 配置 |
| window_id | string | 窗口唯一标识 |
| staff_name | string | 员工姓名 |
| status | enum | 上报字段 |
| status_text | text | 上报字段 |
| current_url | text | 上报字段 |
| is_process_alive | boolean | 上报字段 |
| is_cdp_ready | boolean | 上报字段 |
| is_dashboard_ready | boolean | 上报字段 |
| is_login_page | boolean | 上报字段 |
| last_heartbeat_at | timestamptz | 上报字段 |
| last_error | text | 上报字段 |
| cdp_endpoint | text | 上报字段 |
| profile_path | text | 上报字段 |
| chrome_pid | int | 上报字段 |

### 7.6 Header 应该调用哪个 API

建议新增 API：

```
GET /api/cloud/windows/status?tenantId={tid}&siteId={sid}
```

返回：
```json
{
  "windows": [
    {
      "windowId": "staff-zhangsan",
      "staffName": "张三",
      "status": "ready",
      "statusText": "就绪",
      "currentUrl": "https://bnsy.benniaosuyun.com/...",
      "isDashboardReady": true,
      "lastHeartbeatAt": "2026-07-04T12:00:00Z"
    }
  ]
}
```

### 7.7 当前代码中哪些需要替换

| 当前代码 | 替换方向 |
|---|---|
| [windowRuntimeRoutes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/windowRuntimeRoutes.ts) - 查询/启动/关闭 | 改为从 PostgreSQL 读取 Agent 上报的状态，不再直接操作 PlaywrightRuntime |
| [window-status.ts](file:///e:/网站开发/DaoPaiV3/frontend/src/lib/window-status.ts) - P0 守卫 | 守卫逻辑移到 Local Runtime，Frontend 只展示 Cloud 下发的结果 |
| [PlaywrightRuntime.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightRuntime.ts) - launchWindow | 迁移到 Local Runtime |
| [PlaywrightWindowState.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightWindowState.ts) - 内存状态缓存 | 迁移到 Local Runtime |
| [client.ts](file:///e:/网站开发/DaoPaiV3/frontend/src/api/client.ts) - launchAll/ensure/close | launch/ensure → Agent Command 模式；close → Agent Command 模式；状态查询 → 读 Cloud PG |

---

## 8. Window Command 方案

### 8.1 目标架构

```
Header 点击启动窗口
  ↓
Cloud 创建 window command（PostgreSQL）
  ↓
Local Agent 心跳时拉取 command（或通过 Server-Sent Events）
  ↓
Local Runtime 执行启动 Portable Chrome
  ↓
Local Agent 上报窗口状态
  ↓
Header 轮询 PG 状态 → 展示新状态
```

### 8.2 Window Command 数据结构

```ts
interface WindowCommand {
  id: string;               // UUID
  tenantId: string;
  workstationId: string;
  type: 'open_window' | 'close_window' | 'restart_window' | 'refresh_status';
  status: 'pending' | 'claimed' | 'running' | 'done' | 'failed';

  // Parameters
  params: {
    siteId: string;
    staffName: string;
    windowId: string;
    headless?: boolean;
  };

  // Results
  result?: {
    runtimeKey?: string;
    chromePid?: number;
    cdpEndpoint?: string;
    profilePath?: string;
    error?: string;
  };

  createdAt: string;
  claimedAt?: string;
  finishedAt?: string;
}
```

### 8.3 Command 类型

| 类型 | 说明 |
|---|---|
| `open_window` | 启动指定员工的 Chrome 窗口 |
| `close_window` | 关闭指定员工的 Chrome 窗口 |
| `restart_window` | 先关闭再重新启动 |
| `refresh_status` | 刷新指定窗口的状态（诊断用） |

### 8.4 Command 状态

| 状态 | 说明 |
|---|---|
| `pending` | Cloud 已创建，等待 Agent 拉取 |
| `claimed` | Agent 已拉取，等待执行 |
| `running` | Agent 正在执行（启动 Chrome 中） |
| `done` | 执行成功 |
| `failed` | 执行失败 |

### 8.5 Agent 拉取 Command 的接口建议

复用现有 `POST /api/agent/heartbeat` 的返回结构，增加 `commands` 数组：

```json
{
  "hasTask": true,
  "hasCommands": true,
  "commands": [
    {
      "id": "cmd-xxx",
      "type": "open_window",
      "status": "pending",
      "params": { "siteId": "tiannanda", "staffName": "张三", "windowId": "staff-张三" }
    }
  ]
}
```

### 8.6 Agent 上报 Command 结果的接口建议

新增 `POST /api/agent/command-result`：

```json
{
  "commandId": "cmd-xxx",
  "status": "done",
  "result": {
    "chromePid": 12345,
    "cdpEndpoint": "http://127.0.0.1:9222",
    "profilePath": "..."
  },
  "error": null
}
```

### 8.7 和现有任务拉取机制的关系

- Window Command 和 Task 使用**不同的表/队列**，互不干扰
- Agent 心跳返回 `hasTask`（业务任务）和 `hasCommands`（窗口命令）两个独立标志
- Command 执行在 Agent 主循环中，与 Task 执行互斥（同一时刻只有一个在执行）
- Command 优先级高于 Task（窗口就绪后才能执行任务）

### 8.8 如何避免影响当前业务任务执行

1. Command 在独立代码路径执行（新增 `executeWindowCommand` 函数）
2. 不修改现有 `executeArrivalDryRun` / `executeDispatchDryRun` 等路径
3. Command 执行期间 `runningTaskId` 为空（保证互斥）
4. Command 和 Task 拉取逻辑完全独立

---

## 9. 代码迁移清单

### A. 应保留在 Cloud Backend 的代码

| 模块/文件 | 当前位置 | 未来归属 | 是否本阶段修改 | 说明 |
|---|---|---|---|---|
| 任务创建 API | [routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) | Cloud Backend | 否 | 所有 POST /api/operations/* |
| 任务中心查询 | [routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) | Cloud Backend | 否 | GET /api/operations/stats 等 |
| PostgreSQL 存储层 | [PgDatabase.ts](file:///e:/网站开发/DaoPaiV3/backend/db/PgDatabase.ts) | Cloud Backend | 否 | 任务、日志、运单结果 |
| Agent 认证 | [routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) + middleware | Cloud Backend | 否 | Agent token 验证 |
| Task Log Service | [TaskLogService.ts](file:///e:/网站开发/DaoPaiV3/backend/services/TaskLogService.ts) | Cloud Backend | 否 | PG 日志存储 |
| Agent 心跳/任务拉取 | [routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) (agent 相关) | Cloud Backend | 否 | POST /api/agent/heartbeat 等 |

### B. 应迁移到 Local Runtime / Local Agent 的代码

| 模块/文件 | 当前位置 | 未来归属 | 是否本阶段修改 | 说明 |
|---|---|---|---|---|
| PlaywrightRuntime.launchWindow | [PlaywrightRuntime.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightRuntime.ts) | Local Runtime | 否 | 启动 Chrome 窗口 |
| PlaywrightRuntime.closeWindow | [PlaywrightRuntime.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightRuntime.ts) | Local Runtime | 否 | 关闭 Chrome 窗口 |
| PlaywrightWindowStateStore | [PlaywrightWindowState.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightWindowState.ts) | Local Runtime | 否 | 窗口状态内存缓存 |
| PlaywrightProfileManager | [PlaywrightProfileManager.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightProfileManager.ts) | Local Runtime | 否 | UserDataDir 管理 |
| P0Verifier | [P0Verifier.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/P0Verifier.ts) | Local Runtime | 否 | P0 守卫检查 |
| PlaywrightLoginVerifier | [PlaywrightLoginVerifier.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightLoginVerifier.ts) | Local Runtime | 否 | 登录状态检测 |
| manualLogin | [PlaywrightRuntime.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightRuntime.ts) | Local Runtime | 否 | 自动登录逻辑 |
| windowRuntimeRoutes 启动/关闭/状态 | [windowRuntimeRoutes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/windowRuntimeRoutes.ts) | Cloud Backend（仅剩余读 PG 的查询） | 否 | 启动/关闭改为 Command；状态读 PG |
| BrowserManager (Agent) | [BrowserManager.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/BrowserManager.ts) | Local Runtime | 否 | 便携 Chrome 启动管理 |
| ChromeProcessGuard | [ChromeProcessGuard.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/ChromeProcessGuard.ts) | Local Runtime | 否 | Chrome 进程守卫 |
| BrowserProcessRegistry | [BrowserProcessRegistry.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/BrowserProcessRegistry.ts) | Local Runtime | 否 | Chrome 进程注册表 |
| ChromeProfileSanitizer | [ChromeProfileSanitizer.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/ChromeProfileSanitizer.ts) | Local Runtime | 否 | Profile 清理 |
| P0 守卫前端判断 | [window-status.ts](file:///e:/网站开发/DaoPaiV3/frontend/src/lib/window-status.ts) | 简化（只展示后端状态） | 否 | `isPlaywrightReallyReady` 移到 Local Runtime |
| Header 启动/关闭按钮逻辑 | [Header.tsx](file:///e:/网站开发/DaoPaiV3/frontend/src/components/layout/Header.tsx) | Cloud Frontend（改为 Command 下发） | 否 | 从直接 API 调用改为 Command 创建 |

### C. 暂时不动的代码（本阶段及后续不迁移）

| 模块/文件 | 当前位置 | 未来归属 | 是否本阶段修改 | 说明 |
|---|---|---|---|---|
| ArrivalExecutor | [ArrivalExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/ArrivalExecutor.ts) | Local Agent | **禁止修改** | 核心业务执行 |
| DispatchExecutor | [DispatchExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/DispatchExecutor.ts) | Local Agent | **禁止修改** | 核心业务执行 |
| IntegratedExecutor | [IntegratedExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/IntegratedExecutor.ts) | Local Agent | **禁止修改** | 核心业务执行 |
| SignExecutor | [SignExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/SignExecutor.ts) | Local Agent | **禁止修改** | 核心业务执行 |
| 任务创建 / 任务拉取主链路 | [routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) / [index.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/index.ts) | Cloud / Agent | **禁止修改** | 核心任务管道 |
| dryRunMode 安全门 | SettingsManager / [routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) | Cloud Backend | **禁止修改** | 安全门 |
| AssignmentEngine | [assignment-engine.ts](file:///e:/网站开发/DaoPaiV3/backend/modules/assignment-engine.ts) | 待废弃 | **禁止修改** | 已在后续计划中淘汰 |
| BrowserPool | [BrowserPool.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/BrowserPool.ts) | 待废弃（EasyBR 模式） | **禁止修改** | Legacy 兼容层 |
| EasyBRClient | [EasyBRClient.ts](file:///e:/网站开发/DaoPaiV3/backend/easybr/EasyBRClient.ts) | 待废弃 | **禁止修改** | Legacy 兼容层 |

---

## 10. 不应改动的任务执行层确认

本阶段明确 **没有修改** 以下模块：

- **ArrivalExecutor** — 到件扫描执行器（Phase K-2A 已迁回 Agent）
- **DispatchExecutor** — 派件扫描执行器（Phase K-2B 已迁回 Agent）
- **SignExecutor** — 签收录入执行器（Phase K-2D 已迁回 Agent）
- **IntegratedExecutor** — 到派一体执行器（Phase K-2D 已迁回 Agent）
- **READY-window 匹配逻辑** — 四个 Executor 中的 CDP 窗口匹配
- **CDP 接管执行逻辑** — `BrowserManager.connectExisting()`
- **多员工 assignments 逻辑** — Dispatch/Integrated/Sign 的多员工并发
- **Dispatch 默认模式 / 指定模式** — executionMode 分支
- **Integrated 多员工并发** — 循环执行 assignments
- **Sign 签收比例和条数/页规则** — Executor 内部逻辑
- **dryRunMode / ENABLE_REAL_SUBMIT 安全门** — SettingsManager 控制
- **Task Center 日志策略** — TaskLogService / TaskLogManager

---

## 11. 风险清单

| 编号 | 风险 | 等级 | 说明 |
|---|---|---|---|
| R1 | Backend PlaywrightRuntime 在服务器操作 Chrome | **P0** | 客户无法看到服务器上的 Chrome 窗口，必须迁移到本地 |
| R2 | 便携 Chrome 路径硬编码 | **P0** | `EXPECTED_CHROME_PATH` 等绝对路径在客户环境不可用 |
| R3 | Agent BrowserManager 与 Backend PlaywrightRuntime 使用不同 Chrome | **P1** | 两套 Chrome 管理逻辑并存，增加维护成本 |
| R4 | Header 窗口状态依赖 Backend 内存缓存 | **P1** | 进程重启后状态丢失，需要迁移到 PG 持久化 |
| R5 | 系统 Chrome 不在客户交付范围 | **P1** | Backend 使用 `channel: 'chrome'`，依赖系统 Chrome |
| R6 | Agent 端 BrowserManager 仅在任务执行时使用 | **P1** | 任务执行前窗口管理（启动/关闭）仍由 Backend 控制 |
| R7 | P0 守卫过于严格可能导致可用窗口误判为 degraded | **P2** | `pageCount !== 1` 等情况 |
| R8 | windowRuntimeRoutes 直接操作 PlaywrightRuntime | **P2** | 与 Command 模式架构冲突 |

---

## 12. 下一阶段建议

| 阶段 | 内容 | 前提条件 |
|---|---|---|
| **Deploy-0B** | Local Runtime 最小模块抽离 — 从 Backend 迁移 launchWindow/closeWindow/状态检测到 Agent 侧 | Deploy-0A 完成 |
| **Deploy-0C** | Header 状态改为 Agent 上报 — 新增 PG window_status 表，Local Agent 定期上报状态 | Deploy-0B 完成 |
| **Deploy-0D** | 启动/关闭窗口改为 Command 模式 — 新增 window_commands 表，Agent 拉取并执行 | Deploy-0C 完成 |
| **Deploy-1** | 云端 Docker Compose 部署 — 剥离 Backend 中的本地 Chrome 依赖 | Deploy-0D 完成 |
| **Deploy-2** | 本地执行套件打包 — 按目标目录结构打包便携 Chrome + Agent + Runtime | Deploy-1 完成 |

---

## 13. 本次是否修改代码

**否。** 本阶段为纯审查 + 方案输出，没有修改任何源代码文件。

本阶段只新增了：
- `docs/deploy/V3_PHASE_DEPLOY_0A_LOCAL_RUNTIME_BOUNDARY_REPORT.md`（本报告）

---

## 14. 本次是否提交 Git

**否。** 不提交 Git，等待用户确认后再决定是否提交本报告。
