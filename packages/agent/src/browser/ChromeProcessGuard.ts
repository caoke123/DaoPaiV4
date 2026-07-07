/**
 * ChromeProcessGuard — Chrome 进程守卫
 *
 * Phase D-0B: 移除硬编码路径，改为从 config 动态读取。
 *
 * 职责：
 *   1. 检查 debugPort 是否被占用
 *   2. 识别占用端口的 PID
 *   3. 校验 PID 是否是 V3 Chrome（通过 executablePath + userDataDir）
 *   4. 非 V3 Chrome 占用端口时，禁止连接并报错
 *   5. 进程级关闭：isProcessAlive / waitForProcessExit / findV3ChromeProcesses / killV3ChromeByPid
 */

import { execSync } from 'child_process';
import { getConfig } from '../config';

export interface PortCheckResult {
  occupied: boolean;
  pid: number | null;
  isV3Chrome: boolean;
  executablePath: string;
  commandLine: string;
  message: string;
}

export interface V3ChromeProcess {
  pid: number;
  executablePath: string;
  commandLine: string;
}

// D-0B: Paths now read from agent config, no longer hardcoded
// See config.ts getConfig().browser.executablePath / userDataDir

function getExpectedChromePath(): string {
  return getConfig().browser.executablePath.replace(/\\/g, '/');
}

function getExpectedUserDataDir(): string {
  return getConfig().browser.userDataDir.replace(/\\/g, '/');
}

// ══════════════════════════════════════════════════════════
// 端口检查
// ══════════════════════════════════════════════════════════

