// Phase 3-B-1: password hash 单元测试
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../password';

describe('hashPassword / verifyPassword', () => {
  it('hashPassword 生成 v1 格式 hash', async () => {
    const hash = await hashPassword('test123');
    expect(hash).toMatch(/^v1\$.+\$.+$/);
  });

  it('verifyPassword 正确密码返回 true', async () => {
    const hash = await hashPassword('mypassword');
    const result = await verifyPassword('mypassword', hash);
    expect(result).toBe(true);
  });

  it('verifyPassword 错误密码返回 false', async () => {
    const hash = await hashPassword('mypassword');
    const result = await verifyPassword('wrongpassword', hash);
    expect(result).toBe(false);
  });

  it('verifyPassword 空密码返回 false', async () => {
    const hash = await hashPassword('mypassword');
    const result = await verifyPassword('', hash);
    expect(result).toBe(false);
  });

  it('verifyPassword 格式错误 hash 返回 false', async () => {
    const result = await verifyPassword('test', 'badformat');
    expect(result).toBe(false);
  });

  it('verifyPassword 版本不匹配返回 false', async () => {
    const result = await verifyPassword('test', 'v2$somesalt$somehash');
    expect(result).toBe(false);
  });

  it('每次 hash 生成不同结果（独立 salt）', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });
});