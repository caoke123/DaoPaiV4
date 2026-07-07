// log-utils — 前端日志转换公共工具
// Phase Frontend Cleanup: 从 DispatchPage / IntegratedPage / SignPage / UnifiedTaskPage 提取
//
// 所有活跃任务页面使用同一组转换函数，避免 copy-paste 导致的微小差异。
// ArrivalPage(.legacy) 使用本地 LogEntry 类型（含 count 字段），不纳入本次提取。
//
// ══════════════════════════════════════════════════════════════
// 类型层次说明（解决 TaskLogEntry 3 层断裂）
// ══════════════════════════════════════════════════════════════
//
//  Layer 1 (后端内存): TaskLogManager 内部存储
//    - 字段: id, taskId, timestamp(number), level, message, source, staffName, windowId
//    - 通过 GET /api/operations/:taskId/logs 序列化为 JSON 输出
//
//  Layer 2 (API 传输): client.ts → api-contracts.ts 对齐
//    - 字段: id, taskId, timestamp(number), level(LogLevel), message, source, staffName?, windowId?
//    - MUST SYNC WITH src/types/api-contracts.ts
//
//  Layer 3 (UI 渲染): TaskLogPanel.TaskLogEntry
//    - 字段: id, timestamp(string HH:MM:SS), type(含 'success'), barcode(派生), message, count?(聚合)
//    - 本文件的转换函数负责 Layer 2 → Layer 3 的字段映射
//
// ══════════════════════════════════════════════════════════════

import type { WaybillResult, TaskLogEntry as ApiLogEntry } from '../api/client';
import type { TaskLogEntry as UiLogEntry } from '../components/task';

/**
 * 格式化毫秒时间戳为 HH:MM:SS 显示字符串（提取公共逻辑，消除重复）
 */
function formatTimestamp(ms: number): string {
  const ts = new Date(ms);
  return `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}`;
}

/**
 * 将后端 API 日志条目转换为 UI TaskLogEntry（Layer 2 → Layer 3）
 *
 * 字段映射：
 *   id, message           → 直通
 *   timestamp (number)    → timestamp (HH:MM:SS 字符串)
 *   level (LogLevel)      → type (UI 层 LogType，含 'success'——仅 UI 聚合时使用)
 *   barcode               → 派生字段：优先 staffName（派件/签收可追溯），回退 source（到件任务）
 *
 * @param log - Layer 2 API 日志条目
 * @returns Layer 3 UI 日志条目
 */
export function apiLogToUiEntry(log: ApiLogEntry): UiLogEntry {
  return {
    id: log.id,
    timestamp: formatTimestamp(log.timestamp),
    type: log.level as UiLogEntry['type'], // LogLevel ⊂ UiLogType（'success' 仅 UI 层）
    barcode: log.staffName || log.source,
    message: log.message,
  };
}

/**
 * 将后端运单操作结果转换为 UI TaskLogEntry（WaybillResult → Layer 3）
 *
 * 字段映射：
 *   id                    → 合成: "result-{idx}-{timestamp}"
 *   timestamp (number)    → timestamp (HH:MM:SS 字符串)
 *   success (boolean)     → type ('success' | 'error')
 *   waybillNo             → barcode（运单号作为日志标识）
 *   message               → 直通
 *
 * @param r  - 单条运单操作结果
 * @param idx - 在结果数组中的索引（用于生成唯一 id）
 * @returns Layer 3 UI 日志条目
 */
export function resultToLog(r: WaybillResult, idx: number): UiLogEntry {
  return {
    id: `result-${idx}-${r.timestamp}`,
    timestamp: formatTimestamp(r.timestamp),
    type: r.success ? 'success' : 'error',
    barcode: r.waybillNo,
    message: r.message,
  };
}
