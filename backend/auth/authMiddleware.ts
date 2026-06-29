// Phase 3-A: 认证中间件占位
// 当前不做真实 JWT 验证，只注入匿名 principal。
// 未来在此解析 Authorization header → JWT claim → UserPrincipal。
// 不影响 requestContext（tenantId / workstationId 仍由 requestContext 中间件默认注入）。

import type { Request, Response, NextFunction } from 'express';
import type { Principal, AnonymousPrincipal } from './types';

/**
 * 认证中间件
 *
 * 当前行为（占位）：
 *   - 无 Authorization header → principal = { type: 'anonymous' }
 *   - 业务继续由 requestContext 注入默认 tenant/workstation
 *
 * 未来扩展：
 *   - 解析 Authorization: Bearer <jwt> → UserPrincipal
 *   - 解析 X-Agent-Token: <token> → AgentPrincipal
 *   - 更新 req.tenantId / req.workstationId 为认证结果
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const principal: Principal = { type: 'anonymous' as const };
  req.principal = principal;
  next();
}