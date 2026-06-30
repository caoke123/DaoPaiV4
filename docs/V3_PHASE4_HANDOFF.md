# DaoPai V3 Phase 4 交接文档

> 版本：v1.0
> 日期：2026-06-30
> 阶段：Phase 4-G（验收与交接文档，仅文档，不写代码）
> 前置 commit：`104ed9a` — feat: add Agent task loop dry run

---

## 1. 当前系统结构

```
DaoPai V3
├── Cloud Platform（云端管理中心）
│   ├── 用户登录（JWT，15分钟 access + 7天 refresh）
│   ├── 任务中心（任务列表、状态、日志、详情）
│   ├── 系统管理（快递公司、网点、执行电脑、用户，只读）
│   ├── 任务状态真理源（PostgreSQL 主写）
│   └── /agent/* API（Agent 专属接口）
│
└── Local Agent（本地执行端）
    ├── 心跳上报（15秒/次）
    ├── 任务拉取（HTTP 轮询）
    ├── 任务执行（当前仅支持 agent_test 模拟任务，真实业务任务尚未接入）
    ├── 进度回传
    ├── 日志回传
    └── 结果回传（complete/fail）
```

**关键原则**：

- Cloud 不直接控制浏览器，Agent 负责本机浏览器自动化
- Agent 不管理 SaaS 用户，用户管理在 Cloud
- 通信使用 HTTP（非 WebSocket），Agent 主动轮询

---

## 2. 关键目录

```
DaoPai V3/
├── backend/
│   ├── agent/
│   │   └── agentRoutes.ts          # /agent/* 路由定义
│   ├── auth/
│   │   ├── agentAuth.ts            # requireAgent 中间件
│   │   ├── agentToken.ts           # 执行电脑授权码生成/验证
│   │   └── types.ts                # AgentPrincipal 类型
│   ├── scripts/
│   │   └── createAgentDevToken.ts  # 开发用授权码生成脚本
│   ├── api/routes.ts               # agent-test-task 创建接口
│   └── db/PgDatabase.ts            # Agent 相关数据库方法
│
├── packages/agent/                 # Local Agent 独立项目
│   ├── src/
│   │   ├── index.ts                # 主入口（心跳 + 任务循环）
│   │   ├── httpClient.ts           # HTTP 客户端封装
│   │   ├── config.ts               # 配置加载
│   │   ├── logger.ts               # 日志系统
│   │   ├── startupCheck.ts         # 启动检查
│   │   └── types.ts                # 类型定义
│   ├── agent.example.json          # 配置模板（agent.json 由本地复制生成，不提交 Git）
│   ├── package.json
│   └── tsconfig.json
│
├── database/migrations/
│   ├── 004_v3_agent_token_auth.sql # 执行电脑鉴权字段
│   └── 005_v3_agent_task_loop.sql  # 任务管道字段
│
└── docs/
    ├── V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md
    ├── V3_PHASE4B_AGENT_TOKEN_AUTH.md
    └── V3_PHASE4C_AGENT_API_PROTOCOL.md
```

---

## 3. 关键接口

### 3.1 Agent 接口（/agent/*）

全部使用 `requireAgent` 中间件鉴权（Bearer 执行电脑授权码）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /agent/me | 验证授权码，返回执行电脑信息 |
| POST | /agent/heartbeat | 心跳上报，返回 hasTask 标志 |
| POST | /agent/tasks/pull | 原子化拉取一个 pending 任务 |
| POST | /agent/tasks/:id/progress | 上报任务进度（0-100） |
| POST | /agent/tasks/:id/logs | 批量上报日志（最多 100 条） |
| POST | /agent/tasks/:id/complete | 任务完成（幂等） |
| POST | /agent/tasks/:id/fail | 任务失败（幂等） |

### 3.2 测试接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/cloud/agent-test-task | 创建 agent_test 测试任务（需用户 JWT） |

---

## 4. 数据流转

```
用户创建 agent_test 任务（POST /api/cloud/agent-test-task）
    │
    ▼
Cloud 写入 tasks（status=pending, type=agent_test）
    │
    ▼
Agent heartbeat 发现 hasTask=true
    │
    ▼
Agent 调用 POST /agent/tasks/pull
    │
    ▼
Cloud 原子化分配任务（status=assigned, workstation_id=当前执行电脑, assigned_at=NOW()）
    │
    ▼
Agent 调用 POST /agent/tasks/:id/progress（status=running, progress=10%）
    │
    ▼
Agent 调用 POST /agent/tasks/:id/logs（批量上报执行日志）
    │
    ▼
Agent 模拟执行 3 秒（durationMs=3000）
    │
    ▼
Agent 调用 POST /agent/tasks/:id/progress（progress=100%）
    │
    ▼
Agent 调用 POST /agent/tasks/:id/complete
    │
    ▼
Cloud 标记 tasks（status=done, progress=100, finished_at=NOW()）
    │
    ▼
任务中心展示 done 状态，详情页可查看 Agent 上报的日志
```

