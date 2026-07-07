# V4 禁止启动说明

当前 V4 尚未完成与 V3 的运行时隔离。

在完成以下事项前，禁止启动 V4：

- 独立 backend 端口
- 独立 frontend 端口
- 独立 PostgreSQL 容器
- 独立 PostgreSQL 端口
- 独立 Redis 容器
- 独立 Redis 端口
- 独立 Docker volume
- 独立 Docker network
- 独立 .env
- 独立 docker-compose
- 独立 Git 仓库或独立 remote
- 禁止连接 daopai_v3
- 禁止使用 daopai-v3-postgres
- 禁止使用 daopai_v3_pgdata

当前 V4 如果启动，可能再次影响 V3。
