// Phase 3-B: JWT 签发与验证
// 使用 jsonwebtoken 库，Access Token 15 分钟，Refresh Token 7 天

import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import type { UserRole } from './types';

/** 从环境变量读取 JWT Secret */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('[JWT] JWT_SECRET 环境变量未设置，请检查 .env 文件');
  }
  return secret;
}

/** Access Token payload */
export interface AccessTokenPayload {
  sub: string;       // userId
  tenantId: string;
  role: UserRole;
  type: 'user';
}

/** Access Token 有效期：15 分钟 */
export const ACCESS_TOKEN_TTL = 15 * 60; // 秒

/** Refresh Token 有效期：7 天 */
export const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 毫秒

/**
 * 签发 Access Token
 */
export function signAccessToken(userId: string, tenantId: string, role: UserRole): string {
  const payload: AccessTokenPayload = {
    sub: userId,
    tenantId,
    role,
    type: 'user',
  };
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

/**
 * 验证 Access Token，返回 payload
 * @returns 解析后的 payload，或 null（无效/过期）
 */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as AccessTokenPayload;
    if (payload.type !== 'user') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 生成 Refresh Token（明文，128 位随机）
 */
export function generateRefreshToken(): string {
  return randomBytes(64).toString('hex');
}

/**
 * 计算 Refresh Token 的 hash（SHA-256，存入数据库）
 * 使用 Node.js 内置 crypto
 */
export function hashRefreshToken(token: string): string {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 计算 Refresh Token 过期时间
 */
export function refreshTokenExpiresAt(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL);
}