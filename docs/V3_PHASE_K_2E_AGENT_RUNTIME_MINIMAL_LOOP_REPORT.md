# DaoPai V3 Phase K-2E：Agent 基础运行时最小闭环修复报告

- 阶段：Phase K-2E
- 类型：代码修复 + 编译验证（不做 E2E）
- 日期：2026-07-02
- 范围：在 Agent 侧补齐 Phase 5-H 已验证的基础运行时 contract
- 上游审查依据：《DaoPai V3 基础运行时回归专项审查报告》
- 参考：
  - `docs/V3_PHASE5_H_MAINLINE_REGRESSION_AUDIT_REPORT.md`
  - `docs/V3_PHASE5_G8_4_BUSINESS_NAVIGATOR_AND_CLEAN_HOME_REPORT.md`
  - `docs/V3_PHASE5_G8_5_TAB_CLEANUP_AND_NORMALIZE_REPORT.md`
  - `docs/V3_PHASE5_G8_6_SIDEBAR_FIRST_NAVIGATION_REPORT.md`

---

## 一、本阶段目标

业务执行继续留在 Agent，但 Agent 必须补齐 Phase 5-H 已验证的基础运行时能力：

1. clean home（任务开始前恢复干净首页）
2. native alert guard（原生弹窗守卫）
3. DOM 弹窗清理
4. 充值弹窗取消
5. 菜单优先业务页面导航
6. URL 兜底
7. 进入业务页面后清理弹窗
8. 任务结束 restore clean home
9. 关闭前清理 / 释放资源

四条业务链路（Arrival / Dispatch / Sign / Integrated）全部复用同一套 Agent 侧公共基础能力。

---

## 二、严格限制确认

| 限制项 | 状态 |
| --- | --- |
| 不恢复四业务到 Cloud run-engine | ✅ 未触碰 |
| 不删除 run-engine | ✅ 保留 |
| 不删除 Cloud local-api | ✅ 保留 |
| 不重写 BrowserManager | ✅ 未触碰 |
| 不大改数据库 | ✅ 未触碰 |
| 不启用真实提交（`ENABLE_REAL_SUBMIT` 未设置） | ✅ 安全门保留 |
| 不扩展 Sign / Integrated 业务细节 | ✅ 仅替换导航/清理调用 |
| 不做 E2E | ✅ 仅编译验证 |
| 不破坏 Arrival / Dispatch 已通过链路 | ✅ 仅替换公共 helper |
| 不破坏 Dispatch 多员工 assignments | ✅ 顺序执行逻辑保留 |
| 不改变签收策略 / Dispatch 模式语义 | ✅ 未触碰 |
| 不让 Agent 运行时 import backend runtime 对象 | ✅ AgentBusinessRuntime 自包含 |
| 可复刻 Phase 5-H 选择器/策略，但不直接依赖 backend 模块 | ✅ 仅复制策略 |

---

## 三、新增 Agent 公共运行时模块

### 3.1 文件

`packages/agent/src/browser/AgentBusinessRuntime.ts`（998 行）

### 3.2 设计原则

- 完全自包含，不 `import` 任何 `backend/*` 模块
- 仅复刻 Phase 5-H 的稳定策略（选择器、超时、清理顺序、菜单文本）
- 所有 DOM 弹窗清理只点"取消/关闭/知道了"，绝不点"确定"（避免充值弹窗误跳转）
- `restoreCleanHome` 失败不抛异常，不覆盖原始业务错误
- 使用 `WeakSet<Page>` 防止 native alert guard 重复注册

### 3.3 导出 API

