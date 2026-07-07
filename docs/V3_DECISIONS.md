# DaoPai V3 架构关键决策冻结

> 版本：v1.0（Phase 1-C 冻结）
> 适用范围：DaoPai V3 SaaS 方向
> 状态：**已冻结**，后续 Phase 2 及之后的开发应优先遵守本文档。如需变更，必须单独讨论并更新本文档。

本文档用于冻结 DaoPai V3 Phase 1 已确认的关键架构决策。后续 Phase 2 及之后的开发，应优先遵守本文档。如需变更，必须单独讨论并更新本文档。

---

## DECISION-001：数据库迁移方式

### 结论

第一版使用 SQL migration 文件 + schema 版本表，不引入复杂 ORM 迁移框架。

### 建议目录

```text
database/migrations/
  001_init_v3_saas_schema.sql
  002_add_tenant_tables.sql
  ...
```

### 说明

- 当前项目已有 SQL schema 基础。
- V3 第一版以稳定、可读、易排查为主。
- 后续表结构复杂后，再评估 Drizzle / Prisma / node-pg-migrate。

---

## DECISION-002：会话和鉴权方案

### 结论

- **云端用户登录**：JWT + Refresh Token
- **Local Agent 鉴权**：agentToken
- **Agent 不走普通用户登录**

### 说明

- 用户是人，Agent 是设备。
- 两者鉴权模型必须分开。
- agentToken 可由云端撤销和重新生成。
- Agent 检测到 token 失效后，应停止领取任务并进入等待重新绑定状态。

---

## DECISION-003：Agent 项目位置

### 结论

第一版 Agent 放在 DaoPaiV3 仓库内独立子包，不一开始拆成独立仓库。

### 推荐结构

```text
DaoPaiV3/
  └─ packages/
      ├─ cloud/         云端平台
      ├─ agent/         本地执行端
      └─ shared/        共享类型、任务状态、API 协议
```

### 说明

- 早期 Cloud 和 Agent 需要共享协议。
- 一个仓库更容易统一类型和状态枚举。
- 后续稳定后，再评估拆独立仓库。

---

## DECISION-004：超级管理员后台

### 结论

第一版只做最小超级管理员后台，不做复杂后台系统。

### 第一版需要支持

- 创建租户
- 停用租户
- 设置到期时间
- 设置最大设备数
- 创建 workstation
- 生成 agentToken

### 说明

- 第一版不做支付。
- 第一版不做复杂权限系统。
- 先满足手动开通、停用、授权即可。

---

## DECISION-005：任务 payload 上限

### 结论

第一版限制任务 payload 大小，避免大任务拖慢数据库。

### 建议

- 单任务 payload 最大 **2MB**
- 单次导入单号数量先限制 **5000 条**以内

### 说明

- payload 只存任务参数，不存二进制文件。
- 后续如需更大批量，再设计"任务文件上传 + 对象存储"。

---

## DECISION-006：心跳和轮询频率

### 结论

第一版使用 HTTP 轮询，不依赖 WebSocket。

### 建议默认值

| 项 | 默认值 |
| -- | -- |
| Agent 心跳 | 15 秒一次 |
| 离线判定 | 60 秒无心跳 |
| 任务轮询 | 5 秒一次 |
| 任务执行中进度上报 | 2-5 秒一次 |

### 说明

- WebSocket 后续只作为实时通知增强（`task_available` 通知）。
- 任务可靠性依赖 PostgreSQL 状态机，而不是 WebSocket。
- WebSocket 断线后必须回退到轮询兜底。

---

## DECISION-007：workstation 重复运行检测

### 结论

第一版做软检测，不强制踢下线。

### 记录字段建议

- `workstationId`
- `agentInstanceId`
- `lastHeartbeatAt`
- `lastIp`

### 处理策略

- 同一 `workstationId` 出现多个 `agentInstanceId` 时，云端标记警告。
- 第一版不强制踢下线，避免误伤现场使用。
- 后续根据实际情况再加强限制。

