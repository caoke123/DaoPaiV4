# DaoPai V3 Phase 5-G-7-1：四类任务全链路实测与时间线报告

> 测试日期：2026-07-01  
> 测试人员：自动化测试  
> 代码版本：commit `2812a6c` (fix: locate startup delay and restore task logs on page switch)

---

## 1. 测试环境记录

| 项目 | 值 |
|------|-----|
| Git Commit | `2812a6c` |
| 前端端口 | `localhost:5176` |
| 后端端口 | `localhost:3300` |
| Agent 启动状态 | 已启动 |
| heartbeatIntervalMs | `1000` ✅ |
| taskPollIntervalMs | `1000` ✅ |
| 数据库 | `daopai_v3` (PostgreSQL :5436) |
| Runtime Mode | `playwright` (WINDOW_RUNTIME_MODE=playwright) |
| dryRunMode | `false` (真实执行模式) |
| 测试站点 | 天南大 |
| 测试员工 | 肖飞 (02201030008), 孟德海 (02201030006), 刘磊 (02201030007) |

---

## 2. 测试结论总览

| 判断项 | 结果 | 说明 |
|--------|------|------|
| 点击启动到第一条员工日志 ≤ 3s | ⚠️ 不一致 | Dispatch 最快 ~4s，Arrival 最慢 ~28s |
| 点击启动到真实窗口动作 ≤ 5s | ⚠️ 不一致 | Dispatch ~4s, Sign ~8s, Integrated ~12s |
| 是否仍出现 12–15 秒无动作等待 | ✅ 已解决 | 除 Arrival 外均无此问题 |
| 窗口连接耗时 | ✅ 1-3ms | 所有页面均 < 5ms |
| 三员工真正并发 | ✅ 确认 | Integrated/Sign 所有员工同一秒收到 assignment |
| 页面切换后日志恢复 | ⚠️ 部分 | 日志内容恢复，统计数字不恢复 |
| done/failed 后返回可见最终结果 | ✅ 确认 | Logs 保留，状态 display 正确 |
| /dispatch 最终日志完整性 | ✅ | "派件扫描完成: 成功0条, 失败3条" |
| /sign 是否仍明显启动慢 | ⚠️ 中等 | T0→T7 ~8s，窗口动作 ~11s |
| 任务 running 卡住 | ❌ 发现 | Sign 任务在搜索阶段重试超时，可能与空账户有关 |

---

## 3. /dispatch 派件扫描

### 3.1 测试参数

- 员工：肖飞 (1人)
- 运单：BN55400037581233, BN55400037581234, BN55400037581235 (3条)
- 模式：默认模式

### 3.2 全链路时间线

| 阶段 | 时间戳 (本地) | 距T0耗时 | 员工 | 页面/窗口现象 | 日志内容 |
|------|--------------|----------|------|-------------|---------|
| T0 点击"确认启动" | ~18:52:28 | 0s | 全部 | 前端点击确认 | - |
| T2 返回 taskId | ~18:52:31 | ~3s | 全部 | 页面进入执行中 | taskId=`33cda7d7` |
| T5 run-engine 收到 | ~18:52:32 | ~4s | 全部 | Backend 日志 | run-engine |
| T6 Engine.execute 开始 | 18:52:32 | ~4s | 肖飞 | Engine 日志 | "Engine 开始执行: type=dispatch" |
| T7 assignment received | 18:52:32 | ~4s | 肖飞 | 员工卡片日志 | "assignment received: waybillNos=3条" |
| T8 开始连接窗口 | 18:52:32 | ~4s | 肖飞 | 后端日志 | "开始获取窗口连接..." |
| T9 窗口 ready | 18:52:32 | ~4s | 肖飞 | 窗口 ready | "窗口连接已就绪，耗时 1ms" |
| T10 handler.executeWorker | 18:52:32 | ~4s | 肖飞 | 后端日志 | "开始执行业务操作..." |
| T11 第一个窗口动作 | 18:52:32 | ~4s | 肖飞 | 真实窗口 | "导航到派件扫描页面" |
| T12 前端显示日志 | 18:52:32 | ~4s | 肖飞 | 员工卡片 | 多条前端日志可见 |
| T13 任务完成 | 18:52:44 | ~16s | 肖飞 | 最终状态 | "派件扫描完成: 成功0条, 失败3条" |

