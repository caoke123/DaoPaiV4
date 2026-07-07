# DaoPai V3 Phase 5-H：主线回归审查报告

**日期**: 2026-07-02  
**审查范围**: 四条业务链路、窗口稳定性、日志系统、站点员工配置  
**审查方式**: 只读代码审查，未修改任何代码

---

## 一、当前已完成的修复（已通过人工测试）

| 修复项 | 状态 | 对应阶段 |
|--------|:----:|---------|
| 业务页面实时日志显示 | ✅ 通过 | Phase 5-G-2 |
| 员工窗口登录稳定 | ✅ 通过 | Phase 5-G-7 |
| 业务页面进入策略（菜单优先+URL兜底） | ✅ 通过 | Phase 5-G-8-6 |
| 关闭/启动Chrome清理标签页 | ✅ 通过 | Phase 5-G-8-5 |
| 首页恢复后清理native alert + DOM弹窗 | ✅ 通过 | Phase 5-G-8-3/4 |
| 派件扫描填写单号 | ✅ 通过 | Phase 5-G-8-7 |
| 全局原生Alert自动处理 | ✅ 通过 | Phase 5-G-8-3 |
| 充值弹窗"取消"按钮清理 | ✅ 通过 | Phase 5-G-8-2 |

---

## 二、四条业务链路状态

### 2.1 到件扫描（Arrival）

| 检查项 | 状态 | 说明 |
|--------|:----:|------|
| 前端页面 | ✅ | ArrivalPage.tsx → ScanWorkbench → submitTask(`/api/operations/arrive`) |
| 后端接口 | ✅ | routes.ts:978，PG主写 + DB镜像 |
| Handler接入 | ✅ | ArrivalHandler → TaskEngineRunner → AssignmentEngine |
| 员工窗口执行 | ✅ | ArriveScanBatch.ts 调用 PlaywrightRuntime 窗口 |
| 新导航策略 | ✅ | navigateToBusinessPage(page, 'arrival') (L167) |
| 弹窗清理 | ✅ | 通过 navigateToBusinessPage 内部间接调用 |
| 实时日志 | ✅ | SSE + PG轮询双通道 |
| 任务结束回首页 | ✅ | AssignmentEngine.finally → restoreCleanHome |
| 执行模式 | **dry-run** | dryRunMode=true，跳过最终提交 |
| 已知问题 | — | drainNativeAlerts 冗余 import |

### 2.2 派件扫描（Dispatch）

| 检查项 | 状态 | 说明 |
|--------|:----:|------|
| 前端页面 | ✅ | DispatchPage.tsx → ScanWorkbench → submitTask(`/api/operations/dispatch`) |
| 后端接口 | ✅ | routes.ts:1088 |
| Handler接入 | ✅ | DispatchHandler → DispatchScan.executeOneStaff |
| 员工窗口执行 | ✅ | DispatchScan.ts 使用 PlaywrightRuntime 窗口 |
| 新导航策略 | ✅ | navigateToBusinessPage(page, 'dispatch') (L164) |
| 弹窗清理 | ✅ | 同上间接调用 |
| 实时日志 | ✅ | SSE + PG轮询双通道 |
| 任务结束回首页 | ✅ | 同上 |
| 执行模式 | **dry-run** | dryRunMode=true，跳过上传 |
| 已知问题 | — | 无 |

### 2.3 到派一体（Integrated）

| 检查项 | 状态 | 说明 |
|--------|:----:|------|
| 前端页面 | ✅ | IntegratedPage.tsx → ScanWorkbench → submitTask(`/api/operations/integrated`) |
| 后端接口 | ✅ | routes.ts:1211 |
| Handler接入 | ✅ | IntegratedHandler → IntegratedScan.executeOneStaff |
| 员工窗口执行 | ✅ | IntegratedScan.ts 使用 PlaywrightRuntime 窗口 |
| 新导航策略 | ✅ | navigateToBusinessPage(page, 'integrated') (L209) |
| 弹窗清理 | ✅ | 同上间接调用 |
| 实时日志 | ✅ | SSE + PG轮询双通道 |
| 任务结束回首页 | ✅ | 同上 |
| 执行模式 | **dry-run** | dryRunMode=true，跳过最终提交 |
| 已知问题 | — | credentials.ts 仍被直接引用（未收敛到SettingsManager） |

