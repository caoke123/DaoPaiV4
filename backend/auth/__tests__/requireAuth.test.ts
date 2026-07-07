// Phase 3-C: requireAuth 认证保护开关 单元测试
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireUserIfAuthRequired, requireUser } from '../requireAuth';
import { authMiddleware } from '../authMiddleware';
import { requestContext } from '../../api/middleware/requestContext';
import { signAccessToken } from '../jwt';

function createMockReqRes(principal?: any, path: string = '/api/operations') {
  const req = {
    headers: {} as Record<string, string>,
    path,
    principal,
    tenantId: undefined as any,
    workstationId: undefined as any,
    requestId: undefined as any,
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn();

  return { req, res, next };
}

describe('requireUserIfAuthRequired', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
    process.env.AUTH_REQUIRED = 'false';
  });

  it('AUTH_REQUIRED=false 时 anonymous 可通过', () => {
    const { req, res, next } = createMockReqRes({ type: 'anonymous' });
    requireUserIfAuthRequired(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('AUTH_REQUIRED=false 时无 principal 可通过', () => {
    const { req, res, next } = createMockReqRes(undefined);
    requireUserIfAuthRequired(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('AUTH_REQUIRED=true 时 anonymous 返回 401', () => {
    process.env.AUTH_REQUIRED = 'true';
    const { req, res, next } = createMockReqRes({ type: 'anonymous' });
    requireUserIfAuthRequired(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: '请先登录' });
  });

  it('AUTH_REQUIRED=true 时无 principal 返回 401', () => {
    process.env.AUTH_REQUIRED = 'true';
    const { req, res, next } = createMockReqRes(undefined);
    requireUserIfAuthRequired(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('AUTH_REQUIRED=true 时有效 UserPrincipal 可通过', () => {
    process.env.AUTH_REQUIRED = 'true';
    const { req, res, next } = createMockReqRes({
      type: 'user',
      userId: 'user-1',
      tenantId: 'tenant-custom',
      role: 'operator',
    });
    requireUserIfAuthRequired(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  // ── 白名单路径 ──

  it('AUTH_REQUIRED=true 时 /api/status 无论 principal 都可通过', () => {
    process.env.AUTH_REQUIRED = 'true';
    const { req, res, next } = createMockReqRes(undefined, '/api/status');
    requireUserIfAuthRequired(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('AUTH_REQUIRED=true 时 /api/runtime/mode 无论 principal 都可通过', () => {
    process.env.AUTH_REQUIRED = 'true';
    const { req, res, next } = createMockReqRes({ type: 'anonymous' }, '/api/runtime/mode');
    requireUserIfAuthRequired(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('AUTH_REQUIRED=true 时 /api/runtime-mode 无论 principal 都可通过', () => {
    process.env.AUTH_REQUIRED = 'true';
    const { req, res, next } = createMockReqRes({ type: 'anonymous' }, '/api/runtime-mode');
    requireUserIfAuthRequired(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireUser', () => {
  it('anonymous 返回 401', () => {
    const { req, res, next } = createMockReqRes({ type: 'anonymous' });
    requireUser(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('无 principal 返回 401', () => {
    const { req, res, next } = createMockReqRes(undefined);
    requireUser(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('有效 UserPrincipal 可通过', () => {
    const { req, res, next } = createMockReqRes({
      type: 'user',
      userId: 'user-1',
      tenantId: 'tenant-custom',
      role: 'operator',
    });
    requireUser(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('AUTH_REQUIRED=false 时 anonymous 仍被拒绝', () => {
    process.env.AUTH_REQUIRED = 'false';
    const { req, res, next } = createMockReqRes({ type: 'anonymous' });
    requireUser(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ── 完整中间件链测试：authMiddleware → requestContext → requireUserIfAuthRequired ──

describe('中间件链: authMiddleware → requestContext → requireUserIfAuthRequired', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
  });

  function runChain(req: Request, res: Response, next: ReturnType<typeof vi.fn>) {
    authMiddleware(req, res, () => {
      requestContext(req, res, () => {
        requireUserIfAuthRequired(req, res, () => {
          next();
        });
      });
    });
  }

  it('AUTH_REQUIRED=false + 无 token → anonymous + tenantId=tenant-default', () => {
    process.env.AUTH_REQUIRED = 'false';
    const { req, res, next } = createMockReqRes(undefined);
    runChain(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.principal).toEqual({ type: 'anonymous' });
    expect(req.tenantId).toBe('tenant-default');
    expect(req.workstationId).toBe('ws-local-default');
  });

  it('AUTH_REQUIRED=true + 无 token → 401', () => {
    process.env.AUTH_REQUIRED = 'true';
    const { req, res, next } = createMockReqRes(undefined);
    runChain(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('AUTH_REQUIRED=true + 有效 JWT → tenantId 来自 JWT', () => {
    process.env.AUTH_REQUIRED = 'true';
    const token = signAccessToken('user-abc', 'tenant-custom', 'operator');
    const { req, res, next } = createMockReqRes(undefined);
    req.headers.authorization = `Bearer ${token}`;
    runChain(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.principal).toEqual({
      type: 'user',
      userId: 'user-abc',
      tenantId: 'tenant-custom',
      role: 'operator',
    });
    expect(req.tenantId).toBe('tenant-custom');
    expect(req.workstationId).toBe('ws-local-default');
  });

  it('AUTH_REQUIRED=true + 无效 JWT → 401', () => {
    process.env.AUTH_REQUIRED = 'true';
    const { req, res, next } = createMockReqRes(undefined);
    req.headers.authorization = 'Bearer invalid-token-here';
    runChain(req, res, next);

    expect(next).not.toHaveBeenCalled();
    // authMiddleware 会返回 401（在 requireUserIfAuthRequired 之前）
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ── 多租户隔离：tenant-other 数据不会被 tenant-default token 读出 ──

describe('多租户隔离', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
    process.env.AUTH_REQUIRED = 'true';
  });

  it('tenant-other 的 JWT 用户 tenantId 能正确注入 requestContext', () => {
    const token = signAccessToken('user-other', 'tenant-other', 'tenant_admin');
    const req = {
      headers: { authorization: `Bearer ${token}` },
      path: '/api/operations',
      principal: undefined as any,
      tenantId: undefined as any,
      workstationId: undefined as any,
      requestId: undefined as any,
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn();

    authMiddleware(req, res, () => {
      requestContext(req, res, () => {
        requireUserIfAuthRequired(req, res, () => {
          next();
        });
      });
    });

    expect(next).toHaveBeenCalled();
    expect(req.tenantId).toBe('tenant-other');
    expect((req.principal as any)!.tenantId).toBe('tenant-other');
  });
});