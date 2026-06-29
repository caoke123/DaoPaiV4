// Phase 3-A: 用户认证边界占位
// 当前不做真实 JWT 验证，只提供函数骨架。
// 未来 /api/* 用户接口使用 JWT + Refresh Token 登录。

import type { Request, Response, NextFunction } from 'express';
import type { UserPrincipal, UserRole } from './types';

/**
 * 解析用户 JWT（未来实现）
 *
 * 从 Authorization: Bearer <jwt> 中提取并验证 JWT，
 * 返回 UserPrincipal。
 *
 * @param req Express 请求对象
 * @returns UserPrincipal 或 null（解析失败）
 */
export function parseUserJwt(_req: Request): UserPrincipal | null {
  // TODO Phase 3-B: 实现真实 JWT 解析
  // 1. 从 Authorization header 提取 Bearer token
  // 2. 验证 JWT 签名（RS256 / HS256）
  // 3. 检查 token 是否过期
  // 4. 从 JWT payload 提取 userId / tenantId / role
  // 5. 返回 UserPrincipal
  return null;
}

/**
 * requireUser 中间件（未来实现）
 *
 * 要求当前请求携带有效用户 JWT，否则返回 401。
 * 用于 /api/* 用户接口保护。
 *
 * @param req Express 请求对象
 * @param res Express 响应对象
 * @param next 下一个中间件
 */
export function requireUser(_req: Request, res: Response, next: NextFunction): void {
  // TODO Phase 3-B: 实现真实用户鉴权
  // const principal = parseUserJwt(req);
  // if (!principal) return res.status(401).json({ error: '请先登录' });
  // req.principal = principal;
  // req.tenantId = principal.tenantId;
  next();
}

/**
 * requireRole 中间件工厂（未来实现）
 *
 * 要求当前用户具备指定角色，否则返回 403。
 *
 * @param allowedRoles 允许的角色列表
 * @returns Express 中间件
 */
export function requireRole(_allowedRoles: UserRole[]): (req: Request, res: Response, next: NextFunction) => void {
  return (_req: Request, res: Response, next: NextFunction) => {
    // TODO Phase 3-B: 实现角色检查
    // const principal = req.principal;
    // if (!principal || principal.type !== 'user') return res.status(401).json({ error: '请先登录' });
    // if (!allowedRoles.includes(principal.role)) return res.status(403).json({ error: '权限不足' });
    next();
  };
}