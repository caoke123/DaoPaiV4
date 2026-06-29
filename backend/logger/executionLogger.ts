export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogContext {
  pageNum?: number;
  signer?: string;
  action?: string;
}

export type ExternalLogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTimestamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const LEVEL_TAG: Record<LogLevel, string> = {
  info: '[INFO]',
  warn: '[WARN]',
  error: '[ERROR]',
  success: '[SUCCESS]',
};

const LEVEL_CONSOLE: Record<LogLevel, string> = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  success: '\x1b[32m',
};

const RESET = '\x1b[0m';

export class ExecutionLogger {
  private external: ExternalLogFn | null;
  private ctx: LogContext = {};

  constructor(external?: ExternalLogFn) {
    this.external = external ?? null;
  }

  setContext(partial: Partial<LogContext>): void {
    this.ctx = { ...this.ctx, ...partial };
  }

  resetContext(): void {
    this.ctx = {};
  }

  child(extraCtx: Partial<LogContext>): ExecutionLogger {
    const child = new ExecutionLogger(this.external ?? undefined);
    child.ctx = { ...this.ctx, ...extraCtx };
    return child;
  }

  info(message: string): void {
    this.emit('info', message);
  }

  warn(message: string): void {
    this.emit('warn', message);
  }

  error(message: string): void {
    this.emit('error', message);
  }

  success(message: string): void {
    this.emit('success', message);
  }

  private emit(level: LogLevel, message: string): void {
    const lines: string[] = [];
    lines.push(LEVEL_TAG[level]);
    if (this.ctx.pageNum !== undefined) lines.push(`Page=${this.ctx.pageNum}`);
    if (this.ctx.signer) lines.push(`Signer=${this.ctx.signer}`);
    if (this.ctx.action) lines.push(`Action=${this.ctx.action}`);
    lines.push(message);
    const formatted = lines.join('\n');

    const color = LEVEL_CONSOLE[level];
    const ts = formatTimestamp();
    const consoleLine = `${color}${LEVEL_TAG[level]}${RESET} [${ts}] ${message}` +
      (this.ctx.pageNum !== undefined || this.ctx.signer
        ? ` (${this.ctx.pageNum !== undefined ? `Page=${this.ctx.pageNum}` : ''}${this.ctx.pageNum !== undefined && this.ctx.signer ? ', ' : ''}${this.ctx.signer ? `Signer=${this.ctx.signer}` : ''})`
        : '');
    if (level === 'error') {
      console.error(consoleLine);
    } else if (level === 'warn') {
      console.warn(consoleLine);
    } else {
      console.log(consoleLine);
    }

    if (this.external) {
      const mappedLevel: 'info' | 'warning' | 'error' =
        level === 'warn' ? 'warning' : level === 'success' ? 'info' : level;
      this.external(mappedLevel, formatted);
    }
  }
}

export function createExecutionLogger(external?: ExternalLogFn): ExecutionLogger {
  return new ExecutionLogger(external);
}
