// Phase 3-B: Auth API 路由
// login / me / refresh / logout

import { Router, type Request, type Response } from 'express';
import { PgDatabase } from '../db/PgDatabase';
import { verifyPassword } from '../auth/password';
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
} from '../auth/jwt';

export const authRouter = Router();

/**
 * POST /api/auth/login
 * 验证用户名密码，返回 accessToken + refreshToken + user
 */
authRouter.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    const pg = PgDatabase.getInstance();
    const tenantId = process.env.AUTH_DEFAULT_TENANT || 'tenant-default';

    const user = await pg.getUserByUsername(tenantId, username);
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ error: '账号已被禁用' });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 签发令牌
    const accessToken = signAccessToken(user.id, user.tenantId, user.role as any);
    const refreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(refreshToken);

    await pg.insertRefreshToken(user.id, user.tenantId, tokenHash, refreshTokenExpiresAt());

    return res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('[Auth] login error:', (err as Error).message);
    return res.status(500).json({ error: '登录失败' });
  }
});

/**
 * GET /api/auth/me
 * 返回当前登录用户信息（必须 Bearer JWT）
 */
authRouter.get('/api/auth/me', (req: Request, res: Response) => {
  if (!req.principal || req.principal.type !== 'user') {
    return res.status(401).json({ error: '请先登录' });
  }

  return res.json({
    id: req.principal.userId,
    tenantId: req.principal.tenantId,
    role: req.principal.role,
  });
});

/**
 * POST /api/auth/refresh
 * 使用 refresh token 换取新的 access token
 */
authRouter.post('/api/auth/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken 不能为空' });
    }

    const pg = PgDatabase.getInstance();
    const tokenHash = hashRefreshToken(refreshToken);
    const stored = await pg.findRefreshToken(tokenHash);

    if (!stored) {
      return res.status(401).json({ error: 'Refresh Token 无效或已过期' });
    }

    // 签发新 access token
    const user = await pg.getUserById(stored.tenantId, stored.userId);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: '用户不存在或已禁用' });
    }

    const accessToken = signAccessToken(user.id, user.tenantId, user.role as any);

    return res.json({ accessToken });
  } catch (err) {
    console.error('[Auth] refresh error:', (err as Error).message);
    return res.status(500).json({ error: 'Token 刷新失败' });
  }
});

/**
 * POST /api/auth/logout
 * 撤销 refresh token
 */
authRouter.post('/api/auth/logout', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const pg = PgDatabase.getInstance();
      const tokenHash = hashRefreshToken(refreshToken);
      await pg.revokeRefreshToken(tokenHash);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[Auth] logout error:', (err as Error).message);
    return res.status(500).json({ error: '登出失败' });
  }
});