// Phase 2-E: 请求上下文中间件
// 为每个 API 请求注入 tenantId / workstationId / requestId
// 当前默认值来自 Phase 2-B / 2-D 常量，后续从 JWT / Agent Token 解析

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TENANT_ID, DEFAULT_WORKSTATION_ID } from '../../db/PgDatabase';

/**
 * 请求上下文中间件
 *
 * 在业务路由之前挂载，为每个请求注入：
 *   - req.tenantId:      租户标识（默认 tenant-default）
 *   - req.workstationId: 工作站标识（默认 ws-local-default）
 *   - req.requestId:     请求追踪 ID（UUID，便于日志关联）
 *
 * 未来扩展点：
 *   - 从 Authorization header 解析 JWT → tenantId
 *   - 从 X-Agent-Token header 解析 Agent Token → workstationId
 */
export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  req.tenantId = DEFAULT_TENANT_ID;
  req.workstationId = DEFAULT_WORKSTATION_ID;
  req.requestId = randomUUID();
  next();
}

/**
 * 安全获取 tenantId — 缺失时 throw（不应发生，中间件已默认注入）
 */
export function getTenantId(req: Request): string {
  if (!req.tenantId) {
    throw new Error('[requestContext] tenantId 缺失，请检查中间件挂载顺序');
  }
  return req.tenantId;
}

/**
 * 安全获取 workstationId — 缺失时 throw（不应发生，中间件已默认注入）
 */
export function getWorkstationId(req: Request): string {
  if (!req.workstationId) {
    throw new Error('[requestContext] workstationId 缺失，请检查中间件挂载顺序');
  }
  return req.workstationId;
}