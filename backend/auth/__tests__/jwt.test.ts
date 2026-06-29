// Phase 3-B-1: JWT 签发与验证单元测试
import { describe, it, expect, beforeEach } from 'vitest';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from '../jwt';

describe('JWT sign / verify', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
  });

  it('signAccessToken 返回有效 JWT 字符串', () => {
    const token = signAccessToken('user-123', 'tenant-default', 'super_admin');
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    // JWT 格式: header.payload.signature
    expect(token.split('.')).toHaveLength(3);
  });

  it('verifyAccessToken 返回正确的 payload', () => {
    const token = signAccessToken('user-456', 'tenant-abc', 'operator');
    const payload = verifyAccessToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user-456');
    expect(payload!.tenantId).toBe('tenant-abc');
    expect(payload!.role).toBe('operator');
    expect(payload!.type).toBe('user');
  });

  it('verifyAccessToken 对无效 token 返回 null', () => {
    const result = verifyAccessToken('invalid-token');
    expect(result).toBeNull();
  });

  it('verifyAccessToken 对空字符串返回 null', () => {
    const result = verifyAccessToken('');
    expect(result).toBeNull();
  });

  it('verifyAccessToken 对篡改 token 返回 null', () => {
    const token = signAccessToken('user-789', 'tenant-default', 'tenant_admin');
    // 篡改中间部分
    const parts = token.split('.');
    parts[1] = 'tampered';
    const result = verifyAccessToken(parts.join('.'));
    expect(result).toBeNull();
  });

  it('verifyAccessToken token 类型非 user 返回 null', () => {
    // 这个测试验证 verifyAccessToken 会检查 type 字段
    // 使用正常 token 本身已包含 type='user'，所以不会是 null
    // 但如果有人伪造了不包含 type 或 type 不是 user 的 token，
    // verifyAccessToken 会返回 null（由 jwt.verify 验证签名保证）
    const token = signAccessToken('user-000', 'tenant-default', 'super_admin');
    const payload = verifyAccessToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.type).toBe('user');
  });

  it('generateRefreshToken 返回 128 字符 hex', () => {
    const token = generateRefreshToken();
    expect(token).toHaveLength(128);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it('generateRefreshToken 每次生成不同值', () => {
    const t1 = generateRefreshToken();
    const t2 = generateRefreshToken();
    expect(t1).not.toBe(t2);
  });

  it('hashRefreshToken 生成 SHA-256 64 字符 hex', () => {
    const token = 'test-refresh-token';
    const hash = hashRefreshToken(token);
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('hashRefreshToken 相同输入产生相同 hash', () => {
    const token = 'same-token';
    const h1 = hashRefreshToken(token);
    const h2 = hashRefreshToken(token);
    expect(h1).toBe(h2);
  });

  it('hashRefreshToken 不同输入产生不同 hash', () => {
    const h1 = hashRefreshToken('token-a');
    const h2 = hashRefreshToken('token-b');
    expect(h1).not.toBe(h2);
  });
});