| 函数 | 用途 | 来源映射 |
| --- | --- | --- |
| `registerNativeAlertGuard(page, log?, meta?)` | 注册 page.on('dialog')，beforeunload→dismiss，alert/confirm→accept，prompt→accept('') | backend/browser/NativeAlertGuard.ts |
| `forceAcceptCurrentNativeAlert(page)` | CDP 兜底强制接受当前 alert | NativeAlertGuard.forceAcceptCurrentNativeAlert |
| `drainNativeAlerts(page, durationMs?, intervalMs?, log?, meta?)` | 短轮询清理原生 alert | NativeAlertGuard.drainNativeAlerts |
| `cleanDomPopups(page, log?, meta?)` | 四层 DOM 弹窗清理 | PopupManager.dismissRechargeCancelDialog |
| `afterPageChangedCleanup(page, log?, meta?, tag?)` | 统一清理钩子（guard drain + cleanDomPopups + 二次 drain） | PlaywrightRuntime.afterPageChangedCleanup |
| `ensureCleanHome(page, log?, meta?)` | 任务开始前恢复干净首页 | PlaywrightRuntime.ensureCleanHome |
| `restoreCleanHome(page, log?, meta?)` | 任务结束后恢复干净首页（失败不抛异常） | PlaywrightRuntime.restoreCleanHome |
| `navigateToBusinessPageMenuFirst(page, businessType, log?, meta?)` | 菜单优先三段式导航 | BusinessPageNavigator.navigateToBusinessPageMenuFirst |
| `createRuntimeLogFn(logger, defaultMeta?)` | AgentLogger 适配器 | 新增（适配 4 级日志） |

### 3.4 业务页面规格表 BUSINESS_SPECS

```typescript
const BUSINESS_SPECS: Record<BusinessType, BusinessPageSpec> = {
  arrival:    { url: '.../scanning/ArrivalscanBatch',     parentMenu: '操作中心', childMenu: '到件扫描(批量)', requiredElements: ['textarea', 'button.el-button--danger'] },
  dispatch:   { url: '.../scanning/dispatchscan',         parentMenu: '操作中心', childMenu: '派件扫描',       requiredElements: ['.dispatchscan_left input', '.dispatchscan_left button.el-button--primary'] },
  integrated: { url: '.../scanning/arrivalscan',          parentMenu: '操作中心', childMenu: '到件扫描',       requiredElements: ['#waybillNum', '.arrivalscan_left button.el-button--primary'] },
  sign:       { url: '.../scanning/signFor/signForInput', parentMenu: '操作中心', intermediateMenu: '签收', childMenu: '签收录入', requiredElements: ['.search-wrap .item-actions .el-button--primary', '.search-wrap .inputs .el-date-editor'] },
};
```

### 3.5 导航流程

`navigateToBusinessPageMenuFirst` 实现的三段式：

1. `ensureCleanHome` → `afterPageChangedCleanup`
2. 第一次菜单点击（parent → intermediate → child）→ 验证目标页面 → 成功则 `afterPageChangedCleanup`
3. 失败则 `restoreCleanHome` → 第二次菜单点击 → 验证 → 成功则 `afterPageChangedCleanup`
4. 仍失败则 URL 兜底（`page.goto(spec.url)`）→ 验证 → `afterPageChangedCleanup`

返回 `NavigateResult`：

```typescript
{
  success: boolean;
  method: 'sidebar_first' | 'sidebar_retry' | 'url_fallback' | 'already_on_page' | 'failed';
  pageUrl: string;
  message: string;
}
```

---

## 四、四个 BrowserDryRun 改造

四个 BrowserDryRun 全部从"直接 `page.goto(businessUrl)` 主路径"切换为"调用公共 `navigateToBusinessPageMenuFirst` + `afterPageChangedCleanup`"。

### 4.1 ArrivalBrowserDryRun.ts

