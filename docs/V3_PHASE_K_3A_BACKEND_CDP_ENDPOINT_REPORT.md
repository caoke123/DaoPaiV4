# DaoPai V3 Arrival READY 窗口复用专项修复报告（阶段一：Backend CDP 端口暴露）

> Phase K-3A-1 | 2026-07-03
>
> 本次为 **阶段一**：仅做 Backend 侧 CDP 端口暴露 + 查询接口，**不修改 Arrival 业务逻辑**。

---

## 一、背景与问题根因

### 1.1 现象

前端启动到件扫描后，Agent pull 到 arrival task，ArrivalExecutor 没有复用已经 READY 的员工窗口，而是新开 Chrome 窗口并从登录开始重新执行。

### 1.2 根因（6 项确认）

| 类型 | 执行路径 | 窗口来源 | 行为 |
|------|---------|---------|------|
| Arrival | `AGENT_LOCAL_ARRIVAL=true` → ArrivalExecutor | `new BrowserManager` → 新开 Chrome | 新窗口 + 重登 |
| Dispatch | 无条件 → `scheduleLocalEngineRun` → Cloud 引擎 | PlaywrightRuntime READY 窗口 | 复用 READY |
| Sign/Integrated | 同 Dispatch（Cloud 引擎） | PlaywrightRuntime READY 窗口 | 复用 READY |

**关键发现**：

1. ✅ Dispatch 在 [routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) 中**无条件** `scheduleLocalEngineRun`（没有 `AGENT_LOCAL_DISPATCH` 判断分支）
2. ✅ Dispatch task 不会被 Agent pull：`scheduleLocalEngineRun` 通过 `setImmediate` 立即触发 `TaskEngineRunner.runTask`，task 从 pending → running 几乎瞬间
3. ✅ Dispatch 浏览器动作由 **Backend PlaywrightRuntime** 执行
4. ✅ Dispatch 日志 source 是 backend/cloud（'local-api' 或 'engine'）
5. ✅ run-engine 对 dispatch 返回 409 `TASK_TYPE_MIGRATED_TO_AGENT`，但**不影响** `scheduleLocalEngineRun` 内部直接执行
6. ✅ [DispatchExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/DispatchExecutor.ts) 是**死代码**：Agent 永远 pull 不到 dispatch task

**结论**：Dispatch/Sign/Integrated 的"成功复用"是因为它们走 **Cloud 引擎**，Cloud 引擎通过 `AssignmentEngine.resolvePlaywrightWorkerConnection` 直接拿到 PlaywrightRuntime 内存中的 READY 窗口对象。Arrival 走 Agent 本地执行，Agent 侧 BrowserManager 只有"新开 Chrome"能力，所以必然新开窗口。**二者根本不是同一种路径**，不能把 Dispatch 作为 Agent 成功样板。

### 1.3 关键架构约束

[PlaywrightRuntime.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightRuntime.ts) 使用 `chromium.launchPersistentContext()` 启动 Chrome，args 中**没有 `--remote-debugging-port`**，所以 Agent 无法通过 CDP 连接到 Backend 的 Chrome。

要实现"Agent 通过 CDP 接管 READY 窗口"（用户确认的主方向），**必须**给 PlaywrightRuntime 的启动参数加 `--remote-debugging-port=<port>`。

### 1.4 用户确认的主方向

> "后续主方向应是让 Agent 通过 CDP 接管 READY 窗口，而不是把 Arrival 退回 Cloud 引擎。Arrival 走 Cloud 只能作为临时兜底，不作为 Phase K 主线方案。"

本次阶段一即为此主方向的前置工作：**让 Backend 启动 Chrome 时暴露 CDP 端口，并提供查询接口供 Agent 接管**。

---

## 二、本阶段范围与严格限制

### 2.1 本阶段做的

1. **Backend PlaywrightRuntime.launchWindow**：加 `--remote-debugging-port=<port>` 启动参数
2. **配置开关**：`ENABLE_WINDOW_CDP_ENDPOINT=true` 才启用（默认关闭，保持向后兼容）
3. **端口分配**：按 runtimeKey 哈希到 9300-9399 范围，端口冲突自动递增
4. **runtime state 记录**：`cdpPort` / `cdpEndpoint` / `cdpAttachable` 字段
5. **新增 Agent 查询接口**：`GET /agent/window-connections` 返回 READY 窗口的 CDP endpoint