### 2.4 签收录入（Sign）

| 检查项 | 状态 | 说明 |
|--------|:----:|------|
| 前端页面 | ✅ | SignPage.tsx（独立实现，非ScanWorkbench）→ submitTask(`/api/operations/sign`) |
| 后端接口 | ✅ | routes.ts:1334 |
| Handler接入 | ✅ | SignHandler → SignScan.executeSign |
| 员工窗口执行 | ✅ | SignScan.ts 使用 PlaywrightRuntime 窗口 |
| 新导航策略 | ✅ | navigateToBusinessPage(page, 'sign') (L80) |
| 弹窗清理 | ✅ | 同上间接调用 |
| 实时日志 | ✅ | SSE + PG轮询双通道 |
| 任务结束回首页 | ✅ | 同上 |
| 执行模式 | **dry-run** | isDryRun默认true（安全兜底），停止在确认弹窗前 |
| 已知问题 | — | dryRun默认值与其他链路不一致 |

### 链路总结

四条链路代码结构完整、全链路贯通。**当前全部处于 dry-run 模式**，未接入真实业务提交。

---

## 三、窗口与登录稳定性闭环（8/8 通过）

| 项 | 状态 | 关键实现 |
|---|:----:|---------|
| 1. 启动时只保留一个干净首页标签 | ✅ | normalizeTabsForWindow: 关闭多余标签 + goto(/dashboard) + 清弹窗 |
| 2. 关闭时清理所有页面标签 | ✅ | cleanupAllTabsBeforeClose: 逐个close，异常只warn |
| 3. 首页恢复后清理native alert | ✅ | ensureCleanHome/restoreCleanHome: drainNativeAlerts 5处调用 |
| 4. 首页恢复后清理DOM弹窗 | ✅ | dismissRechargeCancelDialog 多处调用 |
| 5. 页面变化后持续清理弹窗 | ✅ | afterPageChangedCleanup 9个调用点全覆盖 |
| 6. READY基于归一化mainPage | ✅ | launchWindow使用normalizeTabsForWindow返回值，不用context.pages()[0] |
| 7. 业务任务不复用旧页面 | ✅ | navigateToBusinessPage先ensureCleanHome再导航 |
| 8. 多窗口按runtimeKey隔离 | ✅ | stateStore Map + 独立userDataDir + 独立BrowserContext |

---

## 四、日志与任务中心

| 项 | 状态 | 说明 |
|---|:----:|------|
| 1. 日志实时写入PG | ✅ | TaskLogService同步await + AssignmentEngine 2s定时flush |
| 2. 业务页实时日志 | ✅ | SSE + PG 1.5s轮询双通道 |
| 3. 任务中心状态显示 | ✅ | TasksPage 5种状态映射 + 详情抽屉4Tab |
| 4. 任务失败明确错误 | ✅ | staffLog写入异常信息 |
| 5. 派件填写单号日志 | ✅ | fillDispatchWaybill 3类日志(fill异常/校验失败/兜底成功) |
| 6. 成功/失败/异常收尾日志 | ✅ | finalizeTask + emitTaskFinished |
| 7. 日志只写后端不显示前端 | ⚠️ | Agent uploadLogs缺staffName/windowId字段 |

### 日志系统隐患

**Agent上报日志缺 staffName/windowId**：`packages/agent/src/httpClient.ts` 的 uploadLogs 请求体只含 `{level, message, timestamp}`，导致前端按员工分组时Agent日志落入全局区。

**TasksPage日志无SSE**：任务中心详情抽屉仅PG轮询(1.5s)，实时性弱于业务页(SSE)。

---

## 五、站点与员工配置

| 项 | 状态 | 说明 |
|---|:----:|------|
| 1. Settings Center为唯一来源 | ✅ | settings.json + SettingsManager原子读写 |
| 2. credentials.ts未成为主数据源 | ✅ | 已降级为兜底，动态import + 跨站点安全校验 |
| 3. 新增站点/员工不需改代码 | ✅ | settings.json配置化 + SettingsPage UI |
| 4. activeSiteId切换不串员工 | ✅ | WindowStateProvider切换时清空旧状态 + 重新拉取 |
| 5. 任务带siteId/windowId/staffName | ⚠️ | staffName+windowId完整；siteId不持久化到日志条目 |