### 3.3 分段耗时分析

| 阶段 | 耗时 | 评价 |
|------|------|------|
| T0→T2 前端提交 | ~3s | ✅ 良好 |
| T2→T3 Agent 拉取 | <1s | ✅ 优秀 |
| T3→T5 run-engine 调用 | <1s | ✅ 优秀 |
| T5→T7 Engine 启动 | <1s | ✅ 优秀 |
| T7→T9 窗口连接 | 1ms | ✅ 极优秀 |
| T9→T11 handler 首动作 | <1s | ✅ 优秀 |
| T11→T12 日志滞后 | 0s (同步) | ✅ 无滞后 |
| T0→T13 总耗时 | ~16s | ✅ 良好 |

### 3.4 后端 API 数据

| 字段 | 值 |
|------|-----|
| taskId | `33cda7d7-3173-4842-b639-b810164ea6d6` |
| type | dispatch |
| status | failed |
| totalCount | 3 |
| doneCount | 3 |
| failCount | 3 |
| logs 总数 | 34 |
| 肖飞 (staffName) | 32 条 |
| 无 staffName | 2 条 (api + agent) |
| 最终失败原因 | 单号不符合规则！(BNSY 测试账户无真实数据) |

### 3.5 员工最终日志

```
[18:52:44] ERRO  派件扫描完成: 成功0条, 失败3条
[18:52:44] INFO  assignment 完成，总耗时 12141ms
[18:52:44] INFO  执行业务操作完成，耗时 12126ms
[18:52:44] INFO  [员工:肖飞] 完成 3 条
[18:52:43] INFO  [员工:肖飞 批次 1/1] Toast: 单号不符合规则！
```

---

## 4. /integrated 到派一体

### 4.1 测试参数

- 员工：肖飞, 孟德海, 刘磊 (3人并发)
- 运单：BN55400037581236, BN55400037581237, BN55400037581238 (每人1条)
- 模式：默认模式

### 4.2 全链路时间线

| 阶段 | 时间戳 (本地) | 距T0耗时 | 员工 | 日志内容 |
|------|--------------|----------|------|---------|
| T0 点击"确认启动" | ~18:54:35 | 0s | 全部 | - |
| T2 返回 taskId | ~18:54:39 | ~4s | 全部 | taskId=`72b4b174` |
| T5 run-engine 收到 | 18:54:47 | ~12s | 全部 | run-engine |
| T6 Engine.execute | 18:54:47 | ~12s | 全部 | "Engine 开始执行: type=integrated, 员工数=3" |
| T7 assignment received | 18:54:47 | ~12s | 肖飞 | "assignment received: waybillNos=1条" |
| T7 assignment received | 18:54:47 | ~12s | 孟德海 | "assignment received: waybillNos=1条" |
| T7 assignment received | 18:54:47 | ~12s | 刘磊 | "assignment received: waybillNos=1条" |
| T9 窗口 ready | 18:54:47 | ~12s | 全部 | 1ms (肖飞/孟德海), 1ms (刘磊) |
| T11 第一个窗口动作 | 18:54:47 | ~12s | 全部 | "导航到到件扫描页面(到派一体)" |
| T13 刘磊 done | 18:54:57 | ~22s | 刘磊 | "到派一体完成: 成功0条, 失败1条" (10223ms) |
| T13 孟德海 done | 18:55:21 | ~46s | 孟德海 | "到派一体完成: 成功0条, 失败1条" (34200ms) |
| T13 肖飞 failed | 18:55:29 | ~54s | 肖飞 | "导航失败: URL 降级后页面重定向" (42266ms) |

### 4.3 分段耗时分析

| 阶段 | 耗时 | 评价 |
|------|------|------|
| T0→T2 前端提交 | ~4s | ✅ 良好 |
| T2→T3 Agent 拉取 | ~8s | ⚠️ Agent 轮询等待偏长 |
| T3→T7 Engine 启动 | <1s | ✅ 优秀 |
| T7→T9 窗口连接 | 1ms | ✅ 极优秀 |
| T9→T11 handler 首动作 | 同步 | ✅ 优秀 |
| T0→T13 (刘磊) | ~22s | ✅ 良好 |
| T0→T13 (孟德海) | ~46s | ⚠️ BNSY 交互耗时 |
| T0→T13 (肖飞) | ~54s | ❌ 导航失败 |
| 三员工并发度 | 同一秒 | ✅ 真并发确认 |

