// Phase 3-A: Agent 鉴权边界占位
// 当前不做真实 agentToken 验证，只提供函数骨架。
// 未来 /agent/* 路由使用 agentToken 鉴权，不走用户 JWT。

import type { Request, Response, NextFunction } from 'express';
import type { AgentPrincipal } from './types';

/**
 * 解析 Agent Token（未来实现）
 *
 * 从请求头 X-Agent-Token 或 Authorization 中提取 agentToken，
 * 验证后返回 AgentPrincipal。
 *
 * @param req Express 请求对象
 * @returns AgentPrincipal 或 null（解析失败）
 */
export function parseAgentToken(_req: Request): AgentPrincipal | null {
  // TODO Phase 3-B: 实现真实 agentToken 解析
  // 1. 从 X-Agent-Token header 提取 token
  // 2. 验证 token 签名（HMAC / RSA）
  // 3. 从 token payload 提取 tenantId / workstationId
  // 4. 返回 AgentPrincipal
  return null;
}

/**
 * requireAgent 中间件（未来实现）
 *
 * 要求当前请求携带有效 Agent Token，否则返回 401。
 * 用于 /agent/* 路由保护。
 *
 * @param req Express 请求对象
 * @param res Express 响应对象
 * @param next 下一个中间件
 */
export function requireAgent(_req: Request, res: Response, next: NextFunction): void {
  // TODO Phase 3-B: 实现真实 Agent 鉴权
  // const principal = parseAgentToken(req);
  // if (!principal) return res.status(401).json({ error: 'Agent 鉴权失败' });
  // req.principal = principal;
  // req.tenantId = principal.tenantId;
  // req.workstationId = principal.workstationId;
  next();
}