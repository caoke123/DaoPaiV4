# DaoPai V3 Phase Deploy-0B 本地执行套件 Runtime 最小抽离与 EasyBR 清理报告

> 生成日期：2026-07-04  
> 代码版本：V3 当前主干  
> 状态：**全部完成，验收通过**

---

## 1. 总体结论

**EasyBR legacy 生产路径已完全断开。Local Runtime 最小边界已初步建立。**

- EasyBR 启动 / 关闭 / toggle / reconnect 接口全部返回 410 Gone，不再执行实际 EasyBR 操作。
- Backend 启动不再初始化 EasyBRClient 或 BrowserPool EasyBR 链路。
- Frontend Header 不再调用任何 EasyBR legacy API。
- 便携 Chrome 硬编码路径已移除，改为从 agent 配置相对解析。
- Local Runtime 类型草案已创建，为 Deploy-0C/0D 做好准备。
- V3 Playwright 过渡路径正常工作，Header 窗口管理功能不受影响。

---

## 2. 修改文件列表

### 后端（6 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| [routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) | 修改 | 删除/禁用 8 个 EasyBR 路由，移除 EasyBRClient import，清理注释 |
| [index.ts](file:///e:/网站开发/DaoPaiV3/backend/index.ts) | 修改 | 移除 EasyBRClient import，清理 BrowserPool 初始化注释 |
| [runtimeMode.ts](file:///e:/网站开发/DaoPaiV3/backend/config/runtimeMode.ts) | 修改 | 默认值改为 playwright，legacy_easybr 归一化并打印 warn |
| [RuntimeStatus.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/runtime/RuntimeStatus.ts) | 修改 | 移除 easybrConnected 字段 |
| [AssignmentEngine.ts](file:///e:/网站开发/DaoPaiV3/backend/modules/assignment-engine/AssignmentEngine.ts) | 修改 | 移除 EasyBR health check，移除 EasyBRClient import，更新 runtimeMode 默认值 |
| [RuntimeStatus.test.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/runtime/__tests__/RuntimeStatus.test.ts) | 修改 | 移除 easybrConnected 断言，更新 EasyBR 测试文案 |

### 前端（7 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| [client.ts](file:///e:/网站开发/DaoPaiV3/frontend/src/api/client.ts) | 修改 | 删除 `toggleWindow`/`reconnectEasyBR`/`openBrowser` 函数，删除 `easybrHealth`/`easybrConnected` 类型字段 |
| [Header.tsx](file:///e:/网站开发/DaoPaiV3/frontend/src/components/layout/Header.tsx) | 修改 | 删除 EasyBR imports，删除 `handleReconnectEasyBR`，删除 legacy fallback 分支，删除 EasyBR 弹窗，保留 Playwright 路径 |
| [WindowStateProvider.tsx](file:///e:/网站开发/DaoPaiV3/frontend/src/components/shared/WindowStateProvider.tsx) | 重写 | 默认 playwright，移除 EasyBR 状态变量，移除 legacy 轮询路径，统一 V3 Playwright 数据源 |
| [SettingsPage.tsx](file:///e:/网站开发/DaoPaiV3/frontend/src/pages/SettingsPage.tsx) | 修改 | 更新 EasyBR 注释为通用描述 |
| [BrowserPage.tsx](file:///e:/网站开发/DaoPaiV3/frontend/src/pages/BrowserPage.tsx) | 修改 | 替换 "EasyBR" 文案为 "本地执行端" |
| [index.css](file:///e:/网站开发/DaoPaiV3/frontend/src/index.css) | 修改 | CSS 注释中 EasyBR → 本地浏览器 |
| [mock-data.ts](file:///e:/网站开发/DaoPaiV3/frontend/src/lib/mock-data.ts) | 修改 | 删除 MOCK_EASYBR 接口和常量，清理窗口名称 |

### Agent（4 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| [ChromeProcessGuard.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/ChromeProcessGuard.ts) | 修改 | 移除硬编码 Chrome 路径，改为从 config 动态读取 |
| [config.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/config.ts) | 修改 | 新增 `getConfig()`/`getLocalRoot()` 导出，路径相对化解析，更新错误提示 |
| [agent.example.json](file:///e:/网站开发/DaoPaiV3/packages/agent/agent.example.json) | 修改 | 路径改为相对路径 |
| [local-runtime/types.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/local-runtime/types.ts) | **新增** | LocalWindowCommand/LocalWindowStatus 类型草案 |

---

## 3. EasyBR 清理结果

### 3.1 删除/禁用的 Backend 路由

| 路由 | 状态 | 返回 |
|---|---|---|
| `POST /api/windows/:browerid/toggle` | **410 Gone** | `"EasyBR legacy mode has been removed in DaoPai V3"` |
| `POST /api/windows/:browerid/cleanup-pages` | **410 Gone** | 同上 |
| `POST /api/windows/:browerid/ensure-ready` | **410 Gone** | 同上 |
| `POST /api/easybr/open-browser` | **410 Gone** | 同上 |
| `POST /api/easybr/reconnect` | **410 Gone** | 同上 |
| `GET /api/sites/:siteId/windows` | **410 Gone** | 同上，hint: 改用 playwright-windows |
| `POST /api/sites/:siteId/windows/launch-all` | **410 Gone** | 同上，hint: 改用 playwright-windows/launch-all |

### 3.2 删除的前端 API 函数

- `toggleWindow(browserId)` — 删除
- `openBrowser(browserId)` — 删除
- `reconnectEasyBR()` — 删除
- `easybrHealth` 字段 — 从 `SiteWindowsResponse` 中移除
- `easybrConnected` 字段 — 从 `TaskStatsResponse.system` 中移除

### 3.3 仍在生产代码中的 EasyBR 引用

| 位置 | 内容 | 说明 |
|---|---|---|
| `routes.ts` | 410 Gone 错误消息和 D-0B 注释 | 刻意保留，前端可按 410 状态码提示用户 |
| `runtimeMode.ts` | `WindowRuntimeMode` 类型包含 `'legacy_easybr'` | 向后兼容，归一化后打印 warn |
| `client.ts` | `WindowCredential.easybrBrowserId` | 配置数据字段，仅持久化使用 |
| `SettingsPage.tsx` | `easybrBrowserId` | 配置持久化字段，UI 不展示 |
| `EasyBRClient.ts` | 文件保留 | 未删除文件，但生产路径已断开 |

### 3.4 未删除文件（已断开生产路径）

- `backend/easybr/EasyBRClient.ts` — 文件保留，无生产调用入口
- `backend/browser/BrowserPool.ts` — 文件保留，无生产调用入口

---

## 4. V3 Playwright 过渡路径保留情况

以下 V3 Playwright 窗口 API 仍正常提供服务：

| 路由 | 功能 |
|---|---|
| `GET /api/sites/:siteId/playwright-windows` | 查询窗口状态 |
| `POST /api/sites/:siteId/playwright-windows/launch-all` | 一键启动全部窗口 |
| `POST /api/sites/:siteId/playwright-windows/ensure` | 启动单个窗口 |
| `POST /api/sites/:siteId/playwright-windows/close` | 关闭单个窗口 |
| `POST /api/windows/init` | EasyBR health check 已移除，保留窗口初始化 |

**说明：** 这些是 Deploy-0B 过渡路径。后续 Deploy-0C/0D 将迁移为 Agent 上报状态 + Window Command 模式。

---

## 5. 便携 Chrome 路径回正结果

### 5.1 原来硬编码的位置

| 文件 | 硬编码路径 |
|---|---|
| [ChromeProcessGuard.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/ChromeProcessGuard.ts) | `E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe` |
| [agent.example.json](file:///e:/网站开发/DaoPaiV3/packages/agent/agent.example.json) | `E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe` |
| [agent.example.json](file:///e:/网站开发/DaoPaiV3/packages/agent/agent.example.json) | `E:/网站开发/DaoPaiV3/runtime/chrome-profile` |

### 5.2 现在从哪里读取 chromePath

```text
1. agent.json → browser.executablePath（显式配置，优先）
2. localRoot/chrome/chrome.exe（默认）
3. 找不到 → throw Error("未找到 DaoPai 本地执行套件内置 Chrome，请检查 chrome/chrome.exe 是否存在。")
```

`localRoot` 从 `DAOPAI_LOCAL_ROOT` 环境变量读取，未设置时回退为 `process.cwd()`。

### 5.3 客户交付默认路径

```
DaoPai-Local/chrome/chrome.exe
DaoPai-Local/profiles/{tenantId}/{siteId}/{windowId}/
```

### 5.4 找不到 chrome.exe 时的错误提示

```
未找到 DaoPai 本地执行套件内置 Chrome，请检查 chrome/chrome.exe 是否存在。
```

---

## 6. Profile 路径规划结果

### 6.1 当前 profile 路径

- **目标结构：** `DaoPai-Local/profiles/{tenantId}/{siteId}/{windowId}/`
- **本阶段：** 仅在 `config.ts` 中实现了 `resolveProfilePath()` 解析函数，未实际切换运行时 profile 路径
- **兼容：** 当前 `agent.json` 中 `browser.userDataDir` 仍可用绝对路径兼容现有开发环境

### 6.2 是否实际切换

**否。** 本阶段仅在 Agent config 中实现了路径解析框架。实际 profile 路径切换将在 Deploy-0C 进行。

### 6.3 兼容风险

当前开发环境使用 `profiles/default` 作为默认 profile。切换为 `profiles/{tenantId}/{siteId}/{windowId}/` 后：
- 已登录的 profile 需要迁移或重新登录
- Deploy-0C 实施时需提供迁移脚本

---

## 7. Local Runtime 最小边界

### 7.1 新增类型

`packages/agent/src/local-runtime/types.ts`：

```ts
type LocalWindowCommandType = 'open_window' | 'close_window' | 'restart_window' | 'refresh_status';

interface LocalWindowCommand { ... }
interface LocalWindowStatus { ... }
```

### 7.2 新增配置函数

`packages/agent/src/config.ts`：

```ts
export function getConfig(): AgentConfig { ... }
export function getLocalRoot(): string { ... }
export function resolveChromePath(): string { ... }  // (planned, not yet exported)
export function resolveProfilePath(tenantId, siteId, windowId): string { ... }  // (planned)
```

### 7.3 未接入生产路径

- `types.ts` 仅在 `local-runtime/` 目录中，无任何 import
- `getConfig()` 已被 `ChromeProcessGuard` 使用（路径相对化）
- 其余函数仅定义，未被生产路径调用
- 这是为 Deploy-0C/0D 准备的最小基础

---

## 8. 不变项确认

本次 Deploy-0B **没有修改** 以下核心模块：

- ArrivalExecutor — 到件扫描执行器
- DispatchExecutor — 派件扫描执行器
- IntegratedExecutor — 到派一体执行器
- SignExecutor — 签收录入执行器
- READY-window 匹配逻辑（四个 Executor 中的 CDP 窗口匹配）
- CDP 接管执行逻辑（`BrowserManager.connectExisting`）
- dryRunMode / ENABLE_REAL_SUBMIT 安全门
- Task Center 日志策略（TaskLogService / TaskLogManager）
- 任务创建 / 任务拉取主链路

---

## 9. 验证结果

| 验证项 | 结果 |
|---|---|
| Backend TypeScript | 通过 |
| Frontend TypeScript | 通过 |
| Packages/agent TypeScript | 通过 |
| EasyBR 关键词（生产代码） | 仅剩 D-0B 注释和 410 Gone 消息，无实际调用 |
| browerid 关键词（生产代码） | 仅剩 410 Gone 路由参数和配置字段 |
| getBrowerList / openedList / toggleWindow | 生产代码中 0 匹配 |
| 硬编码 Chrome 路径（Agent 源码） | 0 匹配 |
| E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe | 仅存在于 `docs/deploy/` 历史报告中 |

---

## 10. 遗留风险

| 编号 | 风险 | 等级 | Deploy-0C/0D 处理 |
|---|---|---|---|
| R1 | EasyBRClient.ts / BrowserPool.ts 未物理删除，存在代码腐化风险 | P2 | Deploy-0D 可物理删除 |
| R2 | Header Playwright 路径仍直接调用 Backend API | P1 | Deploy-0D Window Command 迁移 |
| R3 | profile 路径未实际切换到 `profiles/{tenantId}/{siteId}/{windowId}/` | P2 | Deploy-0C 实施 |
| R4 | Backend `routes.ts` 中 `/api/status` 还调用了 RuntimeStatus.getSummary() 兼容逻辑 | P3 | 逐步清理 |

---

## 11. 本次是否提交 Git

**否。** 等待用户确认后再决定是否提交。

---

## 12. 通过标准核对

1. EasyBR 启动入口不再存在于生产路径
2. Header 不再调用 EasyBR legacy API
3. Backend 启动不再初始化 EasyBR
4. Frontend 不再混用 EasyBR 状态源
5. 生产代码中不再出现 EasyBR 实际调用
6. 生产代码中不再使用 `browerid` 旧字段名（仅保留 410 Gone 路由参数）
7. 便携 Chrome 绝对路径不再写死
8. Local Runtime 目录结构和路径边界已明确
9. 当前 V3 Playwright 过渡路径仍可用
10. 四个业务执行层未被修改
11. TypeScript 检查全部通过
12. 输出完整验收报告
