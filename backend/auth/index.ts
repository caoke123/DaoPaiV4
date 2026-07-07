// Phase 3-A: Auth 模块统一导出
// Phase 3-B: 新增 password / jwt 模块
// Phase 3-C: 新增 requireAuth 认证保护开关

export type { UserRole, PrincipalType, UserPrincipal, AgentPrincipal, AnonymousPrincipal, Principal } from './types';
export { authMiddleware } from './authMiddleware';
export { parseAgentToken, requireAgent } from './agentAuth';
export { parseUserJwt, requireUser, requireRole } from './userAuth';
export { requireUserIfAuthRequired } from './requireAuth';
export { hashPassword, verifyPassword } from './password';
export {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
} from './jwt';
export type { AccessTokenPayload } from './jwt';