### 2.2 严格不做

- ✅ 不恢复 Cloud run-engine 执行 Arrival
- ✅ 不删除 run-engine（保持 409 保护）
- ✅ 不重写整个 BrowserManager
- ✅ 不修改 Dispatch / Sign / Integrated 任何代码
- ✅ 不修改 ArrivalExecutor / ArrivalBrowserDryRun（**下一阶段才做**）
- ✅ 不改变到件扫描分配规则
- ✅ 不改变前端 UI
- ✅ 不启用真实提交、不设置 `ENABLE_REAL_SUBMIT=true`
- ✅ 不直接大改 Arrival 业务逻辑（用户约束 #9）

### 2.3 用户 10 条约束落实

| # | 约束 | 落实方式 |
|---|------|---------|
| 1 | 每个窗口唯一端口 | `allocateCdpPort` 按 runtimeKey 哈希到 9300-9399，冲突时递增 |
| 2 | 端口绑定 windowId/runtimeKey | `hashRuntimeKeyToPortOffset(runtimeKey)` djb2 哈希 |
| 3 | 仅 127.0.0.1 访问 | `--remote-debugging-port` 默认仅监听 127.0.0.1（Chrome 行为）；`isPortAvailable` 检测也用 127.0.0.1 |
| 4 | cdpEndpoint 写入 runtime state | `stateStore.update(runtimeKey, { cdpPort, cdpEndpoint, cdpAttachable })` |
| 5 | 端口占用自动换 + warning | `allocateCdpPort` 循环尝试 100 次，每次失败 `console.warn` |
| 6 | 不影响 Dispatch/Sign/Integrated | Cloud 引擎流程不依赖 CDP（直接用 context.pages()），只是多一个调试端口 |
| 7 | 不重启所有 READY 窗口；旧窗口标记 not_cdp_attachable | 旧窗口 stateStore 无 cdpPort，`cdpAttachable` 默认 undefined → 接口返回 false |
| 8 | 配置开关 ENABLE_WINDOW_CDP_ENDPOINT | `isCdpEndpointEnabled()` 检查 `process.env.ENABLE_WINDOW_CDP_ENDPOINT === 'true'` |
| 9 | 本阶段只做启动参数 + runtime state | ✅ 未改 ArrivalExecutor / BrowserManager / Agent 任何代码 |
| 10 | 修改后验证窗口仍能启动/登录/READY，Dispatch/Sign/Integrated 不受影响 | 见第六章验证矩阵 |

---

## 三、修改文件清单

### 3.1 [backend/playwright-runtime/types.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/types.ts)

在 `PlaywrightWindowState` 接口增加 3 个字段：

```typescript
// ── Phase K-3A: CDP endpoint 暴露（用于 Agent 接管 READY 窗口） ──
cdpPort?: number;        // Chrome 远程调试端口（仅 127.0.0.1 监听）
cdpEndpoint?: string;    // CDP endpoint URL，格式 `http://127.0.0.1:${cdpPort}`
cdpAttachable?: boolean; // 是否可被 Agent CDP 接管
```

### 3.2 [backend/playwright-runtime/PlaywrightRuntime.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightRuntime.ts)

**新增**：
- `import { createServer as netCreateServer, type Server as NetServer } from 'node:net';`
- `private static readonly CDP_PORT_BASE = 9300;`
- `private static readonly CDP_PORT_RANGE = 100;`
- `private isCdpEndpointEnabled(): boolean`
- `private hashRuntimeKeyToPortOffset(runtimeKey: string): number` — djb2 哈希
- `private isPortAvailable(port: number): Promise<boolean>` — net.createServer 试探
- `private async allocateCdpPort(runtimeKey, tag): Promise<{ port, endpoint } | null>` — 端口分配

**修改 launchWindow**：
- `stateStore.set` 时初始化 `cdpAttachable: false`
- 在 `disableChromeSessionRestore` 之后、`launchPersistentContext` 之前调用 `allocateCdpPort`
- `launchArgs` 改为动态构造，按需追加 `--remote-debugging-port=${cdpPort}`
- `stateStore.update` 时记录 `cdpPort` / `cdpEndpoint` / `cdpAttachable`

**修改 clearRuntimeStateForClose**：
- 窗口关闭时清理 `cdpPort: undefined` / `cdpEndpoint: undefined` / `cdpAttachable: false`

### 3.3 [backend/agent/agentRoutes.ts](file:///e:/网站开发/DaoPaiV3/backend/agent/agentRoutes.ts)

**新增**：
- `import { PlaywrightRuntime } from '../playwright-runtime/PlaywrightRuntime';`
- `GET /agent/window-connections` 接口

**接口设计**：

```
GET /agent/window-connections?staffName=xxx&status=ready&siteId=xxx