---

## DECISION-008：任务超时和回收策略

### 结论

第一版任务回收策略必须保守，避免重复执行真实业务任务。

### 建议

| 任务状态 | 超时阈值 | 处理策略 |
| -- | -- | -- |
| `pending` | 长期保留 | 不自动回收 |
| `assigned` | 超过 5 分钟未变 `running` | 可回收为 `pending` |
| `running` | 超过 2 小时无心跳 | 标记 `timeout`，等待人工处理 |

### 关键原则

- **不自动重跑真实任务**。
- 快递业务自动化最怕重复执行，因此失败任务优先人工确认。

---

## DECISION-009：截图存储策略

### 结论

第一版不接对象存储，生产默认关闭截图。

### 策略

- `ENABLE_SCREENSHOT=false`
- 调试时本地临时保存
- 云端不存截图文件
- 云端数据库不存图片二进制
- 后续如确实需要远程排查，再接 Cloudflare R2 / S3 / OSS

### 说明

轻量云服务器不适合存大量截图文件。

---

## DECISION-010：生产域名和 HTTPS

### 结论

Phase 9 再正式确定生产域名，但现在先按以下路径设计：

| 用途 | 路径 |
| -- | -- |
| Cloud Web | `https://daopai.yourdomain.com` |
| API | `/api` |
| Agent API | `/agent` |

### 部署方式

- Nginx 反向代理
- HTTPS 证书（Let's Encrypt + certbot 自动续期）
- PostgreSQL 不对公网暴露
- Redis 不对公网暴露
- 第一版单台轻量云服务器 Docker 部署，**不使用 Kubernetes**

---

## 当前不做事项

V3 第一版明确不做以下事项：

- 不做支付系统
- 不做复杂 RBAC
- 不做 Kubernetes
- 不做微服务拆分
- 不做纯 WebSocket 任务系统
- 不让云端直接连接本地浏览器
- 不把截图存进云服务器 Docker
- 不破坏 V2 稳定执行链路
- 不在 Phase 1-C 写任何代码

---

## 与现有文档关系

本文档与以下文档配合使用，构成 V3 Phase 1 架构基线：

| 文档 | 用途 |
| -- | -- |
| [V3_ARCHITECTURE.md](./V3_ARCHITECTURE.md) | 总体架构设计（Cloud + Agent 双层形态） |
| [V3_DATA_MODEL.md](./V3_DATA_MODEL.md) | 数据模型与隔离设计（tenant/site/workstation 三元组） |
| [V3_AGENT_DESIGN.md](./V3_AGENT_DESIGN.md) | Local Agent 设计（启动 / 鉴权 / 心跳 / 执行） |
| [V3_CLOUD_PLATFORM.md](./V3_CLOUD_PLATFORM.md) | Cloud Platform 设计（租户 / 设备 / 任务中心） |
| [V3_ROADMAP.md](./V3_ROADMAP.md) | 开发路线图（Phase 1 ~ Phase 9） |
| [V3_PHASE0_KNOWN_ISSUES.md](./V3_PHASE0_KNOWN_ISSUES.md) | Phase 0 已知问题与处理意见 |

### 一致性要求

Phase 2 开发前，应确认上述文档都已存在且内容一致：

- 本文档的决策与 5 份架构文档无矛盾。
- 如发现矛盾，以本文档为准并同步修订架构文档，或在 PR 中说明例外。
- `V3_PHASE0_KNOWN_ISSUES.md` 中标记为"后续处理"的 ISSUE，进入对应 Phase 时需更新状态。

---

## 决策变更流程

本文档冻结后，如需变更决策：

1. 在 PR / 讨论中明确说明变更原因、影响范围、回滚方案。
2. 更新本文档对应 DECISION 编号，并标注变更日期。
3. 同步检查 5 份架构文档是否需要修订。
4. 重大变更（涉及数据隔离、鉴权、任务可靠性）必须由用户确认后方可合并。