### 配置隐患

**credentials.ts未完全收敛**：4个非SettingsManager文件仍直接引用（BrowserPool/SessionManager/PlaywrightRuntime/IntegratedScan），未统一到SettingsManager单一入口。

**dryRun传递不一致**：路由层写入 `inputData.browserDryRun`，但 Engine 实际使用 `SettingsManager.getDryRunMode()` 全局值。前端传的 dryRunMode 仅作记录，不影响执行。

---

## 六、已发现的问题清单

### 阻塞级（影响下一阶段）

| # | 问题 | 影响 | 建议优先级 |
|---|------|------|-----------|
| P0-1 | dryRun传递不一致：路由写inputData.browserDryRun，Engine用全局SettingsManager | 真实执行时前端切换dryRunMode无效 | 高 |
| P0-2 | 四条链路全部处于dry-run模式，未接入真实业务提交 | 主线无法进入真实执行 | 高 |

### 非阻塞级（不影响主线但应修复）

| # | 问题 | 影响 | 建议优先级 |
|---|------|------|-----------|
| P1-1 | Agent uploadLogs缺staffName/windowId | 前端按员工分组失效 | 中 |
| P1-2 | TasksPage日志无SSE | 任务中心实时性弱 | 中 |
| P1-3 | credentials.ts未完全收敛到SettingsManager | 配置多入口，维护风险 | 低 |
| P1-4 | TaskLogEntry无siteId字段 | 无法按站点筛选日志 | 低 |
| P1-5 | SignScan dryRun默认true与其他链路不一致 | 行为不一致 | 低 |
| P1-6 | 4个Operations文件drainNativeAlerts冗余import | 代码冗余 | 低 |

---

## 七、下一步开发建议

### 主线应回到：从 dry-run 过渡到真实执行

当前基础设施已稳定（窗口管理、导航、弹窗清理、日志系统），四条链路代码完整但全部停留在 dry-run。下一阶段应逐步切换到真实业务执行。

### 建议开发顺序

**Phase 5-I-1: dryRun 传递链路修复（P0-1）**
- 统一 Engine 使用 inputData 中的 browserDryRun 而非全局 SettingsManager
- 或明确全局开关 + 任务级覆盖的优先级
- 确保前端切换 dryRunMode 能真实影响执行

**Phase 5-I-2: 到件扫描真实执行**
- 最简单的链路（无派件员选择、无上一站选择）
- 去掉 dryRun 跳过逻辑，接入真实提交按钮
- 验证 assertNotFinalSubmit 保护机制
- 人工测试3-5条真实单号

**Phase 5-I-3: 派件扫描真实执行**
- 在到件稳定后进行
- 验证派件员选择 + 单号填写 + 真实提交
- 重点测试多员工并发

**Phase 5-I-4: 到派一体真实执行**
- 最复杂的链路（上一站选择 + 到派一体勾选 + 单号填写）
- 需要到件和派件都稳定后进行

**Phase 5-I-5: 签收录入真实执行**
- 独立链路，可与其他并行
- 验证签收列表查询 + 批量签收

**Phase 5-I-6: Agent日志字段补齐（P1-1）**
- 补充 uploadLogs 的 staffName/windowId 字段
- 修复前端按员工分组

---

## 八、审查结论

DaoPai V3 的基础设施层（窗口生命周期、导航策略、弹窗清理、日志系统、配置管理）已经形成完整闭环，近期修复的7个稳定性问题全部通过人工测试。

四条业务链路代码结构完整，前端→后端→Engine→Handler→Operations 全链路贯通，但**全部停留在 dry-run 模式**，未接入真实业务提交。

**主线应回到从 dry-run 过渡到真实执行**，建议从最简单的到件扫描开始，逐步切换到真实提交。

---

**报告生成时间**: 2026-07-02  
**审查状态**: 完成（只读审查，未修改代码）