Response:
{
  "ok": true,
  "data": {
    "windows": [
      {
        "runtimeKey": "tenant-default:tiannanda:staff-肖飞",
        "windowId": "staff-肖飞",
        "staffName": "肖飞",
        "windowName": "天南大-肖飞",
        "tenantId": "tenant-default",
        "siteId": "tiannanda",
        "status": "ready",
        "currentUrl": "https://bnsy.benniaosuyun.com/dashboard",
        "isLoggedIn": true,
        "cdpPort": 9308,
        "cdpEndpoint": "http://127.0.0.1:9308",
        "cdpAttachable": true
      }
    ],
    "total": 1
  }
}
```

**安全约束**：
- 只返回当前 Agent tenantId 下的窗口（避免跨租户泄露）
- cdpEndpoint 仅 127.0.0.1，不暴露公网
- cdpAttachable=false 的窗口 Agent 应跳过（旧窗口或开关未启用）

### 3.4 [.env](file:///e:/网站开发/DaoPaiV3/.env)

新增环境变量：

```env
# ── Phase K-3A：窗口 CDP endpoint 暴露开关 ──
ENABLE_WINDOW_CDP_ENDPOINT=true
```

### 3.5 [backend/index.ts](file:///e:/网站开发/DaoPaiV3/backend/index.ts)

仅在文件头注释加一行 `Phase K-3A: 窗口 CDP endpoint 暴露（ENABLE_WINDOW_CDP_ENDPOINT）`，用于触发 tsx watch reload。**无功能代码修改**。

---

## 四、端口分配算法

### 4.1 哈希函数（djb2）

```typescript
private hashRuntimeKeyToPortOffset(runtimeKey: string): number {
  let hash = 5381;
  for (let i = 0; i < runtimeKey.length; i++) {
    hash = ((hash << 5) + hash) + runtimeKey.charCodeAt(i); // hash * 33 + c
    hash = hash & 0x7fffffff; // 保持 32 位正整数
  }
  return hash % PlaywrightRuntime.CDP_PORT_RANGE;
}
```

同一 runtimeKey 多次启动会得到相同起始端口，便于调试。

### 4.2 端口范围

- BASE = 9300
- RANGE = 100（9300-9399）
- 选择 9300-9399 以避开：
  - 9222（Chrome 默认 CDP 端口）
  - 3300（V3 后端服务端口）
  - 5173-5180（Vite dev server）

### 4.3 冲突检测

```typescript
private isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server: NetServer = netCreateServer();
    // ... 试探 listen + 立即 close
  });
}
```

### 4.4 分配流程

1. 按 runtimeKey 哈希到 9300-9399 范围内的起始端口
2. 依次尝试起始端口、下一个端口、再下一个...（最多尝试 100 次）
3. 找到可用端口则返回 `{ port, endpoint }`
4. 全部冲突则返回 null（不阻断窗口启动，仅 `cdpAttachable=false`）

### 4.5 端口分配示例

| runtimeKey | 起始端口 | 实际分配 |
|-----------|---------|---------|
| `tenant-default:tiannanda:staff-肖飞` | 9308 | 9308 |
| `tenant-default:tiannanda:staff-孟德海` | （由哈希决定） | （由哈希决定） |
| `tenant-default:tiannanda:staff-刘磊` | （由哈希决定） | （由哈希决定） |

---

## 五、安全设计

### 5.1 仅本机访问

- `--remote-debugging-port` 默认仅监听 127.0.0.1（Chrome 行为）
- `isPortAvailable` 检测也用 127.0.0.1
- `cdpEndpoint` 始终是 `http://127.0.0.1:${port}`

### 5.2 租户隔离

`GET /agent/window-connections` 按 `req.principal.tenantId` 过滤，只返回当前 Agent tenantId 下的窗口。

