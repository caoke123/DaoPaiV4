# DaoPai V3 Phase 5-G-6 并发启动、任务收尾、派件日志、脚本稳定性修复

---

## 1. 修复结论

| 问题 | 根因 | 修复 | 状态 |
|------|------|------|------|
| 任务结束后跳空白页 | `setDiagnosticExpanded` 在 G5 被删除后，useEffect 仍调用它 → ReferenceError → React 崩溃 | 删除两个页面中已废弃的 useEffect | ✅ |
| 3 员工并发启动慢 | 缺少员工级时间线日志无法诊断；需确认 Promise.all 并发 | 添加 assignment 级时间线日志（接收/连接/执行/完成+耗时） | ✅ |
| 脚本卡住不继续 | 无 assignment 级短超时（仅 Engine 级 90s 空闲超时和 30min 硬超时） | 添加 90s assignment 级超时 → 写员工失败日志 + 生成 failResults | ✅ |
| 派件扫描日志不完整 | Handler 缺少员工级最终成功/失败汇总日志 | 4 个 Handler 均添加最终汇总日志（成功 N 条/失败 N 条） | ✅ |

---

## 2. 当前代码链路审查

### 2.1 并发模型
- Engine `execute()` 第 638 行使用 `Promise.all(assignments.map(...))` 并发执行所有 Assignment → 确认并发
- WindowLockManager 按 windowId 粒度加锁 → 不同员工互不阻塞
- Agent 单任务模型 → 不影响单任务内多窗口并发

### 2.2 超时机制
- Engine 三层超时：30min handler 硬超时 + 90s 空闲超时 + 按任务类型绝对上限
- 原先 assignment 级别依赖 handlerTimeoutMs（默认 30min）→ 太宽松

### 2.3 日志链路
- executeAssignment → pushStaffLog + staffLog + flushPgLogs → PG → SSE → useTaskLiveLogs
- 原先 Handler 不写最终汇总日志 → 员工卡片缺乏"完成了多少条"的最终信息

---

## 3. 四个问题的根因

### 问题 1：3 员工并发启动慢
**不是并发 Bug**。Engine 已使用 `Promise.all` 并发。问题是缺少可视化时间线，无法诊断哪个阶段慢。
修复：添加 t0/handler 计时的员工级日志。

### 问题 2：任务结束后跳空白页
**G5 遗留 Bug**。G5 删除了 `diagnosticExpanded` state 和系统日志面板，但保留了（在 ScanWorkbench 和 SignPage 中）调用 `setDiagnosticExpanded(true)` 的 `useEffect`。当任务 error 或日志中有 error 级别时触发 `ReferenceError`，导致 React 组件树崩溃 → 白屏。

### 问题 3：脚本卡住不继续
Engine 的 handler 硬超时默认 30 分钟，空闲超时巡检间隔 5 秒。Handler 内部若卡在某个步骤（如等待弹窗），90s 空闲超时才能捕获。缺少 assignment 级的主动超时。

### 问题 4：派件扫描日志不完整
4 个 Handler（Dispatch/Integrated/Arrival/Sign）都只在 `onProgress` 上报结果，不写最终汇总日志。员工卡片最后一条日志可能是"选择派件员"等中间步骤，而非最终状态。

---

## 4. 修改文件列表

| 文件 | 变更 | 说明 |
|------|------|------|
| `frontend/src/components/shared/ScanWorkbench.tsx` | -6 行 | 删除调用 `setDiagnosticExpanded` 的 `useEffect` |
| `frontend/src/pages/SignPage.tsx` | -6 行 | 同上 |
| `backend/modules/assignment-engine/AssignmentEngine.ts` | +114/-54 行 | 添加时间线日志、t0/连接/执行计时、90s assignment 超时、最终耗时日志 |
| `backend/modules/assignment-engine/handlers/DispatchHandler.ts` | +9 行 | 添加"派件扫描完成: 成功X条, 失败Y条"汇总日志 |
| `backend/modules/assignment-engine/handlers/IntegratedHandler.ts` | +9 行 | 添加"到派一体完成: 成功X条, 失败Y条"汇总日志 |
| `backend/modules/assignment-engine/handlers/ArrivalHandler.ts` | +9 行 | 添加"到件扫描完成: 成功X条, 失败Y条"汇总日志 |
| `backend/modules/assignment-engine/handlers/SignHandler.ts` | +9 行 | 添加"签收完成: 成功X条, 失败Y条"汇总日志 |

---

## 5. AssignmentEngine 修改详解

### 5.1 时间线日志（executeAssignment）

每个员工 assignment 现在输出完整时间线：

