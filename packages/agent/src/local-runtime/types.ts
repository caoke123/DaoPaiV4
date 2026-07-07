/**
 * DaoPai V3 Local Runtime Types — Phase D-0B Boundary Draft
 *
 * These types define the local runtime boundary for future Deploy-0C/0D work.
 * NOT connected to production paths — read-only definitions only.
 */

/** Local window command types */
export type LocalWindowCommandType =
  | 'open_window'
  | 'close_window'
  | 'restart_window'
  | 'refresh_status';

/** Local window command sent from Cloud to Local Agent */
export interface LocalWindowCommand {
  commandId: string;
  tenantId: string;
  siteId: string;
  workstationId: string;
  windowId: string;
  staffName: string;
  type: LocalWindowCommandType;
}

/** Window status values reported by Local Runtime to Cloud */
export type LocalWindowStatusValue =
  | 'offline'
  | 'starting'
  | 'login_required'
  | 'logging_in'
  | 'ready'
  | 'busy'
  | 'error';

/** Window status report from Local Runtime to Cloud */
export interface LocalWindowStatus {
  tenantId: string;
  siteId: string;
  workstationId: string;
  windowId: string;
  staffName: string;
  status: LocalWindowStatusValue;
  statusText: string;
  currentUrl?: string;
  isProcessAlive: boolean;
  isCdpReady: boolean;
  isDashboardReady: boolean;
  isLoginPage: boolean;
  chromePid?: number;
  cdpEndpoint?: string;
  profilePath?: string;
  lastError?: string;
  updatedAt: string;
}
