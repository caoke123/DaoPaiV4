/**
 * DaoPai 本地执行端 — 启动入口
 *
 * Step 8: 入口仅负责启动横幅、配置加载、日志初始化与 AgentDaemon 启动。
 * M5-0: 新增版本指纹打印与 gitCommit/buildId/startedAt/chromePath/chromeKind 信息。
 */

import { execSync } from 'node:child_process';
import { loadConfig, getChromeKind, getRootResolveMethod, getLocalRoot } from './config';
import { initLogger } from './logger';
import { AgentDaemon } from './runtime/AgentDaemon';

/** Agent process startup timestamp — shared with AgentDaemon for heartbeat */
const agentStartedAt = new Date().toISOString();

function getRuntimeGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: process.cwd(), encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getRuntimeBuildId(): string {
  return process.env.BUILD_ID || getRuntimeGitHash();
}

function logAgentRuntimeProof(): void {
  const git = getRuntimeGitHash();
  const buildId = getRuntimeBuildId();
  console.log('[Agent][Version] ─────────────────────────────────────────');
  console.log(`[Agent][Version]   agentVersion = 0.1.0`);
  console.log(`[Agent][Version]   gitCommit    = ${git}`);
  console.log(`[Agent][Version]   buildId      = ${buildId}`);
  console.log(`[Agent][Version]   startedAt    = ${agentStartedAt}`);
  console.log(`[Agent][Version]   NODE_ENV     = ${process.env.NODE_ENV || 'development'}`);
  console.log('[Agent][Version] ─────────────────────────────────────────');
  // K-3 compatibility log
  console.log(`[RuntimeProof][Agent] phase=K-3A arrivalReadyTakeover=true buildTime=${agentStartedAt} git=${git}`);
  console.log(`[RuntimeProof][Agent] phase=K-3B dispatchReadyTakeover=true buildTime=${agentStartedAt} git=${git}`);
  console.log(`[RuntimeProof][Agent] phase=K-3C signReadyTakeover=true buildTime=${agentStartedAt} git=${git}`);
  console.log(`[RuntimeProof][Agent] phase=K-3D integratedReadyTakeover=true buildTime=${agentStartedAt} git=${git}`);
}

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  DaoPai 本地执行端 v0.1.0');
  console.log('  当前阶段：AgentDaemon 编排收口');
  console.log('========================================');
  logAgentRuntimeProof();
  console.log('');

  const config = loadConfig();
  initLogger(config.logLevel);

  // M5-1: 打印 Chrome 路径信息
  const chromeKind = getChromeKind(config.browser.executablePath);
  console.log('[Agent][Chrome] ─────────────────────────────────────────');
  console.log(`[Agent][Chrome]   localRoot        = ${getLocalRoot()}`);
  console.log(`[Agent][Chrome]   rootResolveMethod = ${getRootResolveMethod()}`);
  console.log(`[Agent][Chrome]   chromePath       = ${config.browser.executablePath}`);
  console.log(`[Agent][Chrome]   chromeKind       = ${chromeKind}`);
  console.log(`[Agent][Chrome]   userDataDir      = ${config.browser.userDataDir}`);
  console.log(`[Agent][Chrome]   debugPort        = ${config.browser.debugPort}`);
  console.log(`[Agent][Chrome]   headless         = ${config.browser.headless}`);
  console.log('[Agent][Chrome] ─────────────────────────────────────────');
  console.log('');

  const gitCommit = getRuntimeGitHash();
  const buildId = getRuntimeBuildId();
  const daemon = new AgentDaemon({
    config,
    agentVersion: '0.1.0',
    gitCommit,
    buildId,
    startedAt: agentStartedAt,
    chromeKind,
  });
  await daemon.start();
}

main().catch((err) => {
  console.error('本地执行端启动失败：', err.message);
  process.exit(1);
});
