# DaoPai V3 回滚后窗口状态审查报告

## 1. 当前代码基线

- **HEAD commit**: `ef38f2256b8ce1ac7759ee072e091ac1fd44a2c6` (feat: persist agent window status and prepare local runtime)
- **git status**: Clean (除运行期产生的 untracked logs/data 外，无代码变更)。
- **V4 残留文件**: 未发现 `AgentWebSocket.ts`, `AgentWsClient.ts` 等核心迁移文件。
- **V4 逻辑残留**: 搜索未发现 `command_available`, `EventSource`, `/agent/ws` 等 V4 实时通信关键词。
- **数据库残留**: 
    - 存在 `window_commands` 表（V4 遗留表，V3 逻辑未使用）。
    - `window_status` 表中存在 `site_id` 为 UUID 格式（如 `site-1782121346155`）的旧数据。

## 2. 当前问题现象

- **现象**: Header 点击员工 Tag 可以正常启动 Chrome，页面已进入 dashboard，但 Header Tag 持续显示为灰色（离线）。
- **确认**: 后端 `PlaywrightRuntime` 内存状态已更新为 `ready`，且 P0 校验通过。

## 3. Header 状态数据来源

- **列表来源**: `WindowStateProvider.tsx` 初始从设置中心获取完整窗口列表。
- **状态来源**: 
    1. 优先调用 `getCloudWindowStatus(activeSiteId)` (查询 PG `window_status` 表)。
    2. 如果返回记录数 > 0，则**直接使用**并 return。
    3. 只有当 Cloud 无数据时，才调用 `getSitePlaywrightWindows` (查询后端内存状态)。
- **Ready 判断规则**: `lib/window-status.ts` 中的 `isPlaywrightReallyReady` 守卫非常严格（需满足状态、P0、URL、PageCount 等 7 项条件）。

## 4. 窗口启动链路

- **链路**: Header (`handleInitWindow`) -> `ensurePlaywrightWindow` (API) -> `windowRuntimeRoutes.ts` -> `PlaywrightRuntime` -> Chrome Launch -> P0 Check -> Update Memory State.
- **状态写入**:
    - **内存**: `PlaywrightRuntime` 维护最新的实时状态。
    - **数据库**: Agent 每 5s 从后端读取内存状态并上报到 Cloud，写入 `window_status` 表。
- **差异点**: Agent 上报时使用的 `site_id` 是转换后的 `siteCode` (如 `tiannanda`)，而前端查询使用的是 `siteId` (UUID)。

## 5. window_status 状态检查

经数据库审计，`window_status` 表中存在以下冲突数据：
- **UUID 条目**: `site_id: "site-1782121346155"`, `status: "offline"` (旧数据污染)。
- **Code 条目**: `site_id: "tiannanda"`, `status: "ready"` (Agent 最新上报)。

## 6. 数据库 / 迁移残留

- `window_commands`: 存在，属于 V4 残留，建议清理。
- `window_status`: 存在 siteId 不一致的残留数据，直接导致了前端状态显示异常。

## 7. 根因判断

**核心原因：状态源冲突 + ID 映射不一致 + Fallback 阻断**

1. **ID 错位**: Agent 上报状态使用 `tiannanda`，前端查询使用 `site-1782121346155`。
2. **残留干扰**: 数据库中残留了该 UUID 对应的 `offline` 记录。
3. **逻辑阻断**: 前端 `WindowStateProvider` 发现数据库有记录（即使是旧的离线记录），就认为 Cloud 状态有效，从而**不再查询**后端 `PlaywrightRuntime` 的真实 `ready` 状态。

## 8. 最小修复建议

1. **清理数据库 (必须)**: 清空 `window_status` 和 `window_commands` 表，消除旧数据污染。
2. **修正前端逻辑 (推荐)**: 调整 `WindowStateProvider.tsx`，合并 Cloud 状态与 Playwright 实时状态，而不是简单的 `if...return`。在 V3 版本中，应以 Playwright 实时状态为最高优先级。
3. **对齐 ID 映射**: 确保 Agent 上报和前端查询使用的 `siteId` 规范一致。

## 9. 验证建议

- 清理数据库后，观察 Header Tag 是否能正常变绿。
- 启动窗口后，确认 Tag 变为绿色“就绪”。
- 刷新页面，确认状态依然保持“就绪”。
- 测试至少一个到件任务，确保窗口可用性。

## 10. 是否修改代码

**本次审查阶段：否。**
等待用户确认报告内容及修复方案后再行操作。