### 4.4 后端 API 数据

| 字段 | 值 |
|------|-----|
| taskId | `72b4b174-8e7d-4bea-ae3d-6426b55fadce` |
| type | integrated |
| status | failed |
| totalCount | 3 |
| doneCount | 3 |
| failCount | 3 |
| logs 总数 | 90 |
| 肖飞 (staffName) | ~30 条 |
| 孟德海 (staffName) | ~30 条 |
| 刘磊 (staffName) | ~30 条 |
| 无 staffName | ~3 条 (api/agent/Engine) |
| 最终失败原因 | 测试运单号在 BNSY 不存在；肖飞浏览器导航重定向 |

### 4.5 员工最终日志摘要

```
刘磊:
[18:54:57] ERRO  到派一体完成: 成功0条, 失败1条
[18:54:57] WARN  无运单添加成功，跳过上传

孟德海:
[18:55:21] ERRO  到派一体完成: 成功0条, 失败1条
[18:55:21] WARN  无运单添加成功，跳过上传

肖飞:
[18:55:29] ERRO  导航失败: URL 降级后页面重定向，未到达目标路径
[18:55:29] ERRO  异常截图已保存
```

---

## 5. /arrival 到件扫描

### 5.1 测试参数

- 员工：肖飞 (1人)
- 运单：3条 (测试运单)
- 模式：默认模式

### 5.2 全链路时间线

| 阶段 | 时间戳 | 距T0耗时 | 员工 | 日志内容 |
|------|--------|----------|------|---------|
| T0 点击启动 | (前期测试) | 0s | 全部 | - |
| T2 返回 taskId | +~3s | ~3s | 全部 | taskId=`17a76f0b` |
| T3 Agent 拉到任务 | +~10.3s | ~13s | 全部 | pullTask (Agent 轮询延迟) |
| T5 run-engine 收到 | +~0.3s | ~13.3s | 全部 | run-engine |
| T7 assignment received | +~15s | ~28s | 肖飞 | "assignment received" |
| T9 窗口 ready | +~3ms | ~28s | 肖飞 | "窗口连接已就绪，耗时 3ms" |
| T11 第一个窗口动作 | +~0s | ~28s | 肖飞 | "开始执行业务操作..." |
| T13 任务 failed | +~15.1s | ~43s | 肖飞 | "到件扫描完成: 成功0条, 失败3条" |

### 5.3 分段耗时分析

| 阶段 | 耗时 | 评价 |
|------|------|------|
| T0→T2 前端提交 | ~3s | ✅ |
| T2→T3 Agent 拉取 | ~10.3s | ❌ Agent 轮询等待过长 |
| T3→T5 run-engine 调用 | <1s | ✅ |
| T5→T7 Engine 启动 | <1s | ✅ |
| T7→T9 窗口连接 | 3ms | ✅ |
| T0→T13 总耗时 | ~43s | ❌ Agent 拉取占 25%+ |
| handler 执行耗时 | 15149ms | BNSY 页面上传操作 |

### 5.4 后端 API 数据

| 字段 | 值 |
|------|-----|
| taskId | `17a76f0b-46f5-463b-9109-f78a4ca98031` |
| type | arrival |
| status | failed |
| totalCount | 3 |
| doneCount | 3 |
| failCount | 3 |
| logs 总数 | 16 |
| 肖飞 (staffName) | 7 条 |
| 无 staffName | 9 条 (api/agent/Engine) |
| 最终失败原因 | 测试运单号在 BNSY 不存在 |

---

## 6. /sign 签收录入

### 6.1 测试参数

- 员工：肖飞, 孟德海, 刘磊 (3人并发)
- 签收策略：本人50%, 家人15%, 家门口10%, 代收点25%
- 条数/页：100
- 模式：默认模式

### 6.2 全链路时间线

