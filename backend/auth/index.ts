// Phase 3-A: Auth 模块统一导出

export type { UserRole, PrincipalType, UserPrincipal, AgentPrincipal, AnonymousPrincipal, Principal } from './types';
export { authMiddleware } from './authMiddleware';
export { parseAgentToken, requireAgent } from './agentAuth';
export { parseUserJwt, requireUser, requireRole } from './userAuth';