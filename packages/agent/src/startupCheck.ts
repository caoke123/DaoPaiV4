/**
 * 启动检查流程
 *
 * 检查配置文件、授权码、日志目录、网络连通性。
 * 当前 Cloud /agent/* 尚未实现，网络检查使用 try-catch 兜底，
 * 不因接口未实现而导致程序崩溃。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentConfig } from './types';
import { logger } from './logger';
import { createHttpClient, getAgentMe } from './httpClient';

const AGENT_VERSION = '0.1.0';
const LOGS_DIR = path.resolve(__dirname, '..', 'logs');

/** 启动检查结果 */
export interface StartupCheckResult {
  ok: boolean;
  /** 检查项明细 */
  items: string[];
  /** 警告信息 */
  warnings: string[];
}

/**
 * 执行启动检查
 */
export async function startupCheck(config: AgentConfig): Promise<StartupCheckResult> {
  const items: string[] = [];
  const warnings: string[] = [];

  // 1. 配置文件检查
  items.push('配置文件 agent.json 已加载');
  logger.info('配置文件检查通过');

  // 2. 执行电脑授权码检查
  if (config.agentToken && config.agentToken !== '请填入执行电脑授权码') {
    items.push(`执行电脑授权码已配置（${maskToken(config.agentToken)}）`);
  } else {
    items.push('错误：执行电脑授权码未配置');
    logger.error('缺少执行电脑授权码');
    return { ok: false, items, warnings };
  }

  // 3. Cloud 地址检查
  if (config.cloudBaseUrl) {
    items.push(`Cloud 地址：${config.cloudBaseUrl}`);
  } else {
    logger.error('缺少 Cloud 地址');
    return { ok: false, items, warnings };
  }

  // 4. 日志目录检查
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    fs.accessSync(LOGS_DIR, fs.constants.W_OK);
    items.push('本地日志目录已就绪');
  } catch {
    items.push('警告：日志目录不可写');
    warnings.push('日志目录不可写，日志可能无法保存');
    logger.warn('日志目录不可写');
  }

  // 5. 执行端版本
  items.push(`执行端版本：${AGENT_VERSION}`);
  items.push(`本机名称：${os.hostname()}`);
  items.push(`执行电脑：${config.workstationName}`);

  // 6. 尝试连接 Cloud（可失败，不崩溃）
  try {
    const client = createHttpClient(config);
    const me = await getAgentMe(client);
    items.push(`已连接 Cloud，执行电脑编号：${me.workstationId}`);
    items.push(`快递公司：${me.tenantName}`);
    logger.info('Cloud 连接成功');
  } catch (err) {
    const msg = (err as Error).message;
    items.push(`Cloud 连接暂时不可用：${msg}`);
    warnings.push('Cloud /agent/me 接口尚未实现或不可达，等待 Cloud Agent API 落地');
    logger.warn(`Cloud 连接失败：${msg}`);
    logger.info('当前阶段：骨架模式，Cloud Agent API 尚未实现，继续以离线模式运行');
  }

  return { ok: true, items, warnings };
}

/** 对授权码做脱敏显示 */
function maskToken(token: string): string {
  if (token.length <= 15) return '***';
  return token.substring(0, 12) + '...';
}