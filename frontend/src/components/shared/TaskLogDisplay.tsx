// TaskLogDisplay — 统一的实时日志展示组件
// Phase L-1A: 前端实时日志中文化与聚合展示
//
// 替换 ScanWorkbench 和 SignPage 中的重复 renderLogLines()
//
// Props:
//   taskType  - 业务类型（用于翻译）
//   logs      - 原始 API 日志数组
//   className - 外层容器额外样式
//
// 视图：
//   默认视图：中文业务日志（最新在上）
//   技术明细：可折叠的原始技术日志

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Code } from 'lucide-react';
import type { TaskType, RawTaskLog, DisplayTaskLog } from '../../lib/task-log-display/types';
import { translateTaskLogs } from '../../lib/task-log-display/translateTaskLogs';

interface TaskLogDisplayProps {
  taskType: TaskType;
  logs: RawTaskLog[];
  className?: string;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function getLevelClass(level: string): string {
  switch (level) {
    case 'error': return 'err';
    case 'warning': return 'warn';
    case 'success': return 'ok';
    default: return 'info';
  }
}

function getLevelText(level: string): string {
  switch (level) {
    case 'error': return 'ERR';
    case 'warning': return 'WARN';
    case 'success': return 'OK';
    default: return 'INFO';
  }
}

/**
 * 渲染单条展示日志（支持折叠子条目）
 */
function DisplayLogLine({ log, isLatest }: { log: DisplayTaskLog; isLatest: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = log.children && log.children.length > 0;

  return (
    <>
      <div className={`log-line${isLatest ? ' latest' : ''}`}>
        <span className="log-ts">{formatTime(log.raw.timestamp)}</span>
        <span className={`log-lv ${getLevelClass(log.level)}`}>
          {getLevelText(log.level)}
        </span>
        <span className="log-msg">
          {hasChildren ? (
            <span
              style={{ cursor: 'pointer', userSelect: 'none' }}
              onClick={() => setExpanded(!expanded)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                {expanded
                  ? <ChevronDown size={10} style={{ flexShrink: 0 }} />
                  : <ChevronRight size={10} style={{ flexShrink: 0 }} />
                }
                {log.title}
              </span>
            </span>
          ) : (
            log.title
          )}
          {log.detail && (
            <span
              style={{
                color: 'var(--text-3)',
                marginLeft: 6,
                fontSize: '11px',
              }}
            >
              {log.detail}
            </span>
          )}
        </span>
      </div>
      {hasChildren && expanded && log.children!.map(child => (
        <div key={child.id} className="log-line" style={{ paddingLeft: 20, opacity: 0.7 }}>
          <span className="log-ts" style={{ minWidth: 44 }}></span>
          <span className={`log-lv ${getLevelClass(child.level)}`} style={{ opacity: 0.6 }}>
            {getLevelText(child.level)}
          </span>
          <span className="log-msg" style={{ fontSize: '11px' }}>
            {child.raw.message}
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * 渲染技术明细（中文解释 + 原始日志两层）
 */
function RawLogView({ displayLogs, rawLogs }: { displayLogs: DisplayTaskLog[]; rawLogs: RawTaskLog[] }) {
  if (rawLogs.length === 0) return null;

  // 建立 raw.id → DisplayTaskLog 查找表
  const displayMap = new Map<string, DisplayTaskLog>();
  displayLogs.forEach(d => { displayMap.set(d.raw.id, d); });

  const reversed = [...rawLogs].reverse();
  return (
    <>
      {reversed.map((log, idx) => {
        const display = displayMap.get(log.id);
        const hasTranslation = display && display.category !== 'unknown' && display.title !== log.message;
        return (
          <div
            key={log.id}
            className={`log-line${idx === 0 ? ' latest' : ''}`}
            style={{ opacity: hasTranslation ? 0.75 : 0.55, flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}
          >
            {hasTranslation && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                <span className="log-ts" style={{ color: 'var(--text-3)' }}>{formatTime(log.timestamp)}</span>
                <span className={`log-lv ${getLevelClass(log.level)}`} style={{ opacity: 0.5 }}>
                  {getLevelText(log.level)}
                </span>
                <span className="log-msg" style={{ fontSize: '11px', color: 'var(--text-1)' }}>
                  {display!.title}
                </span>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
              <span className="log-ts">{hasTranslation ? '' : formatTime(log.timestamp)}</span>
              <span className={`log-lv ${getLevelClass(log.level)}`} style={{ opacity: hasTranslation ? 0.35 : 0.65 }}>
                {hasTranslation ? '' : getLevelText(log.level)}
              </span>
              <span className="log-msg" style={{ fontSize: hasTranslation ? '10px' : '11px', color: hasTranslation ? 'var(--text-3)' : 'var(--text-2)' }}>
                {hasTranslation ? `原始：${log.message}` : log.message}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function TaskLogDisplay({ taskType, logs, className }: TaskLogDisplayProps) {
  const [showRaw, setShowRaw] = useState(false);

  const displayLogs = useMemo(
    () => translateTaskLogs(taskType, logs),
    [taskType, logs],
  );

  // 默认视图：只显示 defaultVisible 的日志（最新在上）
  const visibleLogs = useMemo(
    () => displayLogs.filter(l => l.defaultVisible).reverse(),
    [displayLogs],
  );

  // 原始日志（最新在上）
  const rawLogs = useMemo(
    () => [...logs].reverse(),
    [logs],
  );

  const hiddenCount = displayLogs.length - visibleLogs.length;

  if (logs.length === 0) {
    return (
      <div className={`log-line ${className || ''}`} style={{ opacity: 0.5 }}>
        <span className="log-ts">--:--:--</span>
        <span className="log-lv info">INFO</span>
        <span className="log-msg">等待员工窗口日志...</span>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* 默认中文视图 */}
      {visibleLogs.map((log, idx) => (
        <DisplayLogLine key={log.id} log={log} isLatest={idx === 0} />
      ))}

      {/* 技术明细切换按钮 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 0',
          marginTop: 2,
          cursor: 'pointer',
          userSelect: 'none',
          opacity: 0.5,
        }}
        onClick={() => setShowRaw(!showRaw)}
      >
        <Code size={10} />
        <span style={{ fontSize: '10px' }}>
          技术明细（{rawLogs.length} 条{hiddenCount > 0 ? `，已折叠 ${hiddenCount} 条` : ''}）
        </span>
        {showRaw
          ? <ChevronDown size={10} />
          : <ChevronRight size={10} />
        }
      </div>

      {/* 技术明细内容 */}
      {showRaw && <RawLogView displayLogs={displayLogs} rawLogs={rawLogs} />}
    </div>
  );
}