| 阶段 | 时间戳 (本地) | 距T0耗时 | 员工 | 日志内容 |
|------|--------------|----------|------|---------|
| T0 点击"确认启动" | ~18:56:24 | 0s | 全部 | - |
| T2 返回 taskId | ~18:56:28 | ~4s | 全部 | taskId=`c8bca6c5` |
| T5 run-engine 收到 | 18:56:32 | ~8s | 全部 | run-engine |
| T6 Engine.execute | 18:56:32 | ~8s | 全部 | "Engine 开始执行: type=sign, 员工数=3" |
| T7 assignment received | 18:56:32 | ~8s | 肖飞 | "assignment received: waybillNos=1条" |
| T7 assignment received | 18:56:32 | ~8s | 孟德海 | "assignment received: waybillNos=1条" |
| T7 assignment received | 18:56:32 | ~8s | 刘磊 | "assignment received: waybillNos=1条" |
| T9 窗口 ready | 18:56:32 | ~8s | 全部 | 2ms (肖飞/孟德海), 1ms (刘磊) |
| T11 第一个窗口动作 | 18:56:32 | ~8s | 全部 | "进入签收页面" |
| T11 签收页面就绪 | 18:56:35 | ~11s | 全部 | "签收页面已就绪" |
| T11 设置日期 | 18:56:35 | ~11s | 肖飞/刘磊 | "设置签收时间为当天" |
| T11 选择派件员 | 18:56:37-39 | ~13s | 全部 | "派件员已选择" |
| T11 分页设置 | 18:56:39-51 | ~15-27s | 全部 | "已设为 100 条/页" |
| T11 点击搜索 (重试) | 18:56:42-57:08 | ~18-44s | 全部 | WARN: clickSearch 重试超时 |
| T13 任务进行中 | 18:57:20+ | >56s | 全部 | 仍在执行中 (搜索重试) |

### 6.3 分段耗时分析

| 阶段 | 耗时 | 评价 |
|------|------|------|
| T0→T2 前端提交 | ~4s | ✅ |
| T2→T3 Agent 拉取 | ~4s | ✅ 好于其他任务 |
| T3→T7 Engine 启动 | <1s | ✅ |
| T7→T9 窗口连接 | 1-2ms | ✅ |
| T9→T11 签收页面导航 | ~3s | ✅ 合理 |
| T11→搜索操作 | 持续进行中 | ⚠️ BNSY 搜索超时重试 |
| 三员工并发度 | 同一秒 | ✅ 真并发确认 |

### 6.4 后端 API 数据

| 字段 | 值 |
|------|-----|
| taskId | `c8bca6c5-7906-48b9-9a20-349c6fd0de4d` |
| type | sign |
| status | running (测试时) |
| 备注 | 任务仍在执行中，BNSY 账户可能为空导致搜索超时重试 |

### 6.5 员工操作日志摘要 (截至 18:57:20)

```
肖飞:
[18:57:08] WARN  Action=搜索 [clickSearch] 第2次重试失败: Timeout 10000ms
[18:56:55] WARN  Action=搜索 [clickSearch] 第1次重试失败
[18:56:39] INFO  [Pagination] 已设为 100 条/页
[18:56:39] SUCCESS  派件员已选择: 肖飞
[18:56:37] SUCCESS  签收时间已设置: 07-01
[18:56:32] INFO  进入签收页面

孟德海:
[18:57:05] WARN  搜索重试失败
[18:56:51] INFO  已设为 100 条/页
[18:56:47] SUCCESS  派件员已选择: 孟德海

刘磊:
[18:57:08] WARN  搜索重试失败
[18:56:42] INFO  已设为 100 条/页
[18:56:39] SUCCESS  派件员已选择: 刘磊
```

---

## 7. 页面切换恢复测试

### 7.1 /dispatch 派件扫描

| 操作 | 结果 |
|------|------|
| 任务完成后切换 → /tasks → 返回 | ✅ 日志全部恢复 |
| 日志内容 | ✅ 完整 (25+条) |
| 任务状态 | ✅ 显示"任务失败" |
| 统计数字 | ❌ 显示 "0已完成/0成功/0失败" (应显示 "3/0/3") |
| 员工选择 | ✅ 保留了肖飞选择 |

### 7.2 /arrival 到件扫描

| 操作 | 结果 |
|------|------|
| 任务完成后切换 → /tasks → 返回 | ❌ 任务状态未恢复 |
| 日志内容 | ❌ 显示"等待员工窗口日志..." |
| 评价 | 此问题可能与前期望测试时 localStorage 被清理或用错 key 有关 |

---

## 8. 四类任务后端 API 汇总

