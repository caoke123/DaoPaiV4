import type { WindowStatusReportEntry } from '../types';
import type { WindowStatusResult } from './WindowStatusCollector';

export type AgentWindowLifecycleState =
  | 'offline'
  | 'opening'
  | 'process_started'
  | 'cdp_connecting'
  | 'cdp_connected'
  | 'login_checking'
  | 'login_required'
  | 'p0_checking'
  | 'popup_cleaning'
  | 'ready_checking'
  | 'ready'
  | 'busy'
  | 'failed'
  // backward compat aliases
  | 'starting'
  | 'logging_in'
  | 'error';

export interface WindowStateMachineResult {
  state: AgentWindowLifecycleState;
  reportStatus: WindowStatusReportEntry['status'];
  statusText: string;
}

// M5-2: expanded phase set for granular status reporting
type WindowPhase =
  | 'opening' | 'process_started' | 'cdp_connecting' | 'cdp_connected'
  | 'login_checking' | 'p0_checking' | 'popup_cleaning'
  | 'login_required' | 'ready_checking' | 'ready' | 'failed'
  | 'starting' | 'logging_in' | 'error'; // backward compat

interface DeriveWindowStateInput {
  status?: WindowStatusResult;
  phase?: WindowPhase;
  phaseDetail?: string;
  busyTaskType?: string | null;
}

function deriveFromPhase(phase: WindowPhase, phaseDetail?: string): WindowStateMachineResult | null {
  switch (phase) {
    case 'opening':       return { state: 'opening',        reportStatus: 'opening',        statusText: phaseDetail || '启动中' };
    case 'process_started': return { state: 'process_started', reportStatus: 'process_started', statusText: phaseDetail || '进程已启动' };
    case 'cdp_connecting':  return { state: 'cdp_connecting',  reportStatus: 'cdp_connecting',  statusText: phaseDetail || '连接CDP' };
    case 'cdp_connected':   return { state: 'cdp_connected',   reportStatus: 'cdp_connected',   statusText: phaseDetail || 'CDP已连接' };
    case 'login_checking':  return { state: 'login_checking',  reportStatus: 'login_checking',  statusText: phaseDetail || '检测登录' };
    case 'p0_checking':     return { state: 'p0_checking',     reportStatus: 'p0_checking',     statusText: phaseDetail || 'P0检查中' };
    case 'popup_cleaning':  return { state: 'popup_cleaning',  reportStatus: 'popup_cleaning',  statusText: phaseDetail || '清理弹窗' };
    case 'ready_checking':  return { state: 'ready_checking',  reportStatus: 'ready_checking',  statusText: phaseDetail || '检查中' };
    case 'ready':           return { state: 'ready',           reportStatus: 'ready',           statusText: phaseDetail || '就绪' };
    case 'login_required':  return { state: 'login_required',  reportStatus: 'login_required',  statusText: phaseDetail || '待登录' };
    case 'failed':          return { state: 'failed',          reportStatus: 'failed',          statusText: phaseDetail || '失败' };
    // backward compat
    case 'starting':    return { state: 'opening',    reportStatus: 'opening',    statusText: phaseDetail || '启动中' };
    case 'logging_in':  return { state: 'login_checking', reportStatus: 'login_checking', statusText: phaseDetail || '正在登录' };
    case 'error':       return { state: 'failed',     reportStatus: 'failed',     statusText: phaseDetail || '异常' };
    default: return null;
  }
}

export function deriveWindowState(input: DeriveWindowStateInput): WindowStateMachineResult {
  // M5-2: phase-based mapping first (new granular phases)
  if (input.phase) {
    const result = deriveFromPhase(input.phase, input.phaseDetail);
    if (result) return result;
  }

  const status = input.status;
  if (!status || !status.isProcessAlive) {
    return { state: 'offline', reportStatus: 'offline', statusText: '离线' };
  }

  if (input.busyTaskType) {
    return {
      state: 'busy',
      reportStatus: 'busy',
      statusText: `工作中(${input.busyTaskType})`,
    };
  }

  if (!status.isCdpReady) {
    return { state: 'cdp_connecting', reportStatus: 'cdp_connecting', statusText: '正在连接' };
  }

  switch (status.readyState) {
    case 'READY':
      return { state: 'ready', reportStatus: 'ready', statusText: '就绪' };
    case 'LOGIN_REQUIRED':
    case 'LOGIN_FAILED':
      return { state: 'login_required', reportStatus: 'login_required', statusText: status.readyMessage || '待登录' };
    case 'BLOCKED_POPUP':
      return { state: 'failed', reportStatus: 'failed', statusText: status.readyMessage || '弹窗阻塞' };
    case 'PAGE_NOT_READY':
      return { state: 'failed', reportStatus: 'failed', statusText: status.readyMessage || '页面未就绪' };
    case 'UNKNOWN':
      return { state: 'ready_checking', reportStatus: 'ready_checking', statusText: status.readyMessage || '检查中' };
    default:
      if (status.isLoginPage) {
        return { state: 'login_required', reportStatus: 'login_required', statusText: '待登录' };
      }
      return { state: 'cdp_connecting', reportStatus: 'cdp_connecting', statusText: status.lastError || '启动中' };
  }
}
