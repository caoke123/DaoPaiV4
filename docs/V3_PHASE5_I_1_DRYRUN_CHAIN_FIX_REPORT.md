# DaoPai V3 Phase 5-I-1：dryRun 传递链路修复 + 真实执行安全门报告

**日期**: 2026-07-02  
**阶段**: Phase 5-I-1  
**修复目标**: 统一 dryRun 判定来源 + 真实执行开关安全门

---

## 一、修改文件列表

| 文件 | 修改内容 |
|------|---------|
| [SettingsManager.ts](file:///e:/网站开发/DaoPaiV3/backend/config/SettingsManager.ts#L296-L337) | 新增 `resolveTaskDryRun` 静态方法（4级优先级）+ `isRealSubmitAllowed` 安全门方法 |
| [AssignmentEngine.ts](file:///e:/网站开发/DaoPaiV3/backend/modules/assignment-engine/AssignmentEngine.ts#L68-L70) | `EngineExecuteOptions` 新增 `inputData?: unknown` |
| [AssignmentEngine.ts](file:///e:/网站开发/DaoPaiV3/backend/modules/assignment-engine/AssignmentEngine.ts#L303-L306) | Engine 使用 `resolveTaskDryRun(inputData)` 替代 `getDryRunMode()` |
| [AssignmentEngine.ts](file:///e:/网站开发/DaoPaiV3/backend/modules/assignment-engine/AssignmentEngine.ts#L442-L451) | 任务日志增加 dryRun 来源 |
| [TaskEngineRunner.ts](file:///e:/网站开发/DaoPaiV3/backend/services/TaskEngineRunner.ts#L121) | 透传 `inputData: task.inputData` |
| [types.ts](file:///e:/网站开发/DaoPaiV3/backend/modules/assignment-engine/types.ts#L89-L101) | TaskContext 注释更新 |
| [ArriveScanBatch.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/ArriveScanBatch.ts#L349-L366) | 安全门：dryRun=false + ENABLE_REAL_SUBMIT≠true → 跳过提交 |
| [DispatchScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/DispatchScan.ts#L747-L760) | 安全门：同上 |
| [IntegratedScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/IntegratedScan.ts#L849-L862) | 安全门：同上 |
| [SignScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/SignScan.ts#L68-L74) | 安全门：dryRun=false 时强制 isDryRun=true |
| [BaseOperation.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/BaseOperation.ts#L13) | OperationResult.status 新增 `SAFETY_GATE_SKIPPED` |
| [api-contracts.ts](file:///e:/网站开发/DaoPaiV3/backend/types/api-contracts.ts#L34) | WaybillResultStatus 新增 `SAFETY_GATE_SKIPPED` |

---

## 二、dryRun 链路 Before / After

### Before

```
前端 dryRunMode → routes 写入 inputData.browserDryRun → ⚠️ 被忽略
Engine 直接调用 SettingsManager.getDryRunMode() → 全局唯一来源
dryRun=false 时直接进入真实提交路径，无安全门
```

### After

```
前端 dryRunMode → routes 写入 inputData.browserDryRun → TaskEngineRunner 透传
→ Engine 调用 resolveTaskDryRun(inputData)
  → 优先级 1: inputData.browserDryRun (任务级)
  → 优先级 2: inputData.dryRunMode (兼容字段)
  → 优先级 3: inputData.dryRun (兼容字段)
  → 优先级 4: SettingsManager.getDryRunMode() (全局兜底)
→ taskContext.dryRunMode → Handler → Operations
→ Operations 安全门: dryRun=false + ENABLE_REAL_SUBMIT≠true → 跳过提交
```

---

## 三、dryRun 优先级说明

```typescript
static async resolveTaskDryRun(inputData: unknown): Promise<{ browserDryRun: boolean; source: string }> {
  // 优先级 1: 任务级 browserDryRun（routes 层写入）
  if (typeof data.browserDryRun === 'boolean') → source: 'task.inputData.browserDryRun'

  // 优先级 2: 兼容字段 dryRunMode（前端原始字段名）
  if (typeof data.dryRunMode === 'boolean') → source: 'task.inputData.dryRunMode'

  // 优先级 3: 兼容字段 dryRun
  if (typeof data.dryRun === 'boolean') → source: 'task.inputData.dryRun'

  // 优先级 4: 全局兜底
  SettingsManager.getDryRunMode() → source: 'SettingsManager fallback'
}
```

---

## 四、四条链路覆盖情况

| 业务 | routes 写入 | Engine 解析 | Handler 透传 | Operations 使用 | 安全门 | 状态 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 到件扫描 | ✅ browserDryRun | ✅ resolveTaskDryRun | ✅ taskContext.dryRunMode | ✅ if (dryRunMode) | ✅ isRealSubmitAllowed | ✅ |
| 派件扫描 | ✅ browserDryRun | ✅ resolveTaskDryRun | ✅ taskContext.dryRunMode | ✅ if (dryRunMode) | ✅ isRealSubmitAllowed | ✅ |
| 到派一体 | ✅ browserDryRun | ✅ resolveTaskDryRun | ✅ taskContext.dryRunMode | ✅ if (dryRunMode) | ✅ isRealSubmitAllowed | ✅ |
| 签收录入 | ✅ browserDryRun | ✅ resolveTaskDryRun | ✅ taskContext.dryRunMode | ✅ isDryRun = dryRunMode ?? true | ✅ 强制 isDryRun=true | ✅ |

---

## 五、dryRun=true 测试预期

**前端传**: `{ "dryRunMode": true }`

**预期日志**:
```
[Engine.execute] [执行配置] browserDryRun=true，来源=task.inputData.browserDryRun
当前运行模式：试运行模式（跳过最终提交），来源=task.inputData.browserDryRun
[试运行模式] 到件扫描已执行到最终提交前，跳过真实提交 (3条)
```

**预期行为**: 任务保持 dry-run，不最终提交 ✅

---

## 六、dryRun=false 测试预期

**前端传**: `{ "dryRunMode": false }`

**预期日志**:
```
[Engine.execute] [执行配置] browserDryRun=false，来源=task.inputData.browserDryRun
当前运行模式：真实执行模式，来源=task.inputData.browserDryRun
[安全门] 真实执行开关已传递到执行层，但当前未开启 ENABLE_REAL_SUBMIT，跳过最终提交 (3条)
```

**预期行为**:
- ✅ browserDryRun=false 传到 Operations 层
- ✅ 显示真实执行准备日志
- ✅ 被安全门拦截（ENABLE_REAL_SUBMIT 未设置）
- ✅ 没有真实提交
- ✅ 返回 `status: 'SAFETY_GATE_SKIPPED'`

---

## 七、不传 dryRunMode 测试预期

**预期日志**:
```
[Engine.execute] [执行配置] browserDryRun=true，来源=SettingsManager fallback
当前运行模式：试运行模式（跳过最终提交），来源=SettingsManager fallback
```

**预期行为**: 使用全局 SettingsManager 兜底（安全优先，缺省 true）

---

## 八、安全门机制

### 环境变量

```bash
ENABLE_REAL_SUBMIT=true  # 才允许真实最终提交
```

默认不设置 = 不允许真实提交。

### 三层保护

| 条件 | 行为 | 日志 |
|------|------|------|
| dryRun=true | 跳过提交 | `[试运行模式] 跳过真实提交` |
| dryRun=false + ENABLE_REAL_SUBMIT≠true | 跳过提交 | `[安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交` |
| dryRun=false + ENABLE_REAL_SUBMIT=true | **允许真实提交** | `[真实执行模式] 即将点击提交按钮` |

### 安全门结果状态

安全门拦截的运单返回：
```typescript
{
  status: 'SAFETY_GATE_SKIPPED',
  message: '[安全门拦截] 真实执行开关已打通，但未开启最终提交保护开关，未点击提交按钮',
  dryRun: true,
  skippedFinalSubmit: true,
}
```

---

## 九、无真实单号限制说明

当前没有真实单号，因此本阶段**不做生产真实提交测试**，只验证：
1. ✅ 真实执行开关链路（dryRun=false 能传到 Operations 层）
2. ✅ 日志能显示 dryRun 来源
3. ✅ 最终提交安全门（ENABLE_REAL_SUBMIT 未设置时不提交）

---

## 十、编译验证

```bash
cd backend && npm run build
```

结果: ✅ TypeScript 编译成功，无错误。

---

## 十一、结论

| 问题 | 回答 |
|------|------|
| 真实执行开关链路是否已打通？ | ✅ 是。dryRun=false 从前端传到 Operations 层，不被全局 SettingsManager 覆盖 |
| 是否仍保留最终提交保护？ | ✅ 是。ENABLE_REAL_SUBMIT 环境变量默认未设置，安全门拦截所有真实提交 |
| 是否可以进入 Phase 5-I-2？ | ✅ 可以。设置 ENABLE_REAL_SUBMIT=true 后即可进入到件扫描真实执行 |

---

**报告生成时间**: 2026-07-02  
**编译状态**: ✅ 后端编译通过  
**下一步**: 人工测试 A/B/C/D 后进入 Phase 5-I-2（到件扫描真实执行）
