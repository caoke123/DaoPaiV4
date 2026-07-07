// translateTaskLogs — 统一翻译入口
// Phase L-1A-Fix: 消除泛化翻译，每个日志映射到具体业务语义
//
// 处理流程：
//   1. translateCommon → 匹配 runtime/navigator/guard 规则
//   2. translateBusiness → 匹配 4 业务类型特定规则
//   3. translateUnknown → fallback（ERROR/WARNING 始终可见）
//   4. aggregateDisplayLogs → FAST_ADD 聚合
//
// 约束：
//   - 绝不变异 raw 字段
//   - ERROR/WARNING 永不折叠
//   - 每个 DisplayTaskLog 包含 raw 引用

import type { RawTaskLog, DisplayTaskLog, TaskType } from './types';
import { translateCommon } from './commonTranslator';
import { translateBusiness, translateUnknown } from './businessTranslator';
import { aggregateDisplayLogs } from './logAggregator';

export function translateTaskLogs(
  taskType: TaskType,
  rawLogs: RawTaskLog[],
): DisplayTaskLog[] {
  if (rawLogs.length === 0) return [];

  // Step 1-3: 逐条翻译
  const translated: DisplayTaskLog[] = rawLogs.map(raw => {
    const commonResult = translateCommon(raw);
    if (commonResult) return commonResult;

    const businessResult = translateBusiness(raw, taskType);
    if (businessResult) return businessResult;

    return translateUnknown(raw);
  });

  // Step 4: FAST_ADD 聚合
  return aggregateDisplayLogs(translated);
}
