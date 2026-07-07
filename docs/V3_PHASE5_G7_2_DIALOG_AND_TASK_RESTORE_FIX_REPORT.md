# DaoPai V3 Phase 5-G-7-2：浏览器原生弹窗处理 + 业务页任务恢复持久化修复报告

**日期**: 2026-07-01  
**阶段**: Phase 5-G-7-2  
**状态**: 修复完成，待验收

---

## 一、修复概述

G7-1 全链路测试后发现两个阻塞问题：

1. **员工窗口启动后被浏览器原生 alert 弹窗卡住**（"网点余额低于警戒金额！"）
2. **业务页切换后任务状态/日志丢失或统计异常**（0/0/0 / "等待员工窗口日志..."）

本阶段只修这两个问题。

---

## 二、修复1：浏览器原生弹窗自动处理

### 根因分析

`PlaywrightRuntime.launchWindow()` 创建 page 后从未注册 dialog handler。PopupManager 的 `register(page)` 只在 BrowserPool legacy 路径（BrowserPool.ts L710）和 `PlaywrightLoginVerifier.autoLogin()` 登录阶段临时注册（PlaywrightLoginVerifier.ts L159-161）。任务执行时使用的 page 没有 dialog handler，遇到如"网点余额低于警戒金额！"等浏览器原生 alert 就会阻塞。

### 修改文件

#### 1. `backend/browser/PopupManager.ts` (L75-L148)

**改动内容**:
- 新增 `registeredPages: WeakSet<Page>` 防止同一 page 重复注册 dialog listener
- `register(page, staffName?)` 方法新增可选 `staffName` 参数，日志带员工标注
- alert/confirm/prompt 统一 `accept()`（点击确定），不再对 confirm 使用 dismiss
- 弹窗日志格式：`[staffName][Popup] 检测到浏览器弹窗：xxx` / `[staffName][Popup] 已关闭浏览器弹窗，继续执行`
- 新增 `isRegistered(page)` 方法供外部检查

**关键代码变更**:
```typescript
register(page: Page, staffName?: string): void {
  if (this.registeredPages.has(page)) return;
  this.registeredPages.add(page);
  const staffTag = staffName ? `[${staffName}] ` : '';
  page.on('dialog', async (dialog) => {
    // alert/confirm/prompt 统一 accept
    if (type === 'alert') {
      await dialog.accept();
      console.log(`${staffTag}[Popup] 检测到浏览器弹窗：${message}`);
      console.log(`${staffTag}[Popup] 已关闭浏览器弹窗，继续执行`);
    }
    // ...
  });
}
```

#### 2. `backend/playwright-runtime/PlaywrightRuntime.ts`

**改动内容**:
- Import `PopupManager` (L49)
- 新增私有方法 `attachDialogHandler(page, staffName?)` (L69-L75)，统一弹窗注册入口
- `launchWindow()` 中 page 创建后立即注册 (L162-L163)
- `ensureSingleBusinessPage()` 中新建 page 时注册 (L448-L449)，已有 page 也在末尾注册 (L462-L465)

**关键代码变更**:
```typescript
private attachDialogHandler(page: Page, staffName?: string): void {
  const popupMgr = PopupManager.getInstance();
  if (!popupMgr.isRegistered(page)) {
    popupMgr.register(page, staffName);
  }
}
```

### 处理策略

| 弹窗类型 | 处理方式 | 说明 |
|---------|---------|------|
| alert | `dialog.accept()` | 点击确定，关闭弹窗 |
| confirm | `dialog.accept()` | 点击确定（同意操作） |
| prompt | `dialog.accept('')` | 点击确定，输入空字符串 |
| beforeunload | `dialog.dismiss()` | 取消离开 |

### 验收标准

| 验收项 | 标准 |
|--------|------|
| 弹窗自动关闭 | 弹窗出现后 1 秒内自动关闭 |
| 不阻塞首页 | 员工窗口继续进入 dashboard |
| 任务继续执行 | 弹窗关闭后任务流程不受影响 |
| 员工卡片日志 | 显示"检测到浏览器弹窗"和"已关闭浏览器弹窗" |
| 不重复注册 | 同一 page 只注册一次 listener |

---

## 三、修复2：业务页任务恢复持久化

### 根因分析

1. **localStorage 存储了过多数据**：原 `persistTask()` 存储 selectedWorkers/allocations/liveStatus/stats 等，这些数据在页面重载后恢复无意义（因为 workers 和 stats 都在后端 PG）