---

## 5. 数据库边界

### workstations 表

| 字段 | 说明 |
|------|------|
| agent_token_hash | 执行电脑授权码 SHA-256 hash |
| agent_token_created_at | 授权码生成时间 |
| agent_token_last_used_at | 授权码最后使用时间 |
| agent_token_revoked_at | 授权码撤销时间 |
| last_heartbeat_at | 最后心跳时间 |
| agent_version | 本地执行端版本 |
| online_status | 在线状态（online/offline） |
| browser_status | 本地运行环境状态 |
| last_ip | 最近连接 IP |

### tasks 表

| 字段 | 说明 |
|------|------|
| type | 新增 `agent_test` 类型 |
| status | 新增 `assigned` 状态 |
| workstation_id | 绑定执行电脑 |
| assigned_at | 任务分配时间 |
| progress | 执行进度（0-100） |

### task_logs 表

| 字段 | 说明 |
|------|------|
| source | 新增 `agent` 来源 |
| workstation_id | 产生日志的执行电脑 |

---

## 6. 安全边界

```text
用户 JWT 访问 /api/*
    ├── access token 15 分钟过期
    ├── refresh token 7 天过期
    └── 角色：super_admin / tenant_admin / operator

执行电脑授权码访问 /agent/*
    ├── 与用户 JWT 完全分离
    ├── 授权码生成后只显示一次
    ├── 数据库只保存 SHA-256 hash
    ├── 支持撤销（token_revoked_at）
    └── operator 角色不能管理执行电脑授权码

Agent 任务执行安全
    ├── 只能操作自己拉取的任务（workstation_id 匹配）
    ├── 日志不能包含授权码、账号、密码
    └── 任务所有权校验在每次 API 调用中执行
```

---

## 7. 当前限制

```text
Agent 当前只支持 agent_test 类型任务
Agent 不读取 settings.json（不直接访问网点/员工配置）
Agent 不启动浏览器（不接 Playwright）
Agent 不执行真实业务（到件/派件/签收/到派一体）
Cloud 后端仍保留旧执行能力（BrowserPool + EasyBR）
EasyBR 暂未删除（前端已隐藏用户文案）
Agent 单任务串行执行（无并发）
Agent 通信方式为 HTTP 轮询（非 WebSocket 长连接）
```

---

## 8. Phase 5 建议

### 8.1 建议阶段划分

```
Phase 5-A：真实任务迁移边界设计
    ├── Agent 如何获取网点/员工/窗口配置
    ├── Agent 如何启动浏览器（Playwright）
    ├── Agent 如何执行真实业务操作
    └── 旧执行链路（EasyBR）如何逐步下线

Phase 5-B：Arrival 到件扫描 Agent 化
    ├── Cloud 创建 arrival 任务
    ├── Agent 拉取 + 执行 + 回传
    └── DRY-RUN 先验证，再真实执行

Phase 5-C：Dispatch 派件扫描 Agent 化
Phase 5-D：Sign 签收录入 Agent 化
Phase 5-E：Integrated 到派一体 Agent 化
```

### 8.2 迁移原则

```text
Phase 5-A 先做设计，不要直接迁移真实任务
每次只迁移一个业务类型
优先 DRY-RUN，再真实执行
旧执行链路保留，Agent 链路稳定后再下线
一个业务类型验证通过后，再迁移下一个
```

### 8.3 建议优先处理

1. **Agent 配置下发**：Agent 如何获取网点、窗口、员工信息（当前读 settings.json 在 Cloud 端）
2. **Agent 浏览器管理**：Agent 如何启动、管理 Playwright 浏览器实例
3. **Agent 真实任务执行**：如何将现有 handler（ArrivalHandler 等）迁移到 Agent 端
4. **并发任务模型**：Agent 如何同时执行多个任务
5. **EasyBR 删除专项**：Agent 链路稳定后，删除 EasyBR 和旧 BrowserPool 代码

---

## 9. 已知问题

参见 [V3_PHASE3_KNOWN_ISSUES.md](V3_PHASE3_KNOWN_ISSUES.md)

Phase 4 未引入新的已知问题。

---

## 10. 相关文档

- [Phase 4-A 边界设计](V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md)
- [Phase 4-B Agent Token 鉴权](V3_PHASE4B_AGENT_TOKEN_AUTH.md)
- [Phase 4-C Agent API 协议](V3_PHASE4C_AGENT_API_PROTOCOL.md)
- [Phase 4 验收报告](V3_PHASE4_ACCEPTANCE_REPORT.md)
- [Phase 3 已知问题](V3_PHASE3_KNOWN_ISSUES.md)