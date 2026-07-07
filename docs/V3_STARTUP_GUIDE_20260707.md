# DaoPai V3 启动说明

## 必须同时启动的进程

DaoPai V3 当前必须同时启动三个进程：

1. **backend** — Express 服务端，端口 3300
2. **frontend** — Vite 开发前端，端口 5176
3. **Local Agent** — 本地执行端，拉取并执行浏览器自动化任务

**如果 Local Agent 未启动，前端可以创建任务，但任务会停在 `pending` 状态，不会执行。**

## 推荐启动方式（一键启动）

双击根目录下的批处理脚本：

```
start-daopai-v3-dev.bat
```

三个窗口将依次打开，分别运行 backend、frontend、agent。

## 分别手动启动

```bash
# 终端 1: backend
cd E:\网站开发\DaoPaiV3
npm run dev
```

```bash
# 终端 2: frontend
cd E:\网站开发\DaoPaiV3\frontend
npm run dev
```

```bash
# 终端 3: agent
cd E:\网站开发\DaoPaiV3\packages\agent
npm run dev
```

## 端口

| 服务 | 端口 |
|------|------|
| backend | 3300 |
| frontend | 5176 |
| PostgreSQL | 5436 |
| Redis | 6381 |

## 验证

启动后逐项检查：

1. 访问 `http://localhost:3300/api/status` — 返回 `alive: true, runtime: available`
2. 访问 `http://localhost:5176` — 前端页面正常加载
3. Agent 控制台输出 `心跳循环已启动` 和 `授权码验证成功`
4. 在 Agent 启动后，前端提交任务可以看到任务从 `pending` → `running` → `done`

## 常见问题

**Q: 任务创建后一直停在 pending？**
A: 确认 Local Agent 是否已启动。Agent 未启动时，任务创建成功但无人拉取执行。

**Q: Agent 启动报授权码验证失败？**
A: 检查 `packages/agent/agent.json` 中的 `agentToken` 是否与数据库中注册的 workstation token 一致。

**Q: 前端页面空白或加载失败？**
A: 确认 backend 已启动（端口 3300），frontend 已启动（端口 5176），且浏览器未缓存旧版本。