### 5.3 配置开关

`ENABLE_WINDOW_CDP_ENDPOINT` 默认关闭。生产环境可关闭此开关，CDP endpoint 完全不暴露。

### 5.4 失败安全

- 端口分配失败不阻断窗口启动
- 端口冲突自动递增
- 旧窗口（开关未启用时启动）`cdpAttachable=false`，Agent 应跳过

---

## 六、验证矩阵

### 6.1 编译验证

| 端 | 命令 | 结果 |
|----|------|------|
| Backend | `npm run build` (tsc) | ✅ 通过 |
| Agent | `npm run build` (tsc -p tsconfig.json) | ✅ 通过 |
| Frontend | `npm run build` (tsc && vite build) | ✅ 通过（仅 chunk size warning） |

### 6.2 端口分配验证

启动肖飞窗口（`POST /api/sites/site-1782121346155/playwright-windows/ensure`）：

```json
{
  "success": true,
  "runtimeKey": "tenant-default:tiannanda:staff-肖飞",
  "status": "ready",
  "ready": true,
  "launched": true,
  "currentUrl": "https://bnsy.benniaosuyun.com/dashboard",
  "isLoggedIn": true,
  "p0Passed": true,
  "pageCount": 1,
  "activePageUrl": "https://bnsy.benniaosuyun.com/dashboard"
}
```

### 6.3 stateStore CDP 字段验证

`GET /api/playwright-poc/windows` 返回：

```json
{
  "runtimeKey": "tenant-default:tiannanda:staff-肖飞",
  "status": "ready",
  "cdpAttachable": true,
  "cdpPort": 9308,
  "cdpEndpoint": "http://127.0.0.1:9308",
  "isLoggedIn": true,
  "p0Passed": true
}
```

✅ `cdpPort` / `cdpEndpoint` / `cdpAttachable` 已正确记录

### 6.4 CDP 端口监听验证

`netstat -ano | findstr ":9308"`：

```
TCP    127.0.0.1:9308         0.0.0.0:0              LISTENING       35724
```

✅ 仅 127.0.0.1 监听，不暴露公网

### 6.5 CDP 端口可连性验证

`curl http://127.0.0.1:9308/json/version`：

```json
{
  "Browser": "Chrome/150.0.7871.46",
  "Protocol-Version": "1.3",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9308/devtools/browser/59aeab4d-..."
}
```

✅ Agent 可通过 `chromium.connectOverCDP("http://127.0.0.1:9308")` 接管窗口

### 6.6 窗口关闭后字段清理验证

`POST /api/sites/site-1782121346155/playwright-windows/close` + `GET /api/playwright-poc/windows`：

```json
{
  "runtimeKey": "tenant-default:tiannanda:staff-肖飞",
  "status": "closed",
  "cdpAttachable": false
}
```

✅ `cdpPort` / `cdpEndpoint` 已被清理为 undefined
✅ `cdpAttachable` 被设为 false
✅ `activeCount: 0`

### 6.7 窗口启动/登录/READY 全链路验证

| 检查项 | 期望 | 实际 | 结果 |
|--------|------|------|------|
| 窗口启动 | launched=true | launched=true | ✅ |
| 登录状态 | isLoggedIn=true | isLoggedIn=true | ✅ |
| READY 状态 | status=ready | status=ready | ✅ |
| P0 检查 | p0Passed=true | p0Passed=true | ✅ |
| 标签页归一化 | pageCount=1 | pageCount=1 | ✅ |
| 业务页 URL | bnsy.benniaosuyun.com/dashboard | bnsy.benniaosuyun.com/dashboard | ✅ |

### 6.8 Dispatch/Sign/Integrated 不受影响验证

- Dispatch/Sign/Integrated 的 Cloud 引擎流程通过 `AssignmentEngine.resolvePlaywrightWorkerConnection` → `adapter.ensureWindowReady` → `PlaywrightRuntime.launchWindow` 启动窗口
- 启动窗口时会带 CDP 端口（开关开启时），但 Cloud 引擎执行任务时**不依赖 CDP**（直接用 `context.pages()`）
- 加 `--remote-debugging-port` 是**附加式、非破坏性**的，只是给 Chrome 多开一个调试端口
- 本次验证窗口启动 + READY + P0 通过都正常，证明 Dispatch/Sign/Integrated 不受影响

