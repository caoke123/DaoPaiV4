import { STANDARD_SIGNERS } from '../config/signConfig';

export interface ExecutionReport {
  startTime: string;
  endTime: string;
  durationMs: number;
  totalPages: number;
  successPages: number;
  failedPages: number;
  skippedPages: number;
  totalSelected: number;
  signerStats: Record<string, number>;
  errors: ExecutionError[];
  dryRun: boolean;
}

export interface ExecutionError {
  pageNum: number;
  signer: string;
  message: string;
  screenshot?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) {
    return `${minutes}分钟${seconds}秒`;
  }
  return `${seconds}秒`;
}

export function formatExecutionReport(report: ExecutionReport): string {
  const lines: string[] = [];
  lines.push('================================');
  lines.push(report.dryRun ? '签收执行预览（DRY-RUN）' : '签收执行完成');
  lines.push(`总页数：${report.totalPages}`);
  lines.push(`成功页数：${report.successPages}`);
  lines.push(`失败页数：${report.failedPages}`);
  for (const signer of STANDARD_SIGNERS) {
    const count = report.signerStats[signer.name] ?? 0;
    lines.push(`${signer.name}：${count}页`);
  }
  lines.push(`总耗时：${formatDuration(report.durationMs)}`);
  if (report.errors.length > 0) {
    lines.push('错误列表：');
    for (const err of report.errors) {
      lines.push(`  - Page=${err.pageNum}, Signer=${err.signer}: ${err.message}${err.screenshot ? ` (截图: ${err.screenshot})` : ''}`);
    }
  }
  lines.push('================================');
  return lines.join('\n');
}

export interface ReportBuilderState {
  startTime: Date;
  endTime?: Date;
  totalPages: number;
  successPages: number;
  failedPages: number;
  skippedPages: number;
  totalSelected: number;
  signerStats: Record<string, number>;
  errors: ExecutionError[];
  dryRun: boolean;
}

export class ExecutionReportBuilder {
  private state: ReportBuilderState;

  constructor(totalPages: number, dryRun: boolean) {
    this.state = {
      startTime: new Date(),
      totalPages,
      successPages: 0,
      failedPages: 0,
      skippedPages: 0,
      totalSelected: 0,
      signerStats: {},
      errors: [],
      dryRun,
    };
  }

  recordSuccess(signer: string, selectedCount: number): void {
    this.state.successPages++;
    this.state.totalSelected += selectedCount;
    this.state.signerStats[signer] = (this.state.signerStats[signer] ?? 0) + 1;
  }

  recordSkip(): void {
    this.state.skippedPages++;
  }

  recordError(err: ExecutionError): void {
    this.state.failedPages++;
    this.state.errors.push(err);
  }

  build(): ExecutionReport {
    const endTime = this.state.endTime ?? new Date();
    return {
      startTime: formatDateTime(this.state.startTime),
      endTime: formatDateTime(endTime),
      durationMs: endTime.getTime() - this.state.startTime.getTime(),
      totalPages: this.state.totalPages,
      successPages: this.state.successPages,
      failedPages: this.state.failedPages,
      skippedPages: this.state.skippedPages,
      totalSelected: this.state.totalSelected,
      signerStats: { ...this.state.signerStats },
      errors: [...this.state.errors],
      dryRun: this.state.dryRun,
    };
  }
}
