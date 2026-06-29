# DaoPai V3 Phase 3 已知问题与处理意见

## 1. 当前阶段结论

Phase 3-B 最小 JWT 登录基础已完成（commit: 7dfcbaa）。
npm test 全量 59 tests，55 passed，4 failed。
4 个失败均为预存问题，与 Phase 3-B 无关。

## 2. 已知问题列表

| 编号 | 问题 | 级别 | 是否阻塞 | 当前处理 | 后续建议 |
| ---- | ---- | ---- | -------- | -------- | -------- |
| ISSUE-008 | credentials.ts 只有占位数据，导致 4 个 fallback 测试失败 | P2 | 否（不影响功能） | 不修复，测试仅验证 fallback 机制 | 恢复真实凭据数据后可重新启用测试 |

## 3. 失败测试详情

### 3.1 loginCredential 测试 (3 failures)

**文件**: `backend/browser/__tests__/loginCredential.test.ts`

| 测试 | 失败原因 |
| ---- | -------- |
| C2b: settings.json 无该 browserId → fallback 到 credentials.ts（刘磊 旧员工） | `findCredential('刘磊')` 返回 `undefined`，credentials.ts 只有占位员工A/B/C/D |
| C4: settings.json 找到窗口但 password 为空 → fallback 到 credentials.ts | `findCredential('肖飞')` 返回 `undefined`，同上 |
| C5: settings.json 读取异常 → 不崩溃，走 fallback | `findCredential('肖飞')` 返回 `undefined`，同上 |

**根因**: `credentials.ts` 中的 `findCredential` 函数只在 `TIANNANDA_CREDENTIALS` 和 `HEYUAN_CREDENTIALS` 数组中查找，这两个数组已替换为占位数据（员工A/B/C/D），不包含测试引用的刘磊、肖飞等真实员工。

**影响**: 不影响生产功能。`resolveLoginCredential` 的 fallback 逻辑正确，只是在测试环境中没有真实凭据数据。settings.json 优先路径在 C1/C2/C3/C6/C7 测试中均已验证通过。

### 3.2 resolveWorkerCredential 测试 (1 failure)

**文件**: `backend/config/__tests__/resolveWorkerCredential.test.ts`

| 测试 | 失败原因 |
| ---- | -------- |
| T3: settings.json 未命中 → fallback credentials.ts（仅存在于静态列表的员工） | `findCredential('刘磊')` 返回 `undefined`，credentials.ts 只有占位数据，fallback 失败后抛出异常 |

**根因**: 同上，`credentials.ts` 中不包含刘磊。

**影响**: 不影响生产功能。`resolveWorkerCredential` 的 settings.json 优先路径在 T1/T2/T4/T5/T6/T7 测试中均已验证通过。

## 4. 判断结论

**4 个失败测试均与 Phase 3-B 无关。**

- 失败测试所属模块：`BrowserPool.resolveLoginCredential`（凭据解析）和 `SettingsManager.resolveWorkerCredential`（员工凭据解析）
- Phase 3-B 修改范围：`backend/auth/`（密码、JWT、认证中间件、路由）、`backend/api/middleware/requestContext.ts`、`backend/db/PgDatabase.ts`（用户/Token 方法）、`backend/index.ts`（挂载路由）
- 无任何交集

## 5. 处理建议

- 当前阶段不修复，不阻塞 Phase 3-B 验收
- 后续如需恢复 fallback 测试：
  1. 在 `credentials.ts` 中补充刘磊、肖飞等真实员工的凭据数据
  2. 或修改测试用例，mock `findCredential` 函数返回模拟数据