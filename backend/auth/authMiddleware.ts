// Phase 3-B: 认证中间件
// 解析 Bearer JWT → UserPrincipal，无 Token → anonymous
// JWT 无效 → 返回 401（不静默当 anonymous）

import type { Request, Response, NextFunction } from 'express';
import type { Principal } from './types';
import { verifyAccessToken } from './jwt';

/**
 * 认证中间件
 *
 * 行为：
 *   - 无 Authorization header → principal = { type: 'anonymous' }
 *   - Bearer JWT 有效 → principal = UserPrincipal { userId, tenantId, role }
 *   - Bearer JWT 无效/过期 → 返回 401
 *
 * 注意：业务 API 锚点检测是否强制登录由各路由自行决定。
 *       /api/auth/me 等必须要求 user principal。
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    req.principal = { type: 'anonymous' as const };
    return next();
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    // 格式错误 → 401
    res.status(401).json({ error: 'Authorization header 格式错误，应为 Bearer <token>' });
    return;
  }

  const token = parts[1];
  const payload = verifyAccessToken(token);

  if (!payload) {
    // JWT 无效或过期 → 401
    res.status(401).json({ error: 'Token 无效或已过期' });
    return;
  }

  req.principal = {
    type: 'user',
    userId: payload.sub,
    tenantId: payload.tenantId,
    role: payload.role,
  };

  next();
}