// Phase 3-C: 业务 API 认证保护开关
//
// 提供两个中间件：
//   1. requireUserIfAuthRequired — 根据 AUTH_REQUIRED 环境变量决定是否强制登录
//   2. requireUser — 始终强制登录（用于 /api/auth/me 等必须认证的端点）
//
// AUTH_REQUIRED=false（默认）：兼容模式，无 token 仍可访问业务 API
// AUTH_REQUIRED=true：保护模式，业务 API 必须携带有效 Bearer JWT
//
// 不保护的路径（白名单）：
//   - /api/status（健康检查）
//   - /api/runtime/mode（运行时模式）
//   - /api/runtime-mode（运行时模式兼容）
//   - /api/auth/*（认证路由，由 authMiddleware 独立处理）
//
// 注意：authRouter 在中间件链中位于 requireUserIfAuthRequired 之前，
//       因此 /api/auth/* 自然不受影响。白名单主要覆盖 router 中的非业务路径。

import type { Request, Response, NextFunction } from 'express';

/** 始终不受 AUTH_REQUIRED 保护的路径前缀 */
const UNPROTECTED_PATHS = [
  '/api/status',
  '/api/runtime/mode',
  '/api/runtime-mode',
];

/**
 * 检查是否可跳过认证保护
 * - AUTH_REQUIRED=false：始终跳过
 * - 请求路径在白名单中：跳过
 */
function canSkipAuth(req: Request): boolean {
  // 兼容模式：不强制登录
  if (process.env.AUTH_REQUIRED !== 'true') {
    return true;
  }
  // 白名单路径
  return UNPROTECTED_PATHS.some(p => req.path.startsWith(p));
}

/**
 * 根据 AUTH_REQUIRED 环境变量决定是否强制登录
 *
 * AUTH_REQUIRED=false（默认）：
 *   - anonymous 可继续访问业务 API
 *   - 保持现有页面兼容
 *
 * AUTH_REQUIRED=true：
 *   - anonymous 访问受保护业务 API → 401
 *   - Bearer JWT 有效 → 放行
 *   - Bearer JWT 无效 → 401（由 authMiddleware 已处理）
 *   - 白名单路径不受影响
 */
export function requireUserIfAuthRequired(req: Request, res: Response, next: NextFunction): void {
  if (canSkipAuth(req)) {
    return next();
  }

  // 保护模式：必须 user principal
  if (!req.principal || req.principal.type !== 'user') {
    res.status(401).json({ error: '请先登录' });
    return;
  }

  next();
}

/**
 * 始终强制登录（不依赖 AUTH_REQUIRED）
 *
 * 用于 /api/auth/me 等必须认证的端点。
 * 无论 AUTH_REQUIRED 是否为 true，anonymous 均返回 401。
 */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.principal || req.principal.type !== 'user') {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  next();
}