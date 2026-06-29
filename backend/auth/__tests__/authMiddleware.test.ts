// Phase 3-B-1: authMiddleware 单元测试
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { authMiddleware } from '../authMiddleware';
import { signAccessToken } from '../jwt';

function createMockReqRes(headers: Record<string, string> = {}) {
  const req = {
    headers,
    principal: undefined as any,
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn();

  return { req, res, next };
}

describe('authMiddleware', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
  });

  it('无 Authorization header → 注入 anonymous principal', () => {
    const { req, res, next } = createMockReqRes({});
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.principal).toEqual({ type: 'anonymous' });
  });

  it('Bearer JWT 有效 → 注入 UserPrincipal', () => {
    const token = signAccessToken('user-abc', 'tenant-xyz', 'operator');
    const { req, res, next } = createMockReqRes({
      authorization: `Bearer ${token}`,
    });
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.principal).toEqual({
      type: 'user',
      userId: 'user-abc',
      tenantId: 'tenant-xyz',
      role: 'operator',
    });
  });

  it('Bearer JWT 无效 → 返回 401', () => {
    const { req, res, next } = createMockReqRes({
      authorization: 'Bearer invalid-token-here',
    });
    authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token 无效或已过期' });
  });

  it('Authorization header 格式错误（非 Bearer）→ 返回 401', () => {
    const { req, res, next } = createMockReqRes({
      authorization: 'Basic YWRtaW46cGFzcw==',
    });
    authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authorization header 格式错误，应为 Bearer <token>' });
  });

  it('Authorization header 格式错误（Bearer 但无 token）→ 返回 401', () => {
    const { req, res, next } = createMockReqRes({
      authorization: 'Bearer',
    });
    authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('Authorization header 为空字符串 → 注入 anonymous', () => {
    // 空字符串是 falsy，不会进入 Bearer 解析分支
    const req = {
      headers: { authorization: '' },
      principal: undefined as any,
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.principal).toEqual({ type: 'anonymous' });
  });
});