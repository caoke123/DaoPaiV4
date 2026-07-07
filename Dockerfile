FROM node:20-slim
# 安装 better-sqlite3 编译所需的构建工具和 Python
# 同时安装 Playwright 系统依赖（Chromium 运行所需）
RUN apt-get update && apt-get install -y \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
# --ignore-scripts=false 确保 better-sqlite3 在容器内编译
RUN npm install --ignore-scripts=false
COPY . .
RUN npm run build
# bnsy-operator-next: runtime 目录结构（profiles/screenshots/logs/downloads）
RUN mkdir -p data runtime/screenshots runtime/logs runtime/downloads runtime/profiles
EXPOSE 3400
CMD ["node", "dist/index.js"]