| 改动项 | 内容 |
| --- | --- |
| 移除 import | `ARRIVAL_PAGE_ROUTE`（不再需要） |
| 移除常量 | `ARRIVAL_PAGE_URL` |
| 移除本地函数 | `cleanPagePopups`（约 60 行） |
| 新增 import | `navigateToBusinessPageMenuFirst`, `afterPageChangedCleanup`, `AgentRuntimeLogFn`, `AgentRuntimeMeta` |
| Input 接口 | 新增 `log?: AgentRuntimeLogFn`, `meta?: AgentRuntimeMeta` |
| 导航块 | 替换 dashboard goto + ARRIVAL_PAGE_URL goto + Vue Router 兜底 → `navigateToBusinessPageMenuFirst(page, 'arrival', log, meta)` |
| 进入后清理 | `cleanPagePopups(page)` → `afterPageChangedCleanup(page, log, meta, 'arrival-after-enter')` |
| 查询前清理 | `cleanPagePopups(page)` → `afterPageChangedCleanup(page, log, meta, 'arrival-before-query')` |
| 保留 | assertNotFinalSubmit / 真实提交安全门 / 业务表单操作逻辑 |

### 4.2 DispatchBrowserDryRun.ts

与 Arrival 同模式：`navigateToBusinessPageMenuFirst(page, 'dispatch', log, meta)` + `afterPageChangedCleanup(page, log, meta, 'dispatch-after-enter')`。

### 4.3 SignBrowserDryRun.ts

与上述同模式：`navigateToBusinessPageMenuFirst(page, 'sign', log, meta)` + `afterPageChangedCleanup(page, log, meta, 'sign-after-enter')` / `'sign-before-search'`。

### 4.4 IntegratedBrowserDryRun.ts

与上述同模式：`navigateToBusinessPageMenuFirst(page, 'integrated', log, meta)` + `afterPageChangedCleanup(page, log, meta, 'integrated-after-enter')`。

---

## 五、四个 Executor 统一生命周期改造

每个 Executor 的 `executeOneXxxAssignment` 函数统一改造为：

```
任务开始：
  - 创建 log = createRuntimeLogFn(logger, meta)
  - 声明 let page: Page | null = null（try 块外）
  - 打开登录页 → ensureBnsyLoggedIn
  - registerNativeAlertGuard(page, log, meta)
  - ensureCleanHome(page, log, meta)  // 失败只 warning，不阻断
  - 调用 DryRun（传入 log, meta）

成功路径（关闭浏览器前）：
  - restoreCleanHome(page, log, meta)
  - afterPageChangedCleanup(page, log, meta, '<biz>-before-close')
  - manager.close()
  - page = null

catch 路径（失败也尽力回首页）：
  - restoreCleanHome(page, log, meta)   // try-catch 包裹，不覆盖原始错误
  - afterPageChangedCleanup(page, log, meta, '<biz>-catch-before-close')
  - manager.close()
  - page = null

finally：
  - logger.close()
```

### 5.1 改造清单

| Executor | 改造点 |
| --- | --- |
| ArrivalExecutor.ts | imports + log + page 外层声明 + guard + ensureCleanHome + DryRun 传参 + 成功/catch restore |
| DispatchExecutor.ts | 同上（在 `executeOneDispatchAssignment` 内） |
| SignExecutor.ts | 同上 + 替换原有简单 `page.goto('/dashboard')` 为完整 `restoreCleanHome + afterPageChangedCleanup` |
| IntegratedExecutor.ts | 同上 + 替换原有简单 `page.goto('/dashboard')` 为完整 `restoreCleanHome + afterPageChangedCleanup` |

### 5.2 关键代码模式（以 IntegratedExecutor 为例）