2. **`loadPersistedTask()` 从未被调用**：虽然 G7-1 定义了 localStorage 读写函数，但 `loadPersistedTask()` 在 TaskExecutionProvider 中没有在 mount 时调用

3. **页面恢复逻辑不完整**：ScanWorkbench/SignPage 的 G7-1 恢复效果只从 context 恢复了 selectedWorkers，但 context 的 workers/stats 在重载时已重置

4. **useTaskLiveLogs 重新挂载清空日志**：每次 taskId 变化都执行 `setLogsMap(new Map())`，导致页面切换后日志消失

### 修改文件

#### 1. `backend/api/routes.ts` — 新增 GET /api/tasks/:id

新增完整任务详情接口，返回：
```json
{
  "taskId": "...",
  "type": "dispatch",
  "status": "running",
  "totalCount": 100,
  "doneCount": 45,
  "failCount": 3,
  "createdAt": "...",
  "finishedAt": null,
  "inputData": { "assignments": [...] },
  "assignments": [{ "staffName": "肖飞", "count": 50 }, ...]
}
```

- 从 `pgDb.getTaskById()` 获取基础信息（含 inputData）
- 从 `inputData.assignments` 或 `pgDb.getTaskStaffSummary()` 获取员工分配
- 不修改 database/migrations

#### 2. `frontend/src/api/client.ts` — 新增 getTaskDetail

新增 `TaskDetailResponse` 类型和 `getTaskDetail(taskId)` 函数。

#### 3. `frontend/src/components/shared/TaskExecutionContext.tsx` — 核心重构

**localStorage 最小化**:
```typescript
interface PersistedTask {
  taskId: string;
  taskType: string;   // arrival | dispatch | integrated | sign
  taskOrigin: string;  // /api/operations/dispatch
  savedAt: number;
}
```

**新增 `restoreTask(origin)` 方法**（暴露到 context）:
1. 从 localStorage 读取 `taskId`
2. 请求 `GET /api/tasks/:id` 获取完整任务数据
3. 校验 `task.type` 匹配当前页面类型
4. 恢复 `taskId / selectedWorkers / allocations / liveStatus / totalCount / doneCount / failCount / workerProgress`
5. 根据 status 设置 `running / completed / error`

**新增 `restoredRef`**：防止同一 origin 重复恢复

**关键变更**:
```typescript
const restoreTask = useCallback(async (origin: string): Promise<boolean> => {
  const typeKey = originToTypeKey(origin);
  if (restoredRef.current.has(typeKey)) return false;
  
  const persisted = loadPersistedTask(typeKey);
  if (!persisted?.taskId) return false;
  
  const detail = await getTaskDetail(persisted.taskId);
  if (!taskTypeMatchesOrigin(detail.type, origin)) {
    clearPersistedTask(typeKey);
    return false;
  }
  
  restoreFromDetail(detail, origin);
  return true;
}, []);
```

#### 4. `frontend/src/hooks/useTaskLiveLogs.ts` — 保留日志 + 自动分组

**同一 taskId 不清空日志**:
```typescript
const prevTaskIdRef = useRef<string | null>(null);
// ...
const isSameTask = prevTaskIdRef.current === taskId;
if (!isSameTask) {
  setLogsMap(new Map()); // 仅新任务清空
}
```

**自动从日志 staffName 分组**（workers 延迟到达也不丢日志）:
```typescript
const logsByWorker = useMemo(() => {
  const byWorker: Record<string, TaskLogEntry[]> = {};
  // 先初始化已知 workers
  for (const name of currentWorkers) { byWorker[name] = []; }
  // 遍历日志，自动创建分组
  for (const log of allLogs) {
    if (!log.staffName) continue;
    if (!byWorker[log.staffName]) byWorker[log.staffName] = [];
    byWorker[log.staffName].push(log);
  }
  return byWorker;
}, [allLogs]);
```

**done/failed 后的 final fetch 保留**: 不清空 `prevTaskIdRef`，重挂载时保留日志。

#### 5. `frontend/src/components/shared/ScanWorkbench.tsx` 和 `frontend/src/pages/SignPage.tsx`

替换旧的 G7-1 恢复逻辑:

