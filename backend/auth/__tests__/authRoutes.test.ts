// Phase 3-B-1: Auth Routes 集成测试
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { authRouter } from '../authRoutes';
import { PgDatabase } from '../../db/PgDatabase';
import { hashPassword } from '../password';
import { signAccessToken, generateRefreshToken, hashRefreshToken, refreshTokenExpiresAt } from '../jwt';

// ── 辅助：创建 mock req/res ──

function createMockReqRes(body: any = {}, principal?: any, headers: Record<string, string> = {}) {
  const req = {
    body,
    principal,
    headers,
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  return { req, res };
}

// ── 辅助：调用路由 handler ──
// 通过 router.stack 找到匹配路由并手动调用 handler
async function callRoute(method: string, path: string, req: Request, res: Response): Promise<void> {
  for (const layer of (authRouter as any).stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      await layer.route.stack[0].handle(req, res);
      return;
    }
  }
  throw new Error(`Route not found: ${method} ${path}`);
}

describe('Auth Routes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
    vi.restoreAllMocks();
  });

  // ── POST /api/auth/login ──

  it('POST /api/auth/login 错误密码返回 401', async () => {
    // 准备 mock 用户
    const passwordHash = await hashPassword('correct-password');
    vi.spyOn(PgDatabase.prototype, 'getUserByUsername').mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-default',
      username: 'admin',
      passwordHash,
      role: 'super_admin',
      status: 'active',
    });

    const { req, res } = createMockReqRes({
      username: 'admin',
      password: 'wrong-password',
    });

    await callRoute('post', '/api/auth/login', req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: '用户名或密码错误' });
  });

  it('POST /api/auth/login 缺少 username 返回 400', async () => {
    const { req, res } = createMockReqRes({ password: 'test' });
    await callRoute('post', '/api/auth/login', req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: '用户名和密码不能为空' });
  });

  it('POST /api/auth/login 用户不存在返回 401', async () => {
    vi.spyOn(PgDatabase.prototype, 'getUserByUsername').mockResolvedValue(null);

    const { req, res } = createMockReqRes({
      username: 'nonexistent',
      password: 'test',
    });

    await callRoute('post', '/api/auth/login', req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: '用户名或密码错误' });
  });

  it('POST /api/auth/login 用户被禁用返回 403', async () => {
    vi.spyOn(PgDatabase.prototype, 'getUserByUsername').mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-default',
      username: 'disabled-user',
      passwordHash: 'hash',
      role: 'operator',
      status: 'disabled',
    });

    const { req, res } = createMockReqRes({
      username: 'disabled-user',
      password: 'test',
    });

    await callRoute('post', '/api/auth/login', req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: '账号已被禁用' });
  });

  // ── GET /api/auth/me ──

  it('GET /api/auth/me 无 token（无 principal）返回 401', async () => {
    const { req, res } = createMockReqRes({}, undefined);
    await callRoute('get', '/api/auth/me', req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: '请先登录' });
  });

  it('GET /api/auth/me anonymous principal 返回 401', async () => {
    const { req, res } = createMockReqRes({}, { type: 'anonymous' });
    await callRoute('get', '/api/auth/me', req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: '请先登录' });
  });

  it('GET /api/auth/me 有效 user principal 返回用户信息', async () => {
    const { req, res } = createMockReqRes({}, {
      type: 'user',
      userId: 'user-1',
      tenantId: 'tenant-custom',
      role: 'operator',
    });

    await callRoute('get', '/api/auth/me', req, res);

    expect(res.json).toHaveBeenCalledWith({
      id: 'user-1',
      tenantId: 'tenant-custom',
      role: 'operator',
      username: '',
    });
  });

  // ── POST /api/auth/refresh ──

  it('POST /api/auth/refresh 缺少 refreshToken 返回 400', async () => {
    const { req, res } = createMockReqRes({});
    await callRoute('post', '/api/auth/refresh', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'refreshToken 不能为空' });
  });

  it('POST /api/auth/refresh 已撤销 token 返回 401', async () => {
    vi.spyOn(PgDatabase.prototype, 'findRefreshToken').mockResolvedValue(null);

    const { req, res } = createMockReqRes({
      refreshToken: 'revoked-token',
    });

    await callRoute('post', '/api/auth/refresh', req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Refresh Token 无效或已过期' });
  });

  // ── POST /api/auth/logout ──

  it('POST /api/auth/logout 正常撤销返回 success', async () => {
    vi.spyOn(PgDatabase.prototype, 'revokeRefreshToken').mockResolvedValue(undefined);

    const { req, res } = createMockReqRes({
      refreshToken: 'some-token',
    });

    await callRoute('post', '/api/auth/logout', req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('POST /api/auth/logout 无 refreshToken 也返回 success', async () => {
    const { req, res } = createMockReqRes({});

    await callRoute('post', '/api/auth/logout', req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});