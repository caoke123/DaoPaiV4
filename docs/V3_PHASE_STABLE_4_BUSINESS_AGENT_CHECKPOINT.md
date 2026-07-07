# DaoPai V3 四业务 Agent 稳定检查点报告

> **保存日期**: 2026-07-04  
> **分支**: master  
> **阶段**: 四业务 Agent 本地执行稳定化完成  

---

## 1. 阶段结论

- 四个核心业务流程已完成 V3 Agent / local execution 稳定化。
- 人工多轮测试通过，无异常。
- 当前阶段可以作为稳定保存点。
- 后续开发应从该检查点继续。

---

## 2. 已稳定业务

| # | 业务 | 状态 |
|---|------|------|
| 1 | **Arrival** 到件扫描 | 稳定，上一站 fill 过滤优化完成 |
| 2 | **Dispatch** 派件扫描 | 稳定，单号快速输入 + TOTAL 汇总完成 |
| 3 | **Integrated** 到派一体 | 稳定，上一站去重 + 真实总条数读取完成 |
| 4 | **Sign** 签收录入 | 稳定，条数/页设置修复完成 |

---

## 3. 当前真实执行链路

```
前端提交任务
  → 后端创建 pending task
  → Local Agent pull task
  → packages/agent/src/executors/*Executor.ts
  → packages/agent/src/browser/*BrowserDryRun.ts
  → CDP 接管 READY 窗口执行浏览器自动化
```

**重要说明**：

- `backend/operations/*` 多数为历史链路或参考链路，**不是当前真实执行路径**。
- 后续业务动作修复应优先修改 `packages/agent/src/browser/*BrowserDryRun.ts`。
- **修改 `packages/agent/src/**` 后必须重启 Local Agent 再验收**。
- 编译需执行 `npx tsc`（而非 `npx tsc --noEmit`）以生成 dist。

---

## 4. 安全边界

当前四业务稳定阶段必须保持的安全约束：

| 约束 | 说明 |
|------|------|
| 不新开 Chrome | READY 窗口复用，Backend 管理生命周期 |
| 不重新登录 | CDP 接管已登录的窗口 |
| 使用 READY 窗口 | Backend PlaywrightRuntime 预登录的窗口 |
| CDP 接管 | `connectOverCDP` 连接，非独立浏览器 |
| dry-run 不真实提交 | `finalSubmitClicked=false` |
| 失败不影响其他 assignment | 独立 windowId 隔离 |
| READY 窗口任务完成后保持运行 | 不关闭浏览器 |

---

## 5. 本阶段关键修复摘要

1. **Sign 条数/页稳定修复**
   - 改为旧版可靠模式：`page.click({ force: true })` + 800ms 等待 + `page.evaluate` 点击选项
   - 执行顺序调整：搜索后设置 pageSize

2. **Arrival 到件扫描**
   - 上一站输入优化：`fill("天津分拨中心")` → Element UI 自动过滤，15s → <2s
   - task_logs 全线 `log?.()` 取代 `console.log`
   - 先判断 `dryRunResult.success` 再打印成功日志

3. **Dispatch 派件扫描**
   - `page.evaluate` 中箭头函数 `__name` 风险修复
   - 派件员选择修复
   - 单号添加切换为快速输入 + TOTAL 汇总模式

4. **Integrated 到派一体**
   - 上一站去重复选择完成
   - 单号快速输入 + 最终读取真实总条数完成
   - 多轮人工测试稳定

5. **四业务日志**
   - `task_logs` 已能支持人工诊断
   - 执行顺序、校验结果均有清晰日志

---

## 6. 人工验收结果

- 用户人工多轮测试四业务均稳定。
- 当前未发现异常。
- **本阶段通过。**

---

## 7. 后续开发注意事项

- 后续不要再优先修改 `backend/operations/*` 作为当前真实链路。
- 业务动作问题先查 Agent `BrowserDryRun` 文件。
- 每次修复必须确认 `task_logs` 中有新版本标记。
- 修改 Agent 后必须重启 Local Agent。
- 多员工并发问题优先按 `staffName` / `windowId` 定位。
- 编译 Agent 使用 `npx tsc`，不是 `npx tsc --noEmit`。