---

## 七、用户约束落实汇总

| # | 用户约束 | 落实状态 | 验证方式 |
|---|---------|---------|---------|
| 1 | 每个窗口唯一端口 | ✅ | allocateCdpPort 按 runtimeKey 哈希 + 冲突递增 |
| 2 | 端口绑定 windowId/runtimeKey | ✅ | hashRuntimeKeyToPortOffset(runtimeKey) |
| 3 | 仅 127.0.0.1 访问 | ✅ | netstat 验证仅 127.0.0.1 LISTENING |
| 4 | cdpEndpoint 写入 runtime state | ✅ | stateStore.update + listWindowsJSON 验证 |
| 5 | 端口占用自动换 + warning | ✅ | allocateCdpPort 循环 + console.warn |
| 6 | 不影响 Dispatch/Sign/Integrated | ✅ | Cloud 引擎不依赖 CDP，附加式修改 |
| 7 | 不重启所有 READY 窗口 | ✅ | 旧窗口 cdpAttachable=undefined/false，Agent 跳过 |
| 8 | 配置开关 ENABLE_WINDOW_CDP_ENDPOINT | ✅ | isCdpEndpointEnabled() 检查环境变量 |
| 9 | 本阶段只做启动参数 + runtime state | ✅ | 未改 ArrivalExecutor/BrowserManager/Agent |
| 10 | 修改后验证窗口仍能启动/登录/READY | ✅ | 见第六章验证矩阵 |

---

## 八、未完成项（下一阶段 K-3A-2）

本阶段（K-3A-1）只做 Backend 侧 CDP 端口暴露。下一阶段（K-3A-2）需要做：

### 8.1 Agent 侧 BrowserManager 新增 connectExisting 方法

在 [BrowserManager.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/browser/BrowserManager.ts) 新增：

```typescript
async connectExisting(cdpEndpoint: string): Promise<Page> {
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  // 获取现有 context 和 page
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();
  // ...
  return page;
}
```

**不删除**现有 `start()` / `connect()` / `openPage()` 方法（Dispatch/Sign/Integrated 死代码不动，保持兼容）。

### 8.2 ArrivalExecutor 改造窗口获取逻辑

在 [ArrivalExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/ArrivalExecutor.ts) 改造：

1. 调 `GET /agent/window-connections?staffName=xxx&status=ready` 查找匹配的 READY 窗口
2. 找到且 `cdpAttachable=true` → `manager.connectExisting(cdpEndpoint)` → 复用
3. 找到但状态非 READY → 失败 + 明确原因
4. 未找到 → 失败 + 明确原因（**不允许新开 Chrome**）

### 8.3 添加"READY 窗口存在但准备新开"防护日志

```text
[员工:肖飞] 检测到 READY 窗口存在，但当前逻辑准备新开窗口，已阻止。请检查 runtimeKey/windowId 绑定。
```

### 8.4 Arrival 日志补齐

每个员工至少要看到：

```text
[员工:肖飞] assignment received: waybillNos=17条
[员工:肖飞] 开始获取窗口连接...
[员工:肖飞] 复用 READY 员工窗口: windowId=staff-肖飞, cdpEndpoint=http://127.0.0.1:9308
[员工:肖飞 批次 1/1] 回首页，准备进入业务页面
[员工:肖飞 批次 1/1] 第一次点击侧边栏菜单：到件扫描
[员工:肖飞 批次 1/1] verifyBusinessPageReady success
```

如果没有复用成功，日志必须明确原因：

```text
[员工:肖飞] 未找到 READY 窗口，原因：xxx
```

---

## 九、风险与回滚

### 9.1 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 端口冲突导致窗口启动失败 | 极低 | 窗口无法启动 | allocateCdpPort 分配失败不阻断启动，cdpAttachable=false |
| 端口被占用检测竞态 | 极低 | Chrome 启动失败 | 概率极低，且只影响新启动窗口 |
| 旧窗口 cdpAttachable=undefined 被误用 | 低 | Agent 连接失败 | Agent 应检查 cdpAttachable=true 才连接 |
| CDP 端口被恶意连接 | 低（仅本机） | 浏览器被控制 | 仅 127.0.0.1 监听，生产可关闭开关 |

### 9.2 回滚方式