```typescript
// 旧逻辑（仅恢复 selectedWorkers）
useEffect(() => {
  if (taskActive && ctxSelectedWorkers.length > 0 && selectedWorkers.length === 0) {
    setSelectedWorkers([...ctxSelectedWorkers]);
  }
}, [taskActive, ctxSelectedWorkers, selectedWorkers.length]);

// 新逻辑（从 localStorage + 后端完整恢复）
useEffect(() => {
  if (!taskActive && submitApi) {
    ctxRestoreTask(submitApi);
  }
}, [submitApi]);
```

覆盖页面: `/arrival` (via ArrivalPage)、`/dispatch` (via DispatchPage)、`/integrated` (via IntegratedPage)、`/sign` (via SignPage)

### 数据流

```
localStorage                    后端 PG                       前端 Context
─────────────                   ────────                      ────────────
daopai_task_dispatch            GET /api/tasks/:id
  taskId: "xxx"        ──→       detail {                   restoreFromDetail()
  taskType: "dispatch"              taskId, type,               setTaskId
  taskOrigin: "..."                  status,                    setSelectedWorkers
  savedAt: 12345                      totalCount,               setAllocations
                                      doneCount,                setLiveStatus
                                      failCount,                setStats
                                      assignments[...]         ...
                                    }
                                                                          ↓
                             GET /api/tasks/:id/logs?limit=500  → useTaskLiveLogs
                             GET /api/tasks/:id/status          → SSE + PG轮询
```

---

## 四、修改文件清单

| 文件 | 修改类型 | 改动说明 |
|------|---------|---------|
| `backend/browser/PopupManager.ts` | 修改 | register 支持 staffName、WeakSet 防重复、confirm/prompt 统一 accept |
| `backend/playwright-runtime/PlaywrightRuntime.ts` | 修改 | 新增 attachDialogHandler，在 launchWindow/ensureSingleBusinessPage 中调用 |
| `backend/api/routes.ts` | 新增 | GET /api/tasks/:id 完整详情接口 |
| `frontend/src/api/client.ts` | 新增 | TaskDetailResponse 类型、getTaskDetail 函数 |
| `frontend/src/components/shared/TaskExecutionContext.tsx` | 重构 | localStorage 最小化、新增 restoreTask、restoredRef 防重复 |
| `frontend/src/hooks/useTaskLiveLogs.ts` | 修改 | 同一 taskId 不清空日志、自动按 staffName 分组 |
| `frontend/src/components/shared/ScanWorkbench.tsx` | 修改 | 替换 G7-1 恢复效果为新 restoreTask 调用 |
| `frontend/src/pages/SignPage.tsx` | 修改 | 同上 |

---

## 五、验收表

### A. 弹窗验收

| 员工 | 是否出现 alert | 是否自动关闭 | 关闭耗时 | 是否进入首页 | 员工日志是否记录 |
|------|-------------|------------|---------|------------|---------------|
| 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |

### B. 任务恢复验收

| 页面 | running 中切换恢复 | done/failed 后恢复 | 统计是否正确 | 员工日志是否恢复 | 是否串任务 |
|------|-------------------|-------------------|------------|---------------|----------|
| /arrival | 待测 | 待测 | 待测 | 待测 | 待测 |
| /dispatch | 待测 | 待测 | 待测 | 待测 | 待测 |
| /integrated | 待测 | 待测 | 待测 | 待测 | 待测 |
| /sign | 待测 | 待测 | 待测 | 待测 | 待测 |

---

## 六、设置配置状态

`data/settings.json` 当前 `dryRunMode: true`（干运行模式），未修改。本地测试前需改为 `false`，测试完成后必须恢复为 `true` 或在报告中明确说明。

---

## 七、注意事项

1. 旧的 localStorage 数据格式（G7-1 生成的，含 selectedWorkers/allocations/stats）在页面首次加载时会被自动清除（因为 `loadPersistedTask` 读到旧格式缺少 `taskType` 字段会跳过，且 `startTask` 会覆盖写入新格式）

2. `restoreTask` 失败（API 超时/任务不存在）不会删除 localStorage，下次重试

3. 任务类型校验不通过会自动清除 localStorage

4. 浏览器原生弹窗处理对所有 PlaywrightRuntime 创建的 page 生效，不影响 DOM 弹窗（`dismissAll` 处理 DOM 弹窗）

5. `data/settings.json` 中 `dryRunMode: true`（当前为安全模式），测试改 false 后务必恢复
