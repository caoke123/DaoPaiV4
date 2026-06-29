// Phase 2-E: Express Request 类型扩展 — 请求上下文注入
// 由 requestContext 中间件在业务路由之前注入，后续 JWT / Agent 鉴权替换此处默认值

import type { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      /** 租户 ID（当前默认 tenant-default，后续从 JWT claim 解析） */
      tenantId: string;
      /** 工作站 ID（当前默认 ws-local-default，后续从 Agent Token 解析） */
      workstationId: string;
      /** 请求追踪 ID，用于日志关联 */
      requestId?: string;
    }
  }
}

export {};