export function checkPort(debugPort: number): PortCheckResult {
  const result: PortCheckResult = {
    occupied: false,
    pid: null,
    isV3Chrome: false,
    executablePath: '',
    commandLine: '',
    message: '',
  };

  try {
    const psCmd = `Get-NetTCPConnection -LocalPort ${debugPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
    const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (!output) {
      result.message = `端口 ${debugPort} 未被占用`;
      return result;
    }

    const pid = parseInt(output);
    if (isNaN(pid) || pid <= 0) {
      result.message = `端口 ${debugPort} 占用信息无法解析`;
      return result;
    }

    result.occupied = true;
    result.pid = pid;

    const processInfo = getProcessInfo(pid);
    result.executablePath = processInfo.executablePath;
    result.commandLine = processInfo.commandLine;
    result.isV3Chrome = isV3ChromeProcess(processInfo);

    if (result.isV3Chrome) {
      result.message = `端口 ${debugPort} 由 V3 Chrome 占用 (PID: ${pid})`;
    } else {
      result.message = `端口 ${debugPort} 被非 V3 Chrome 占用 (PID: ${pid}, 路径: ${processInfo.executablePath})`;
    }

    return result;
  } catch (err) {
    result.message = `端口检查失败: ${(err as Error).message}`;
    return result;
  }
}

// ══════════════════════════════════════════════════════════
// 进程信息查询
// ══════════════════════════════════════════════════════════

interface ProcessInfo {
  executablePath: string;
  commandLine: string;
}

function getProcessInfo(pid: number): ProcessInfo {
  const result: ProcessInfo = { executablePath: '', commandLine: '' };

  try {
    const psCmd = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
    const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (output) {
      try {
        const info = JSON.parse(output);
        result.executablePath = (info.ExecutablePath || '').replace(/\\/g, '/');
        result.commandLine = info.CommandLine || '';
      } catch {
        // JSON 解析失败，忽略
      }
    }
  } catch {
    // PowerShell 查询失败，忽略
  }

  return result;
}

function isV3ChromeProcess(info: ProcessInfo): boolean {
  const normalizedPath = info.executablePath.replace(/\\/g, '/');
  const expectedPath = getExpectedChromePath();

  if (normalizedPath !== expectedPath) {
    return false;
  }

  if (!info.commandLine.includes(getExpectedUserDataDir())) {
    return false;
  }

  return true;
}

// ══════════════════════════════════════════════════════════
// 进程级确认：新增方法
// ══════════════════════════════════════════════════════════

/**
 * 检查进程是否仍然存活（同步版本）
 */
export function isProcessAliveSync(pid: number): boolean {
  try {
    const psCmd = `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`;
    const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    return output === String(pid);
  } catch {
    return false;
  }
}

/**
 * 检查进程是否仍然存活（异步版本）
 */
export async function isProcessAlive(pid: number): Promise<boolean> {
  return isProcessAliveSync(pid);
}

/**
 * 等待进程退出，最多 timeoutMs 毫秒
 * @returns true 如果进程已退出，false 如果超时
 */
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const interval = 500;
  const elapsed = 0;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (!isProcessAliveSync(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  return !isProcessAliveSync(pid);
}

/**
 * 扫描所有 commandLine 包含 V3 userDataDir 的 chrome.exe 进程
 */
export function findV3ChromeProcesses(userDataDir?: string): V3ChromeProcess[] {
  const targetDir = (userDataDir || getExpectedUserDataDir()).replace(/\\/g, '/');
  const results: V3ChromeProcess[] = [];

  try {
    // 查询所有 chrome.exe 进程（用 Where-Object 避免 -Filter 引号嵌套问题）
    const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
    const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    if (!output) return results;

    let processes: any[] = [];
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) {
        processes = parsed;
      } else {
        processes = [parsed];
      }
    } catch {
      return results;
    }

    for (const p of processes) {
      const execPath = (p.ExecutablePath || '').replace(/\\/g, '/');
      const cmdLine = (p.CommandLine || '').replace(/\\/g, '/');
      const expectedPath = getExpectedChromePath();

      // 必须是项目内 Chrome
      if (execPath !== expectedPath) continue;
      // CommandLine 必须包含 V3 userDataDir（正斜杠归一化后比较）
      if (!cmdLine.includes(targetDir)) continue;

      results.push({
        pid: p.ProcessId,
        executablePath: execPath,
        commandLine: cmdLine,
      });
    }
  } catch {
    // 查询失败，返回空
  }

  return results;
}

/**
 * 校验给定的 PID 是否是 V3 Chrome，通过后执行 taskkill /PID <pid> /T /F
 */
export async function killV3ChromeByPid(pid: number): Promise<{ success: boolean; message: string }> {
  // 先检查进程是否还活着
  if (!isProcessAliveSync(pid)) {
    return { success: true, message: `PID ${pid} 已不存在（已自然退出）` };
  }

  // 校验是否 V3 Chrome
  const info = getProcessInfo(pid);
  if (!info.executablePath) {
    return { success: false, message: `无法获取 PID ${pid} 的进程信息，拒绝关闭` };
  }
  if (!isV3ChromeProcess(info)) {
    return { success: false, message: `PID ${pid} 不是 V3 Chrome (路径: ${info.executablePath})，拒绝关闭` };
  }

  // 校验通过，执行 taskkill
  try {
    execSync(`taskkill /PID ${pid} /T /F`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return { success: true, message: `已关闭 V3 Chrome 进程 (PID: ${pid})` };
  } catch (err) {
    return { success: false, message: `关闭进程失败 (PID: ${pid}): ${(err as Error).message}` };
  }
}

/**
 * Deploy-0D-Fix-2: 按自定义 userDataDir 关闭进程
 *
 * 与 killV3ChromeByPid 不同，此函数不检查全局 agent.json 的 userDataDir，
 * 而是使用传入的 userDataDir 来校验。用于 per-window profile 场景。
 *
 * findV3ChromeProcesses 已按 executablePath + userDataDir 过滤了进程，
 * 因此此函数只做 executablePath 校验 + taskkill。
 */
export async function killChromeByUserDataDir(
  pid: number,
  userDataDir: string,
): Promise<{ success: boolean; message: string }> {
  if (!isProcessAliveSync(pid)) {
    return { success: true, message: `PID ${pid} 已不存在（已自然退出）` };
  }

  const info = getProcessInfo(pid);
  if (!info.executablePath) {
    return { success: false, message: `无法获取 PID ${pid} 的进程信息，拒绝关闭` };
  }

  // 只校验 executablePath（findV3ChromeProcesses 已校验 userDataDir）
  const normalizedPath = info.executablePath.replace(/\\/g, '/');
  const expectedPath = getExpectedChromePath();
  if (normalizedPath !== expectedPath) {
    return { success: false, message: `PID ${pid} 不是项目内 Chrome (路径: ${info.executablePath})，拒绝关闭` };
  }

  try {
    execSync(`taskkill /PID ${pid} /T /F`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return { success: true, message: `已关闭 Chrome 进程 (PID: ${pid})` };
  } catch (err) {
    return { success: false, message: `关闭进程失败 (PID: ${pid}): ${(err as Error).message}` };
  }
}

// ══════════════════════════════════════════════════════════
// 兼容旧接口
// ══════════════════════════════════════════════════════════

export function canKillProcess(pid: number): { allowed: boolean; message: string } {
  if (!isProcessAliveSync(pid)) {
    return { allowed: true, message: `PID ${pid} 进程已不存在（已自然退出），无需关闭` };
  }

  const info = getProcessInfo(pid);
  if (!info.executablePath) {
    return { allowed: false, message: `无法获取 PID ${pid} 的进程信息，拒绝关闭` };
  }
  if (!isV3ChromeProcess(info)) {
    return { allowed: false, message: `PID ${pid} 不是 V3 Chrome (路径: ${info.executablePath})，拒绝关闭，防止误关系统正式版 Chrome` };
  }
  return { allowed: true, message: `PID ${pid} 确认为 V3 Chrome，允许关闭` };
}

export function killProcess(pid: number): { success: boolean; message: string } {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return { success: true, message: `已关闭 V3 Chrome 进程 (PID: ${pid})` };
  } catch (err) {
    return { success: false, message: `关闭进程失败 (PID: ${pid}): ${(err as Error).message}` };
  }
}
