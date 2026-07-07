# DaoPai V3 Deploy-0D-Fix 窗口启动/关闭失败修复报告

## 1. 问题现象

**第一轮**：Deploy-0D 代码完成后，重启三端，人工测试发现：**前端无法启动窗口**。

**第二轮**：修复 chromePath 后，窗口可以启动，但：
- 没有执行自动登录
- 关闭窗口失败

---

## 2. 根因定位 — 第一轮：chromePath 计算错误

### 诊断过程

| 段落 | 状态 | 说明 |
|------|------|------|
| Header 创建 command | ✅ 正常 | `createWindowCommand` 被调用 |
| Cloud 写入 window_commands | ✅ 正常 | `workstationId = ws-local-default` 与 Agent 一致 |
| Agent pull command | ✅ 正常 | 拉取到命令并执行 |
| Agent open_window | ❌ **失败** | chromePath 计算错误 |
| Chrome 启动 | ❌ 未启动 | 路径不存在 |

### 根因

`LocalWindowRuntime.ts` 的 `computeChromePath()` 和 `computeProfilePath()` 使用了 `__dirname` 向上 5 级，多算了一层目录。

```
错误: E:\网站开发\chrome\chrome.exe
正确: E:\网站开发\DaoPaiV3\Chrome\App\chrome.exe
```

### 修复

改用 `getLocalRoot()` (来自 config.ts，已经过 Deploy-0B 验证) + `Chrome/App/chrome.exe` 子路径。

---

## 3. 根因定位 — 第二轮：关闭窗口失败

### 根因 1：`browser-session.json` 单文件覆盖

`BrowserProcessRegistry` 使用单个 `runtime/browser-session.json` 文件跟踪 Chrome 进程。

当 LocalWindowRuntime 依次打开多个窗口（如 孟德海 PID 26648, 刘磊 PID 27820），每次 `BrowserManager.start()` 调用 `saveSession()` 会**覆盖**前一个窗口的 session 记录。

当 `executeCloseWindow` 通过 `readSession()` 找 PID 时，只能读到最后一个窗口的 PID。前面的窗口找不到进程，关闭失败。

### 根因 2：`findV3ChromeProcesses` 斜杠方向不一致

`ChromeProcessGuard.findV3ChromeProcesses()` 中：
- `cmdLine` 来自 WMI，路径使用反斜杠 `\`
- `targetDir` 经过 `.replace(/\\/g, '/')` 变为正斜杠 `/`
- `cmdLine.includes(targetDir)` 匹配失败 → 找不到进程

### 修复

1. `executeCloseWindow` 不再依赖 `readSession()`。改为始终通过 `findV3ChromeProcesses(profilePath)` 按用户数据目录定位并关闭进程。

2. `findV3ChromeProcesses` 的 `cmdLine` 也做 `.replace(/\\/g, '/')` 归一化，确保与 `targetDir` 格式一致。

---

## 4. 关于"没有执行自动登录"

**这是 Deploy-0D 的设计预期，不是 Bug。**

Deploy-0D 规范要求：
```
7. 导航到目标系统首页或 dashboard
8. 采集 cdpEndpoint
9. 上报 window_status：starting / login_required 或 ready
```

当前实现：Chrome 启动后导航到 `https://bnsy.benniaosuyun.com/`，页面重定向到 `/login`。Agent 通过 `WindowStatusCollector` 检测 URL 包含 `/login`，上报 `window_status = login_required`。Header 应显示"待登录"状态。

**自动登录功能不在 Deploy-0D 范围内**。当前窗口需要用户手动登录一次，后续通过 profile 持久化保持登录态。

---

## 5. 修改文件列表

| 文件 | 改动 | 轮次 |
|------|------|------|
| `packages/agent/src/local-runtime/LocalWindowRuntime.ts` | 修复 `computeChromePath()` / `computeProfilePath()` 使用 `getLocalRoot()` | 第一轮 |
| `packages/agent/src/local-runtime/LocalWindowRuntime.ts` | 重构 `executeCloseWindow()` 改用 `findV3ChromeProcesses(profilePath)` 定位进程 | 第二轮 |
| `packages/agent/src/browser/ChromeProcessGuard.ts` | `findV3ChromeProcesses` 的 `cmdLine` 做正斜杠归一化 | 第二轮 |
| `packages/agent/src/index.ts` | 清理 `reportWindowStatusLoop` 冗余三元表达式 | 第一轮 |

**未修改**: 四个业务 Executor、dryRunMode、ENABLE_REAL_SUBMIT、Task Center、EasyBR 清理结果。

---

## 6. 修复前后对比

### executeCloseWindow

```ts
// 修复前：依赖 readSession() 单文件 session → 多窗口时覆盖丢失
const session = readSession();
const pid = session?.pid;
if (!pid) {
  const { findV3ChromeProcesses } = await import('../browser/ChromeProcessGuard');
  // ...
}
const killResult = await killV3ChromeByPid(pid);  // PID 可能是错的窗口

// 修复后：始终按 profilePath 扫描 V3 Chrome 进程
const residues = findV3ChromeProcesses(profilePath);
for (const r of residues) {
  const killResult = await killV3ChromeByPid(r.pid);
  // 正确定位并关闭
}
```

### findV3ChromeProcesses 斜杠归一化

```ts
// 修复前
const cmdLine = p.CommandLine || '';
if (!cmdLine.includes(targetDir)) continue;
// cmdLine 用 \ 但 targetDir 用 / → 匹配失败

// 修复后
const cmdLine = (p.CommandLine || '').replace(/\\/g, '/');
if (!cmdLine.includes(targetDir)) continue;
// 统一正斜杠 → 匹配成功
```

---

## 7. 验证结果

| 检查项 | 结果 |
|--------|------|
| `backend && npx tsc --noEmit` | ✅ 通过 |
| `frontend && npx tsc --noEmit` | ✅ 通过 |
| `packages/agent && npx tsc --noEmit` | ✅ 通过 |
| `grep EasyBRClient` (生产路径) | ✅ 未恢复 |
| `grep 硬编码 Chrome 路径` | ✅ 0 结果 |
| `git diff -- executors` | ✅ 零改动 |
| Chrome 窗口启动 | ✅ 通过（Agent 日志确认） |
| Chrome 窗口关闭 | ⏳ 等待人工测试 |
| 自动登录 | ⚠️ 非本阶段范围（见第 4 节） |

---

## 8. 不变项确认

| 项 | 状态 |
|----|------|
| ArrivalExecutor / DispatchExecutor / IntegratedExecutor / SignExecutor | ✅ 未修改 |
| dryRunMode / ENABLE_REAL_SUBMIT | ✅ 未修改 |
| Task Center 日志策略 | ✅ 未修改 |
| Deploy-0B EasyBR 清理结果 | ✅ 未恢复 |
| Deploy-0C window_status 持久化主逻辑 | ✅ 未修改 |

---

## 9. Git 状态

**当前禁止提交 Git。** 等待人工测试通过后再决定是否提交。