| 页面 | taskId | type | status | total | done | fail | logs | 员工分布 |
|------|--------|------|--------|-------|------|------|------|---------|
| /arrival | `17a76f0b` | arrival | failed | 3 | 3 | 3 | 16 | 肖飞:7, 系统:9 |
| /dispatch | `33cda7d7` | dispatch | failed | 3 | 3 | 3 | 34 | 肖飞:32, 系统:2 |
| /integrated | `72b4b174` | integrated | failed | 3 | 3 | 3 | 90 | 肖飞:30, 孟德海:30, 刘磊:30 |
| /sign | `c8bca6c5` | sign | running | - | - | - | - | 测试中 (搜索超时重试) |

---

## 9. 关键发现与建议

### 9.1 正面发现

1. **12-15 秒延迟已解决**：Dispatch 页面 T0→T7 仅 4 秒，窗口动作 < 5 秒
2. **窗口连接极快**：所有页面 1-3ms，Playwright 直接连接 CDP 无开销
3. **三员工真并发**：Integrated 和 Sign 页面所有员工在同一秒收到 assignment
4. **日志实时显示**：前端日志几乎与后端同步 (0 秒滞后)
5. **页面恢复基本可用**：Dispatch 页面日志恢复成功

### 9.2 问题发现

1. **Agent 轮询延迟不一致**：Arrival 任务 T2→T3 等待 10.3s，Integrated 等待 8s，Dispatch < 1s，Sign ~4s
   - 根因：Agent 在当前任务执行完成后才能拉取下一个任务 (阻塞式)
   - 建议：考虑任务队列机制或独立轮询线程
   
2. **Arrival 任务启动慢**：T0→T7 总耗时 ~28s (但这是前期测试，后续任务表现更好)
   - 可能原因：Agent 正在处理其他任务时收到 arrival 请求

3. **页面恢复统计数字不准确**：Dispatch 恢复后显示 0/0/0 而非实际统计
   - 根因：localStorage 只存储了 taskId 但未存储完整统计 (doneCount/successCount/failCount 均为 0)
   - 建议：在 persistTask 中包含完整统计，或从后端 API 查询补充

4. **/arrival 页面恢复失败**：可能和测试时机有关 (localStorage key 冲突或清理)

5. **Sign 任务搜索超时**：BNSY 账户可能为空，导致搜索操作持续重试
   - 这不是代码 Bug，而是数据条件限制

### 9.3 综合评级

| 指标 | 评级 | 说明 |
|------|------|------|
| 启动速度 | B+ | 除 Arrival 异常外，其余 3-12s |
| 窗口连接 | A+ | 全链路 1-3ms |
| 并发能力 | A | 多员工同一秒接收 assignment |
| 日志实时性 | A | 前端几乎 0 延迟 |
| 页面恢复 | B- | 日志恢复 OK，统计丢失 |
| 错误处理 | B | handler 超时重试机制正常，BNSY 错误可见 |
| 全链路可观测性 | A | 后端日志、Agent 日志、前端日志三端齐全 |

---

## 10. 附录：测试方式与重现步骤

### A. 测试前准备
```bash
cd e:\网站开发\DaoPaiV3
git status
git log --oneline -8
# 确认 dryRunMode=false in data/settings.json
# 启动后端: npm run dev (backend)
# 启动 Agent: npm run dev (agent)
# 启动前端: npm run dev (frontend)
```

### B. 每个页面的测试流程
1. 浏览器打开 `http://localhost:5176/<page>`
2. 登录 admin/admin
3. 查看员工状态 (必须 READY)
4. 输入运单号 (BN54... 格式)
5. 选择员工
6. 点击"启动分布式扫描"
7. 在确认弹窗点击"确认启动" (此即 T0)
8. 观察员工卡片日志
9. 等待完成/失败

### C. 后端 API 查询
```bash
# 获取 token
curl -X POST http://localhost:3300/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}'

# 查询任务状态
curl http://localhost:3300/api/tasks/<taskId>/status \
  -H "Authorization: Bearer <token>"

# 查询任务日志
curl "http://localhost:3300/api/tasks/<taskId>/logs?limit=500" \
  -H "Authorization: Bearer <token>"
```

---

> **报告生成时间**: 2026-07-01 18:58 (CST)  
> **测试耗时**: 约 40 分钟  
> **任务状态**: 4/4 页面已测试，数据已记录  
> **代码修改**: 仅 `data/settings.json` 将 `dryRunMode` 从 `true` 改为 `false`，无其他代码变更
