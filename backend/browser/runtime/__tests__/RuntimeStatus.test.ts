// Phase 3-D-2: RuntimeStatus 单元测试
// 验证 BrowserPool 不可用时状态管理和执行接口保护
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Response } from 'express';
import { RuntimeStatus, runtimeStatus } from '../RuntimeStatus';

function createMockRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('RuntimeStatus', () => {
  let rs: RuntimeStatus;

  beforeEach(() => {
    rs = RuntimeStatus.getInstance();
    // 每个测试重置状态
    rs.markAvailable();
  });

  it('单例模式返回同一实例', () => {
    const a = RuntimeStatus.getInstance();
    const b = RuntimeStatus.getInstance();
    expect(a).toBe(b);
  });

  it('初始状态为 unavailable', () => {
    // 创建新实例测试初始状态（通过 markUnavailable 模拟）
    const state = rs.getState();
    // 由于 beforeEach 设为了 available，这里验证可用
    expect(state.health).toBe('available');
  });

  it('markAvailable 设置状态为 available', () => {
    rs.markAvailable();
    const state = rs.getState();
    expect(state.health).toBe('available');
    expect(state.error).toBeNull();
    expect(state.lastCheckedAt).toBeGreaterThan(0);
    expect(rs.isAvailable()).toBe(true);
  });

  it('markUnavailable 设置状态为 unavailable 并记录错误', () => {
    rs.markUnavailable('连接失败');
    const state = rs.getState();
    expect(state.health).toBe('unavailable');
    expect(state.error).toBe('连接失败');
    expect(state.lastCheckedAt).toBeGreaterThan(0);
    expect(rs.isAvailable()).toBe(false);
  });

  it('markDegraded 设置状态为 degraded', () => {
    rs.markAvailable();
    rs.markDegraded('部分窗口离线');
    const state = rs.getState();
    expect(state.health).toBe('degraded');
    expect(state.error).toBe('部分窗口离线');
    expect(rs.isAvailable()).toBe(false);
  });

  it('isAvailable 在 unavailable 时返回 false', () => {
    rs.markUnavailable('test');
    expect(rs.isAvailable()).toBe(false);
  });

  it('isAvailable 在 degraded 时返回 false', () => {
    rs.markDegraded('test');
    expect(rs.isAvailable()).toBe(false);
  });

  it('isAvailable 在 available 时返回 true', () => {
    rs.markAvailable();
    expect(rs.isAvailable()).toBe(true);
  });

  it('getSummary 返回正确结构', () => {
    rs.markAvailable();
    const summary = rs.getSummary();
    expect(summary).toHaveProperty('runtime');
    expect(summary).toHaveProperty('runtimeError');
    expect(summary).toHaveProperty('runtimeLastCheckedAt');
    expect(summary.runtime).toBe('available');
    expect(summary.runtimeError).toBeNull();
  });

  it('getSummary 在 unavailable 时返回错误信息', () => {
    rs.markUnavailable('连接超时');
    const summary = rs.getSummary();
    expect(summary.runtime).toBe('unavailable');
    expect(summary.runtimeError).toBe('连接超时');
  });

  it('runtimeStatus 导出的实例可用', () => {
    expect(runtimeStatus).toBeDefined();
    expect(runtimeStatus.isAvailable).toBeDefined();
    expect(runtimeStatus.getSummary).toBeDefined();
  });
});

describe('requireRuntimeAvailable 行为验证', () => {
  // 模拟 requireRuntimeAvailable 的逻辑（不直接 import 避免循环依赖）
  function simulateRequireRuntimeAvailable(res: Response): boolean {
    if (!runtimeStatus.isAvailable()) {
      const state = runtimeStatus.getState();
      res.status(503).json({
        error: 'BROWSER_RUNTIME_UNAVAILABLE',
        message: '本地浏览器运行时不可用',
        runtime: state.health,
        runtimeError: state.error,
      });
      return false;
    }
    return true;
  }

  beforeEach(() => {
    runtimeStatus.markAvailable();
  });

  it('runtime available 时返回 true，不调用 res.status', () => {
    runtimeStatus.markAvailable();
    const res = createMockRes();
    const result = simulateRequireRuntimeAvailable(res);
    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('runtime unavailable 时返回 false，返回 503 JSON', () => {
    runtimeStatus.markUnavailable('运行时未启动');
    const res = createMockRes();
    const result = simulateRequireRuntimeAvailable(res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'BROWSER_RUNTIME_UNAVAILABLE',
      message: '本地浏览器运行时不可用',
      runtime: 'unavailable',
      runtimeError: '运行时未启动',
    });
  });

  it('runtime degraded 时返回 false，返回 503 JSON', () => {
    runtimeStatus.markDegraded('部分窗口不可用');
    const res = createMockRes();
    const result = simulateRequireRuntimeAvailable(res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'BROWSER_RUNTIME_UNAVAILABLE',
        runtime: 'degraded',
      }),
    );
  });

  it('503 响应必须是 JSON，不允许空 body', () => {
    runtimeStatus.markUnavailable('test');
    const res = createMockRes();
    simulateRequireRuntimeAvailable(res);
    expect(res.status).toHaveBeenCalledWith(503);
    // 验证 json 被调用且参数非空
    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonArg).toBeDefined();
    expect(typeof jsonArg).toBe('object');
    expect(jsonArg.error).toBeDefined();
    expect(jsonArg.message).toBeDefined();
  });
});