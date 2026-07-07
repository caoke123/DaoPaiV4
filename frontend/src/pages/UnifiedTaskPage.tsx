// UnifiedTaskPage — 配置驱动的统一任务页面
// Phase D-2B: 基础框架，仅验证 Arrival 场景
//
// 使用方式：
//   <UnifiedTaskPage config={arrivalConfig} />
//
// 当前支持：
//   - arrival: 完整功能（运单录入 + 提交 + 轮询 + 日志 + 结果）
//
// 后续扩展（Phase D-2C+）：
//   - dispatch/integrated/sign/return: 通过 features 标志位控制局部组件
import { useState, useCallback, useRef, useEffect } from 'react';
import { MapPin, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import type { WindowInfo } from '../api/client';
import { fetchStatus, submitTask, getTaskProgress, getTaskLogs } from '../api/client';
import { apiLogToUiEntry, resultToLog } from '../lib/log-utils';
import type { ParsedWaybills } from '../lib/waybillParser';
import type { ExecutionStatus } from '../lib/mock-data';
import {
  TaskPageLayout,
  WaybillInput,
  TaskLogPanel,
  TaskActionBar,
  type TaskLogEntry,
  type TaskPageConfig,
  type TaskStatCardConfig,
} from '../components/task';
import ExecutionStatusCard from '../components/shared/ExecutionStatusCard';

interface UnifiedTaskPageProps {
  config: TaskPageConfig;
}

// ── 页面组件 ──

export default function UnifiedTaskPage({ config }: UnifiedTaskPageProps) {
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentSiteRef = useRef('tiannanda');

  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [fetchError, setFetchError] = useState('');
  const [parsed, setParsed] = useState<ParsedWaybills>({
    valid: [], invalid: [], rawCount: 0, totalCount: 0,
  });

  const [taskId, setTaskId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [liveStatus, setLiveStatus] = useState<'running' | 'paused' | 'idle'>('idle');
  const [hasStarted, setHasStarted] = useState(false);

  const [execution, setExecution] = useState<ExecutionStatus>({
    progress: 0, total: 0, done: 0, success: 0, failed: 0, remaining: 0,
    eta: '--', status: 'idle',
  });

  const [logs, setLogs] = useState<TaskLogEntry[]>([]);

  // ── 轮询后端窗口状态（5s） ──
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await fetchStatus();
        setWindows(data.windows || []);
        const firstAdmin = data.windows?.find(
          (w: WindowInfo) => w.role === 'admin' && w.isConnected,
        );
        if (firstAdmin) currentSiteRef.current = firstAdmin.site || 'tiannanda';
        setFetchError('');
      } catch {
        setFetchError('无法连接到后端服务');
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  // ── 轮询任务进度 + 日志（800ms，仅 running 时） ──
  useEffect(() => {
    if (!taskId || liveStatus !== 'running') return;

    pollRef.current = setInterval(async () => {
      try {
        const [p, taskLogs] = await Promise.all([
          getTaskProgress(taskId),
          getTaskLogs(taskId, 100),
        ]);

        const success = p.done - p.failCount;
        setExecution({
          progress: p.total > 0 ? Math.round((p.done / p.total) * 100) : 0,
          total: p.total,
          done: p.done,
          success,
          failed: p.failCount,
          remaining: p.total - p.done,
          eta: '--',
          status: p.status === 'done' ? 'completed' : p.status === 'failed' ? 'error' : 'running',
        });

        const resultLogs = p.results.map(resultToLog);
        const executionLogs = taskLogs.map(apiLogToUiEntry);
        const allLogs = [...executionLogs, ...resultLogs].sort((a, b) =>
          b.id.localeCompare(a.id),
        );
        setLogs(allLogs);

        if (p.status === 'done' || p.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          setLiveStatus('idle');
          setSubmitting(false);
        }
      } catch {
        /* 轮询失败静默 */
      }
    }, 800);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [taskId, liveStatus]);

  // ── 派生值 ──

  const firstAdmin = windows.find((w) => w.role === 'admin' && w.isConnected);
  const selectedSite = firstAdmin?.site || currentSiteRef.current;
  const branchName = '天津分拨中心';
  const validCount = parsed.valid.length;
  const invalidCount = parsed.invalid.length;

  // ── 事件处理 ──

  const handleParsedChange = useCallback((p: ParsedWaybills) => {
    setParsed(p);
  }, []);

  const handleStart = useCallback(async () => {
    if (validCount === 0) return;

    setHasStarted(true);
    setSubmitting(true);
    setLiveStatus('running');
    setFetchError('');
    setLogs([]);

    try {
      // Arrival 提交体：{ site, waybillNos }
      // 后续 dispatch/integrated 提交体：{ site, assignments } — 由 config.type 分支构造
      const payload: Record<string, unknown> =
        config.type === 'arrival'
          ? { site: selectedSite, waybillNos: parsed.valid }
          : { site: selectedSite, assignments: [] }; // 占位，后续 Phase 实现

      const resp = await submitTask(config.submitApi, payload);
      setTaskId(resp.taskId);
    } catch (e) {
      setFetchError((e as Error).message || '提交任务失败');
      setLiveStatus('idle');
      setSubmitting(false);
    }
  }, [validCount, selectedSite, config.submitApi, config.type, parsed.valid]);

  const handleReset = useCallback(() => {
    setHasStarted(false);
    setSubmitting(false);
    setLiveStatus('idle');
    setTaskId(null);
    setLogs([]);
    setExecution({
      progress: 0, total: 0, done: 0, success: 0, failed: 0, remaining: 0,
      eta: '--', status: 'idle',
    });
  }, []);

  // ── 状态卡配置 ──

  const statCards: TaskStatCardConfig[] = [
    {
      icon: <MapPin className="w-4 h-4" />,
      label: '上一级网点',
      value: branchName,
      accent: 'text-primary',
    },
    {
      icon: <FileText className="w-4 h-4" />,
      label: '已识别运单',
      value: String(parsed.totalCount),
      accent: 'text-text-primary',
    },
    {
      icon: <CheckCircle2 className="w-4 h-4" />,
      label: '有效运单',
      value: String(validCount),
      accent: 'text-success',
      highlight: true,
    },
    {
      icon: <AlertCircle className="w-4 h-4" />,
      label: '异常运单',
      value: String(invalidCount),
      accent: invalidCount > 0 ? 'text-danger' : 'text-text-tertiary',
    },
  ];

  // ── 渲染 ──

  return (
    <TaskPageLayout
      title={config.title}
      description={config.description}
      statCards={statCards}
      fetchError={fetchError}
      mainContent={<WaybillInput onParsedChange={handleParsedChange} />}
      actionBar={
        <TaskActionBar
          onStart={handleStart}
          onReset={handleReset}
          canStart={validCount > 0}
          submitting={submitting}
          liveStatus={liveStatus}
          hasStarted={hasStarted}
          startLabel={`开始${config.title}`}
          pauseResumeEnabled={config.features.pauseResume}
        />
      }
      logPanel={
        <TaskLogPanel
          logs={logs}
          liveStatus={liveStatus}
          hasStarted={hasStarted}
          idleHint={`点击「开始${config.title}」后显示实时日志`}
        />
      }
      resultPanel={hasStarted ? <ExecutionStatusCard status={execution} /> : undefined}
    />
  );
}
