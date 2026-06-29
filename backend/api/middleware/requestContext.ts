// Phase 2-E: 请求上下文中间件
// 为每个 API 请求注入 tenantId / workstationId / requestId
// 当前默认值来自 Phase 2-B / 2-D 常量
//
// Phase 3-B: 如果 req.principal.type === 'user'，则从 principal.tenantId 注入真实 tenantId

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TENANT_ID, DEFAULT_WORKSTATION_ID } from '../../db/PgDatabase';

/**
 * 请求上下文中间件
 *
 * 注入逻辑：
 *   - req.tenantId:      user principal → principal.tenantId；anonymous → DEFAULT_TENANT_ID
 *   - req.workstationId: 当前固定 DEFAULT_WORKSTATION_ID（后续从 Agent principal 注入）
 *   - req.requestId:     UUID 追踪
 */
export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  // Phase 3-B: 从 UserPrincipal 获取真实 tenantId
  if (req.principal && req.principal.type === 'user') {
    req.tenantId = req.principal.tenantId;
  } else {
    req.tenantId = DEFAULT_TENANT_ID;
  }

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