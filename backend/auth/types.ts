// Phase 3-A: Cloud Platform 认证类型骨架
// 定义 user / agent / anonymous 三类 Principal，为后续 JWT 和 Agent Token 鉴权打基础

export type UserRole = 'super_admin' | 'tenant_admin' | 'operator';

export type PrincipalType = 'user' | 'agent' | 'anonymous';

/** 用户身份 — 通过 Web 端 JWT 登录获得 */
export interface UserPrincipal {
  type: 'user';
  userId: string;
  tenantId: string;
  role: UserRole;
}

/** Agent 身份 — 通过本地执行端 agentToken 鉴权获得 */
export interface AgentPrincipal {
  type: 'agent';
  tenantId: string;
  workstationId: string;
  siteId?: string | null;
}

/** 匿名身份 — 未登录或未携带 Token 时的默认身份 */
export interface AnonymousPrincipal {
  type: 'anonymous';
}

/** 统一 Principal 联合类型 */
export type Principal = UserPrincipal | AgentPrincipal | AnonymousPrincipal;