/**
 * Agent 鉴权中间件
 *
 * 用于 /agent/* 路由保护。
 * 从 Authorization: Bearer <token> 中提取执行电脑授权码，
 * 验证后注入 AgentPrincipal 到 req.principal。
 *
 * 鉴权规则：
 *   无 Authorization header → 401 AGENT_TOKEN_MISSING
 *   格式错误              → 401 AGENT_TOKEN_INVALID
 *   hash 不匹配           → 401 AGENT_TOKEN_INVALID
 *   token 已撤销          → 401 AGENT_TOKEN_REVOKED
 *   执行电脑已停用         → 403 WORKSTATION_DISABLED
 *   执行电脑已删除         → 403 WORKSTATION_DELETED
 */

import type { Request, Response, NextFunction } from 'express';
import type { AgentPrincipal } from './types';
import { verifyAgentToken } from './agentToken';
import { PgDatabase } from '../db/PgDatabase';

/** 鉴权结果 */
export type AgentAuthResult =
  | { ok: true; principal: AgentPrincipal }
  | {
      ok: false;
      status: 401 | 403;
      code:
        | 'AGENT_TOKEN_MISSING'
        | 'AGENT_TOKEN_INVALID'
        | 'AGENT_TOKEN_REVOKED'
        | 'WORKSTATION_DISABLED'
        | 'WORKSTATION_DELETED';
      message: string;
    };

/**
 * 解析 Agent Token
 *
 * 从请求头提取 token，验证后返回结构化的 AgentAuthResult。
 * 可用于非中间件场景（如预验证）。
 *
 * @param req Express 请求对象
 * @returns AgentAuthResult
 */
export async function parseAgentToken(req: Request): Promise<AgentAuthResult> {
  // 1. 提取 Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return { ok: false, status: 401, code: 'AGENT_TOKEN_MISSING', message: '缺少执行电脑授权码' };
  }

  // 2. 解析 Bearer token
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return { ok: false, status: 401, code: 'AGENT_TOKEN_INVALID', message: '执行电脑授权码格式错误' };
  }

  const plainToken = parts[1];
  if (!plainToken || plainToken.length < 20) {
    return { ok: false, status: 401, code: 'AGENT_TOKEN_INVALID', message: '执行电脑授权码格式错误' };
  }

  // 3. 查询数据库（通过 hash 匹配）
  const pg = PgDatabase.getInstance();
  const ws = await pg.getWorkstationByTokenHash(plainToken);

  if (!ws) {
    return { ok: false, status: 401, code: 'AGENT_TOKEN_INVALID', message: '执行电脑授权码无效' };
  }

  // 4. 检查是否已撤销
  if (ws.tokenRevokedAt) {
    return { ok: false, status: 401, code: 'AGENT_TOKEN_REVOKED', message: '执行电脑授权码已撤销' };
  }

  // 5. 检查执行电脑状态
  if (ws.status === 'deleted') {
    return { ok: false, status: 403, code: 'WORKSTATION_DELETED', message: '执行电脑已删除' };
  }

  if (ws.status === 'disabled') {
    return { ok: false, status: 403, code: 'WORKSTATION_DISABLED', message: '执行电脑已停用' };
  }

  return {
    ok: true,
    principal: {
      type: 'agent',
      tenantId: ws.tenantId,
      workstationId: ws.id,
      siteId: ws.siteId,
    },
  };
}

/**
 * requireAgent 中间件
 *
 * 要求当前请求携带有效的执行电脑授权码。
 * 验证成功后注入 req.principal = AgentPrincipal。
 * 用于 /agent/* 路由保护。
 *
 * @param req Express 请求对象
 * @param res Express 响应对象
 * @param next 下一个中间件
 */
export async function requireAgent(req: Request, res: Response, next: NextFunction): Promise<void> {
  const result = await parseAgentToken(req);

  if (!result.ok) {
    res.status(result.status).json({
      ok: false,
      code: result.code,
      message: result.message,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // 注入 principal
  req.principal = result.principal;
  req.tenantId = result.principal.tenantId;
  req.workstationId = result.principal.workstationId;
  next();
}