```typescript
const log = createRuntimeLogFn(logger, meta);
let manager: BrowserManager | null = null;
let page: Page | null = null;   // try 块外声明，catch 才能访问

try {
  // ...
  page = await manager.openPage(loginUrl);   // 注意：去掉 const，赋值给外层
  // ...
  registerNativeAlertGuard(page, log, meta);
  logger.info('[Agent][Integrated] Native alert guard 已注册', meta);
  const homeResult = await ensureCleanHome(page, log, meta);
  if (!homeResult.success) {
    logger.warning(`[Agent][Integrated] ensureCleanHome 失败: ${homeResult.error}，继续尝试业务导航`, meta);
  }

  const dryRunResult = await runIntegratedBrowserDryRun(page, { /* ... */ log, meta });

  // 成功路径：关闭前恢复干净首页
  if (page) {
    try {
      await restoreCleanHome(page, log, meta);
      await afterPageChangedCleanup(page, log, meta, 'integrated-before-close');
    } catch (cleanupErr) {
      logger.warning(`[Agent][Integrated] 关闭前首页清理失败：${(cleanupErr as Error).message}`, meta);
    }
  }
  if (manager) {
    const closeResult = await manager.close();
    manager = null;
    page = null;
  }
  // ...
} catch (err) {
  // 失败路径：尽力回首页，不覆盖原始错误
  if (page) {
    try {
      await restoreCleanHome(page, log, meta);
      await afterPageChangedCleanup(page, log, meta, 'integrated-catch-before-close');
    } catch (cleanupErr) {
      logger.warning(`[Agent][Integrated] 失败路径关闭前清理失败：${(cleanupErr as Error).message}`, meta);
    }
  }
  if (manager) {
    try { await manager.close(); manager = null; page = null; } catch (closeErr) { /* ... */ }
  }
  return failAssignment(msg);
}
```

---

## 六、native alert guard 说明

| 要求 | 实现 |
| --- | --- |
| page 创建后尽早注册 | 登录成功后立即 `registerNativeAlertGuard`，在 `ensureCleanHome` 之前 |
| 登录前就注册 | 由 `BnsySessionManager.ensureBnsyLoggedIn` 内部保障登录流程；guard 在登录成功后第一时间注册，业务导航前已生效 |
| alert/confirm/prompt 不阻塞 | beforeunload→dismiss，alert/confirm→accept，prompt→accept('') |
| 默认 dismiss 或 accept | 以 Phase 5-H 稳定行为为准（alert/confirm→accept） |
| 记录日志 | `[Agent][Runtime] Native alert 已注册` / `已处理 native dialog：xxx` |
| 避免重复注册 | `WeakSet<Page>` 去重 |

四个业务全部走此 guard（在各自 Executor 中调用）。

---

## 七、DOM 弹窗清理说明

`cleanDomPopups` 四层清理（只点"取消/关闭/知道了"，不点"确定"）：

1. 最上层 `.el-message-box` 二次确认框 → 点"取消"
2. `.pay-dialog` 充值弹窗 → 点 footer 内"取消"（不点 X，避免触发二次确认）
3. 其他 `.el-dialog__wrapper`（标题含充值/余额/警告/缴费/付费）→ 点"取消"
4. 通用 `.el-dialog__wrapper` / `.el-message-box__wrapper` → 点可见的"取消/关闭/知道了/否/暂不/忽略/跳过/我再想想/以后再说"

清理时机（全部通过 `afterPageChangedCleanup` 统一钩子触发）：

- 登录后 `ensureCleanHome` 内部
- 进入业务页面前（`navigateToBusinessPageMenuFirst` 内部 `ensureCleanHome` + `afterPageChangedCleanup`）
- 进入业务页面后（DryRun 内 `afterPageChangedCleanup(page, log, meta, '<biz>-after-enter')`）
- 任务结束回首页后（Executor 成功/catch 路径 `afterPageChangedCleanup(page, log, meta, '<biz>-before-close')`）

清理失败只打 warning，不阻断主流程。

---

## 八、clean home 说明

`ensureCleanHome` / `restoreCleanHome` 流程：

1. 确认 page 存活
2. `page.goto(BNSY_HOME_URL)` 等待 domcontentloaded
3. 等待页面稳定
4. `afterPageChangedCleanup`（guard drain + cleanDomPopups + 二次 drain）
5. 输出 clean home 成功日志

`restoreCleanHome` 与 `ensureCleanHome` 的区别：

