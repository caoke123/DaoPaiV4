// Phase 3-B-1: requestContext 中间件单元测试
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requestContext, getTenantId, getWorkstationId } from '../requestContext';

function createMockReq(principal?: any) {
  return {
    principal,
    tenantId: undefined as any,
    workstationId: undefined as any,
    requestId: undefined as any,
  } as unknown as Request;
}

function createMockRes() {
  return {} as Response;
}

describe('requestContext', () => {
  it('UserPrincipal 时注入 principal.tenantId', () => {
    const req = createMockReq({
      type: 'user' as const,
      userId: 'user-1',
      tenantId: 'tenant-custom',
      role: 'super_admin' as const,
    });
    const res = createMockRes();
    const next = vi.fn();

    requestContext(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.tenantId).toBe('tenant-custom');
    expect(req.workstationId).toBe('ws-local-default');
    expect(req.requestId).toBeTruthy();
  });

  it('anonymous 时注入默认 tenantId', () => {
    const req = createMockReq({ type: 'anonymous' as const });
    const res = createMockRes();
    const next = vi.fn();

    requestContext(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.tenantId).toBe('tenant-default');
    expect(req.workstationId).toBe('ws-local-default');
  });

  it('无 principal 时注入默认 tenantId', () => {
    const req = createMockReq(undefined);
    const res = createMockRes();
    const next = vi.fn();

    requestContext(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.tenantId).toBe('tenant-default');
    expect(req.workstationId).toBe('ws-local-default');
  });

  it('getTenantId 返回已注入的 tenantId', () => {
    const req = createMockReq({ type: 'anonymous' as const });
    const res = createMockRes();
    const next = vi.fn();
    requestContext(req, res, next);

    const tenantId = getTenantId(req);
    expect(tenantId).toBe('tenant-default');
  });

  it('getTenantId 缺失时 throw', () => {
    const req = createMockReq(undefined);
    // 不调用 requestContext，直接调用 getTenantId
    expect(() => getTenantId(req)).toThrow('[requestContext] tenantId 缺失');
  });

  it('getWorkstationId 返回已注入的 workstationId', () => {
    const req = createMockReq({ type: 'anonymous' as const });
    const res = createMockRes();
    const next = vi.fn();
    requestContext(req, res, next);

    const wsId = getWorkstationId(req);
    expect(wsId).toBe('ws-local-default');
  });
});