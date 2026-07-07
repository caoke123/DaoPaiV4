// logAggregator — 日志聚合
// Phase L-1A-Fix: 只折叠逐条 FAST_ADD 和实现细节，不折叠关键业务节点
//
// 聚合规则：
//   1. FAST_ADD 聚合：连续逐条 FAST_ADD → 1 条"单号填写完成"
//   2. 不折叠：START / PASS / FAIL / MATCH / VERIFY / precheck / safety 等关键节点

import type { DisplayTaskLog } from './types';

/**
 * FAST_ADD 聚合：将连续的被折叠 FAST_ADD 条目汇总为 1 条
 * 只聚合 defaultVisible=false 的 business 条目（即逐条的 FAST_ADD）
 */
function aggregateFastAdd(logs: DisplayTaskLog[]): DisplayTaskLog[] {
  const result: DisplayTaskLog[] = [];
  let group: DisplayTaskLog[] = [];

  const flushGroup = () => {
    if (group.length === 0) return;
    if (group.length <= 2) {
      result.push(...group);
    } else {
      // 多条 FAST_ADD 折叠
      const first = group[0];
      const last = group[group.length - 1];
      const durationMs = last.raw.timestamp - first.raw.timestamp;
      const durationSec = (durationMs / 1000).toFixed(1);
      result.push({
        id: `agg-fastadd-${first.id}`,
        level: 'success',
        title: `📝 单号填写完成：${group.length} 条，用时 ${durationSec} 秒`,
        category: 'business',
        defaultVisible: true,
        raw: first.raw,
        children: group,
      });
    }
    group = [];
  };

  for (const log of logs) {
    // 判断是否为可折叠的 FAST_ADD 条目
    const isFastAdd = /FAST_ADD|fast.?add/i.test(log.raw.message);
    const isFoldable = log.category === 'business' && !log.defaultVisible && isFastAdd;

    if (isFoldable && log.level !== 'error' && log.level !== 'warning') {
      group.push(log);
    } else {
      flushGroup();
      result.push(log);
    }
  }
  flushGroup();
  return result;
}

/**
 * 主聚合函数
 */
export function aggregateDisplayLogs(logs: DisplayTaskLog[]): DisplayTaskLog[] {
  return aggregateFastAdd(logs);
}