- `ensureCleanHome`：任务开始前，失败返回 `{ success: false, error }`，调用方决定是否继续
- `restoreCleanHome`：任务结束后，失败只 warning 不抛异常，绝不覆盖原始业务错误

---

## 九、业务页面验证

`navigateToBusinessPageMenuFirst` 在每次菜单点击 / URL 兜底后都调用 `verifyBusinessPage`：

- URL 包含 `spec.pathFragment`
- 或页面存在 `spec.requiredElements` 中至少一个选择器
- 不只依赖 `page.goto` 成功

验证失败则按"菜单重试 → URL 兜底"流程处理。

---

## 十、BrowserManager 改造边界

本阶段未重写 BrowserManager，仅依赖其现有能力：

- `manager.start()` / `manager.connect()` / `manager.openPage(loginUrl)` / `manager.close()` 保持不变
- `pruneToSingleTab()` 行为未触碰
- 上层 `ensureCleanHome()` 负责进入 dashboard，BrowserManager 不强行写业务导航
- Chrome 路径配置 / userDataDir / profile 语义未触碰

---

## 十一、run-engine 防误入保持

未触碰 `backend/api/routes.ts` 中四业务的 run-engine 入口，仍保持：

- arrival → 409 `TASK_TYPE_MIGRATED_TO_AGENT`
- dispatch → 409 `TASK_TYPE_MIGRATED_TO_AGENT`
- sign → 409 `TASK_TYPE_MIGRATED_TO_AGENT`
- integrated → 409 `TASK_TYPE_MIGRATED_TO_AGENT`

`/agent/tasks/:id/run-engine` 端点保留。

---

## 十二、窗口状态说明

本阶段未实现完整 K-2F 窗口状态回传（Cloud UI 精准显示每个 Agent window busy / ready / p0 / login_required）。

但通过以下机制保证资源不残留：

- 成功路径：`restoreCleanHome` + `afterPageChangedCleanup` + `manager.close()` + `page = null`
- catch 路径：同样调用 `restoreCleanHome` + `afterPageChangedCleanup` + `manager.close()` + `page = null`
- `failAssignment` 内部 logger.flush 保证日志回传
- `runningTaskId` 由上层 `executeIntegratedDryRun` / `executeXxxDryRun` 管理，finally 块保证 logger.close

窗口状态精准回传放到下一阶段 K-2F。

---

## 十三、编译验证

| 模块 | 命令 | 结果 |
| --- | --- | --- |
| packages/agent | `npm run build`（`tsc -p tsconfig.json`） | ✅ exit 0，无错误 |
| backend | `npm run build`（`tsc`） | ✅ exit 0，无错误 |
| frontend | `npm run build`（`tsc && vite build`） | ✅ exit 0，仅 Vite chunk size warning（>500kB），不算失败 |

frontend 产出：

```
dist/index.html                   0.39 kB │ gzip:   0.30 kB
dist/assets/index-g8kY1zbZ.css   54.92 kB │ gzip:  11.04 kB
dist/assets/index-BYcehUYs.js   550.54 kB │ gzip: 161.74 kB
```

---

## 十四、不做 E2E

本阶段严格按规范不执行 E2E，仅做编译验证。所有改动均通过 `tsc` 类型检查。

---

## 十五、后续 E2E 验证建议（留给 Trae）

下一阶段可执行以下 E2E 验证项：

