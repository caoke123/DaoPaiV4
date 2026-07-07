import * as http from 'http';
import WebSocket from 'ws';
import { classifyDashboardSnapshot, type DashboardP0Result } from '../browser/BnsyDashboardDetector';
import { logTrace } from '../trace';

interface ReadyGuardInput {
  debugPort: number;
  currentUrl?: string | null;
}

interface ReadyGuardTarget {
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

interface ReadyGuardSnapshot {
  url: string;
  title: string;
  bodyText: string;
  hasPasswordInput: boolean;
  coreSelectorsMatched: string[];
  popupSelectorsMatched: string[];
}

function httpGet(url: string, timeoutMs: number = 2500): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('READY_GUARD_HTTP_TIMEOUT'));
    });
  });
}

async function pickReadyGuardTarget(debugPort: number, currentUrl?: string | null): Promise<ReadyGuardTarget | null> {
  const raw = await httpGet(`http://127.0.0.1:${debugPort}/json`, 2500);
  const pages = JSON.parse(raw) as ReadyGuardTarget[];
  const candidates = pages.filter(p => p.type === 'page' && p.webSocketDebuggerUrl);
  if (candidates.length === 0) return null;

  if (currentUrl) {
    const exact = candidates.find(p => p.url === currentUrl);
    if (exact) return exact;
  }

  const bnsy = candidates.find(p => p.url && p.url.includes('benniaosuyun.com') && !p.url.startsWith('about:'));
  if (bnsy) return bnsy;

  const nonBlank = candidates.find(p => p.url && !p.url.startsWith('about:'));
  return nonBlank || candidates[0];
}

function evaluateSnapshot(wsUrl: string): Promise<ReadyGuardSnapshot> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const requestId = Date.now();
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('READY_GUARD_WS_TIMEOUT'));
    }, 3500);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: requestId,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          expression: `(() => {
            const visible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0;
            };
            const coreSelectors = ['.el-menu','.app-container','.sidebar','.layout','.main-container','#app'];
            const popupSelectors = ['.el-dialog__wrapper','.el-message-box__wrapper','.el-overlay','[role="dialog"]'];
            const coreSelectorsMatched = coreSelectors.filter(sel => {
              try { return !!document.querySelector(sel); } catch { return false; }
            });
            const popupSelectorsMatched = popupSelectors.filter(sel => {
              try {
                return Array.from(document.querySelectorAll(sel)).some(el => visible(el));
              } catch {
                return false;
              }
            });
            return {
              url: location.href || '',
              title: document.title || '',
              bodyText: (document.body?.innerText || '').slice(0, 500),
              hasPasswordInput: !!document.querySelector('input[type="password"]'),
              coreSelectorsMatched,
              popupSelectorsMatched,
            };
          })()`,
        },
      }));
    });

    ws.on('message', (buffer) => {
      try {
        const msg = JSON.parse(buffer.toString());
        if (msg.id !== requestId) return;
        clearTimeout(timer);
        ws.close();
        if (msg.error) {
          reject(new Error(String(msg.error.message || 'READY_GUARD_EVAL_FAILED')));
          return;
        }
        resolve(msg.result.result.value as ReadyGuardSnapshot);
      } catch (err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on('close', () => {
      clearTimeout(timer);
    });
  });
}

export async function runReadyGuard(input: ReadyGuardInput): Promise<DashboardP0Result> {
  const t0 = Date.now();
  logTrace('ready-guard', 'ready_guard_start', {
    debugPort: input.debugPort,
    hasCurrentUrl: !!input.currentUrl,
  });
  try {
    const target = await pickReadyGuardTarget(input.debugPort, input.currentUrl);
    if (!target) {
      return classifyDashboardSnapshot({
        url: input.currentUrl || '',
        title: '',
        bodyText: '',
        hasPasswordInput: false,
        coreSelectorsMatched: [],
        popupSelectorsMatched: [],
      });
    }

    const snapshot = await evaluateSnapshot(target.webSocketDebuggerUrl);
    const result = classifyDashboardSnapshot(snapshot);
    logTrace('ready-guard', 'ready_guard_done', {
      durationMs: Date.now() - t0,
      status: result.status,
      coreMatched: result.coreSelectorsMatched?.length || 0,
      popupsMatched: result.popupSelectorsMatched?.length || 0,
    });
    return result;
  } catch (err) {
    const message = (err as Error).message || 'READY_GUARD_UNKNOWN';
    const fallback = classifyDashboardSnapshot({
      url: input.currentUrl || '',
      title: '',
      bodyText: '',
      hasPasswordInput: false,
      coreSelectorsMatched: [],
      popupSelectorsMatched: [],
    });
    return {
      ...fallback,
      status: fallback.status === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : 'UNKNOWN',
      message: fallback.status === 'LOGIN_REQUIRED' ? fallback.message : `ReadyGuard 检测失败: ${message}`,
      warnings: [...fallback.warnings, message],
    };
  }
}