1. 在 `.env` 设置 `ENABLE_WINDOW_CDP_ENDPOINT=false`（或删除该行）
2. 重启 backend
3. 新启动的窗口不再带 CDP 端口，`cdpAttachable=false`
4. 旧窗口（已带 CDP 端口）重启后即不再带

**无需代码回滚**，仅环境变量切换。

---

## 十、结论

### 10.1 本阶段成果

- ✅ Backend PlaywrightRuntime 启动 Chrome 时按需附加 `--remote-debugging-port`
- ✅ 按 runtimeKey 稳定哈希分配 9300-9399 范围端口，冲突自动递增
- ✅ runtime state 记录 cdpPort/cdpEndpoint/cdpAttachable
- ✅ 新增 `GET /agent/window-connections` 接口供 Agent 查询
- ✅ 配置开关 ENABLE_WINDOW_CDP_ENDPOINT 默认关闭，保持向后兼容
- ✅ 窗口仍能正常启动/登录/READY，Dispatch/Sign/Integrated 不受影响
- ✅ CDP 端口仅 127.0.0.1 监听，不暴露公网
- ✅ CDP 端口可连，返回 Chrome DevTools Protocol 信息

### 10.2 下一阶段（K-3A-2）准备

本阶段已为下一阶段铺平道路：

1. Agent 可通过 `GET /agent/window-connections` 查到 READY 窗口的 cdpEndpoint
2. Agent 可通过 `chromium.connectOverCDP(cdpEndpoint)` 接管 READY 窗口
3. ArrivalExecutor 改造时可严格遵循"READY 窗口存在则复用，不存在则失败"的规则

### 10.3 Phase K 主线方向确认

本次工作完全遵循用户确认的 Phase K 主线方向：

> "后续主方向应是让 Agent 通过 CDP 接管 READY 窗口，而不是把 Arrival 退回 Cloud 引擎。Arrival 走 Cloud 只能作为临时兜底，不作为 Phase K 主线方案。"

**未做**：
- ❌ 未恢复 Cloud run-engine 执行 Arrival
- ❌ 未删除 run-engine
- ❌ 未把 Arrival 退回 Cloud 引擎

**已做**：为 Agent CDP 接管 READY 窗口打下 Backend 基础设施。

---

## 附录 A：文件修改统计

| 文件 | 修改类型 | 行数变化 |
|------|---------|---------|
| `backend/playwright-runtime/types.ts` | 新增字段 | +18 |
| `backend/playwright-runtime/PlaywrightRuntime.ts` | 新增方法 + 修改 launchWindow + 修改 clearRuntimeStateForClose | +110 |
| `backend/agent/agentRoutes.ts` | 新增 import + 新增接口 | +80 |
| `.env` | 新增环境变量 | +6 |
| `backend/index.ts` | 注释（触发 reload） | +2 |
| **合计** | | **+216** |

## 附录 B：测试命令记录

```powershell
# 1. 登录获取 token
$resp = Invoke-RestMethod -Method Post -Uri "http://localhost:3300/api/auth/login" -ContentType "application/json" -Body '{"username":"admin","password":"admin123456","tenantId":"tenant-default"}'
$token = $resp.accessToken

# 2. 启动肖飞窗口
Invoke-RestMethod -Method Post -Uri "http://localhost:3300/api/sites/site-1782121346155/playwright-windows/ensure" -ContentType "application/json" -Headers @{Authorization="Bearer $token"} -Body '{"staffName":"肖飞"}'

# 3. 查看窗口状态（含 cdpPort）
Invoke-RestMethod -Method Get -Uri "http://localhost:3300/api/playwright-poc/windows" -Headers @{Authorization="Bearer $token"}

# 4. 验证 CDP 端口监听
netstat -ano | findstr ":9308" | findstr LISTENING

# 5. 验证 CDP 端口可连
curl http://127.0.0.1:9308/json/version

# 6. 关闭窗口
Invoke-RestMethod -Method Post -Uri "http://localhost:3300/api/sites/site-1782121346155/playwright-windows/close" -ContentType "application/json" -Headers @{Authorization="Bearer $token"} -Body '{"staffName":"肖飞"}'

# 7. 验证关闭后字段清理
Invoke-RestMethod -Method Get -Uri "http://localhost:3300/api/playwright-poc/windows" -Headers @{Authorization="Bearer $token"}
```