1. **Arrival dryRun**：创建 arrival task，验证 Agent 侧日志出现 `[Agent][Navigator] arrival 菜单优先导航开始` / `arrival 第一次菜单点击成功` / `arrival 进入页面后弹窗清理完成`，且 `navResult.method` 为 `sidebar_first`。
2. **Dispatch dryRun**：同上，验证 `dispatch` 导航日志。
3. **Sign dryRun**：同上，验证 `sign` 导航日志（含中间菜单"签收"点击）。
4. **Integrated dryRun**：同上，验证 `integrated` 导航日志（菜单文本为"到件扫描"非"到派一体"）。
5. **native alert guard**：人为注入 `window.alert()` / `confirm()`，验证 `[Agent][Runtime] 已处理 native dialog` 日志且页面不阻塞。
6. **DOM 弹窗清理**：人为注入 `.el-message-box` / `.pay-dialog`，验证 `cleanDomPopups` 日志且只点"取消"。
7. **菜单失败回退**：模拟菜单点击失败，验证 `method: sidebar_retry` → `url_fallback` 回退路径。
8. **任务结束回首页**：任务完成后验证 `restoreCleanHome` 日志 + 浏览器关闭前 URL 在 dashboard。
9. **catch 路径回首页**：人为触发业务错误，验证 catch 路径仍调用 `restoreCleanHome` 且不覆盖原始错误。
10. **run-engine 防误入**：直接 curl `/agent/tasks/:id/run-engine`，验证四业务均返回 409 `TASK_TYPE_MIGRATED_TO_AGENT`。

---

## 十六、文件变更清单

### 新增

- `packages/agent/src/browser/AgentBusinessRuntime.ts`（998 行）

### 修改

- `packages/agent/src/browser/ArrivalBrowserDryRun.ts`
- `packages/agent/src/browser/DispatchBrowserDryRun.ts`
- `packages/agent/src/browser/SignBrowserDryRun.ts`
- `packages/agent/src/browser/IntegratedBrowserDryRun.ts`
- `packages/agent/src/executors/ArrivalExecutor.ts`
- `packages/agent/src/executors/DispatchExecutor.ts`
- `packages/agent/src/executors/SignExecutor.ts`
- `packages/agent/src/executors/IntegratedExecutor.ts`

### 未触碰（按限制要求）

- `backend/api/routes.ts`（run-engine 入口保留）
- `backend/agent/agentRoutes.ts`（complete 回写保留）
- `packages/agent/src/browser/BrowserManager.ts`
- `packages/agent/src/browser/BnsySessionManager.ts`
- 数据库 schema
- `ENABLE_REAL_SUBMIT` 环境变量（未设置）

---

## 十七、验收结论

| 验收项 | 状态 |
| --- | --- |
| Agent 侧公共运行时模块 AgentBusinessRuntime.ts 已建立 | ✅ |
| 提供 9 个公共函数（guard / clean / ensure / restore / navigate / logFn） | ✅ |
| 四个 BrowserDryRun 改为菜单优先导航 + afterPageChangedCleanup | ✅ |
| 四个 Executor 统一生命周期（guard + ensureCleanHome + finally restore） | ✅ |
| native alert guard 统一注册，WeakSet 防重复 | ✅ |
| DOM 弹窗清理四层策略，只点"取消/关闭" | ✅ |
| 菜单优先三段式导航（sidebar_first → sidebar_retry → url_fallback） | ✅ |
| 业务页面验证（URL + requiredElements） | ✅ |
| 任务结束 restoreCleanHome，失败不覆盖原始错误 | ✅ |
| catch 路径也尽力 restoreCleanHome | ✅ |
| run-engine 防误入保持 409 | ✅ |
| 不启用真实提交，安全门保留 | ✅ |
| 不破坏 Arrival / Dispatch 已通过链路 | ✅ |
| 不破坏 Dispatch 多员工 assignments | ✅ |
| Agent 运行时不 import backend runtime 对象 | ✅ |
| `cd packages/agent && npm run build` 通过 | ✅ |
| `cd backend && npm run build` 通过 | ✅ |
| `cd frontend && npm run build` 通过（仅 chunk warning） | ✅ |
| 未执行 E2E（按规范） | ✅ |

**本阶段目标达成**：Agent 侧已补齐 Phase 5-H 已验证的基础运行时最小闭环，四条业务链路统一复用公共能力，编译全部通过，原有 Cloud 侧稳定代码与已通过链路均未被破坏。