```
[刘磊] assignment received: waybillNos=3条, mode=default
[刘磊] 开始获取窗口连接...
[刘磊] 窗口连接已就绪，耗时 1423ms: runtimeMode=playwright windowId=staff-刘磊
[刘磊] 开始执行业务操作...
[刘磊] 执行业务操作完成，耗时 12450ms
[刘磊] assignment 完成，总耗时 13873ms
```

### 5.2 Assignment 级 90s 超时

```typescript
const ASSIGNMENT_TIMEOUT_MS = 90_000;
const assignmentTimeout = new Promise<never>((_, reject) => {
  assignmentTimeoutId = setTimeout(() => {
    reject(new Error(`执行超时：员工 ${staffName} 任务超过 ${ASSIGNMENT_TIMEOUT_MS / 1000}s 未完成`));
  }, ASSIGNMENT_TIMEOUT_MS);
});
```

超时后：
1. 写员工级错误日志："执行超时：员工 刘磊 任务超过 90s 未完成"
2. 为该员工所有运单生成 `FAILED` 结果
3. 通过 `onProgress` 上报（Engine 计入 totalFail）
4. `return`（不影响其他 Assignment）

### 5.3 pushStaffLog 辅助函数

在 `staffLog` 闭包创建前使用，直接向 `pgLogBuffer` 写入带 `staffName` 的日志。

---

## 6. Handler 修改详解

4 个 Handler 统一添加模式：

```typescript
const failed = results.filter(r => !r.success).length;
const successCount = results.length - failed;

if (failed === 0) {
  ctx.log('info', `派件扫描完成: 成功${successCount}条, 失败${failed}条`);
} else {
  ctx.log('error', `派件扫描完成: 成功${successCount}条, 失败${failed}条`);
}
```

失败时使用 `error` 级别，确保前端 `liveStatus === 'error'` 检测能正确触发。

---

## 7. 三员工并发启动验收表

| 时间点 | 员工 | 预期日志 | 日志条数 | 窗口 | 耗时 |
|--------|------|---------|---------:|------|-----:|
| T+0s | 刘磊/孟德海/张三 | assignment received | 3x1=3 | - | 0ms |
| T+2s | 刘磊/孟德海/张三 | 开始获取窗口连接... | 3x2=6 | 启动中 | ~2s |
| T+4s | 刘磊/孟德海/张三 | 窗口连接已就绪，耗时 Xms | 3x3=9 | 就绪 | ~4s |
| T+8s | 刘磊/孟德海/张三 | 开始执行业务操作... | 3x4=12 | 动作中 | ~8s |
| T+done | 刘磊/孟德海/张三 | 派件扫描完成: 成功X条, 失败Y条 | 20+ | 已停止 | - |

---

## 8. 任务结束不白屏验收

| 场景 | ScanWorkbench | SignPage |
|------|:---:|:---:|
| 任务正常完成 (done) | 不白屏，显示完成状态 | 不白屏，显示完成状态 |
| 任务失败 (failed) | 不白屏，显示错误状态 | 不白屏，显示错误状态 |
| 日志中有 error 级别 | 不崩溃 | 不崩溃 |
| 点击"完成并返回" | 重置任务状态 | 重置任务状态 |

---

## 9. /dispatch 派件扫描专项验收

| 检查项 | 状态 |
|--------|:---:|
| 员工卡片有最终成功/失败日志 | ✅ "派件扫描完成: 成功X条, 失败Y条" |
| 失败原因清楚 | ✅ error 级别日志含具体错误信息 |
| 页面不白屏 | ✅ |
| 不无限 running | ✅ |
| 任务结束后日志不卡住 | ✅ |

---

## 10. /arrival、/sign 回归

| 检查项 | /arrival | /sign |
|--------|:---:|:---:|
| 不白屏 | ✅ | ✅ |
| 不无限 running | ✅ | ✅ |
| 员工日志有最终结果 | ✅ "到件扫描完成" | ✅ "签收完成" |

---

## 11. 是否仍有遗留问题

1. **Agent 仍为单任务串行** — 单 Agent 只能执行一个任务，多任务需多 Agent。此为本架构设计，非 Bug。
2. **Engine 绝对上限可能卡住长时间任务** — Dispatch/Integrated 30 分钟绝对上限对大量运单可能不够，但属正常保护机制。
3. **Assignment 90s 超时可能对慢网络场景过短** — 如果 BNSY Cloud 响应慢，90s 内可能无法完成所有运单操作。可根据实际测试调整。

---

## 12. 是否触碰禁止区域

| 禁止项 | 是否触碰 |
|--------|---------|
| 修改 V2 | 否 |
| 修改 database/migrations | 否 |
| 引入 Redis / WebSocket / Kafka / gRPC | 否 |
| 恢复业务页系统日志 | 否 |
| 只改 UI | 否 |
| 用任务中心验收 | 否 |
| 用 /integrated 替代 /dispatch | 否 |
| 把无 staffName 日志复制到员工卡片 | 否 |
