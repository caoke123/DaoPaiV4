// 派件扫描结果判定纯函数（批次模型，四态）
// Phase L-2: 对齐 arriveScanResult.ts — 新增反向数量匹配、部分成功独立检测、变体文案覆盖
// 独立于 playwright，便于单元测试

/**
 * 派件扫描批次结果状态
 * - SUCCESS: 全部成功
 * - PARTIAL: 部分成功部分失败（无法按单号归因，需人工核实）
 * - FAILED: 全部失败
 * - UNKNOWN_NEEDS_MANUAL_CHECK: toast 缺失或文案无法解析，需人工核实
 */
export type DispatchScanStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'UNKNOWN_NEEDS_MANUAL_CHECK';

export interface DispatchScanOutcome {
  status: DispatchScanStatus;
  /** 成功条数，无法解析时为 null */
  successCount: number | null;
  /** 失败条数，无法解析时为 null */
  failCount: number | null;
  /** 原始 toast 文本或说明 */
  message: string;
}

/**
 * 解析派件扫描 toast 文本，判定批次结果
 *
 * 判定规则（与到件扫描一致，仅关键词不同）：
 * 1. 空文本 → UNKNOWN_NEEDS_MANUAL_CHECK（toast 未出现，不等同于失败）
 * 2. 可解析出"成功N条/失败M条"（正向/反向均可）：
 *    - M=0 且 N>0 → SUCCESS
 *    - N=0 且 M>0 → FAILED
 *    - N>0 且 M>0 → PARTIAL
 *    - 此外，若文案含"部分成功/部分失败/部分异常"关键词 → 强制 PARTIAL
 * 3. 纯成功文案（无数量）→ SUCCESS（数量取 batchSize）
 * 4. 纯失败文案（无数量）→ FAILED
 * 5. 其余无法解析 → UNKNOWN_NEEDS_MANUAL_CHECK
 *
 * @param toastText toast 文本
 * @param batchSize 本批单号总数（用于无数量文案时的兜底计数）
 */
export function parseDispatchScanResult(toastText: string, batchSize: number): DispatchScanOutcome {
  const text = (toastText ?? '').trim();

  // 1. toast 缺失 → UNKNOWN，不等于 FAILED
  if (!text) {
    return {
      status: 'UNKNOWN_NEEDS_MANUAL_CHECK',
      successCount: null,
      failCount: null,
      message: 'toast 未出现，结果未知，需人工核实',
    };
  }

  // ── 解析具体数量 ──
  // 优先正向匹配 "成功N条,失败M条"
  const successMatch = text.match(/成功\s*(\d+)\s*条/);
  const failMatch = text.match(/失败\s*(\d+)\s*条/);

  // Phase L-2: 反向匹配 "N条成功,M条失败"（派件系统的弹窗文案顺序可能不同）
  const reverseSuccessMatch = text.match(/(\d+)\s*条\s*成功/);
  const reverseFailMatch = text.match(/(\d+)\s*条\s*失败/);

  // 优先使用正向匹配，回退到反向匹配
  const rawSuccessCount = successMatch ? parseInt(successMatch[1], 10)
    : reverseSuccessMatch ? parseInt(reverseSuccessMatch[1], 10)
    : null;
  const rawFailCount = failMatch ? parseInt(failMatch[1], 10)
    : reverseFailMatch ? parseInt(reverseFailMatch[1], 10)
    : null;

  if (rawSuccessCount !== null || rawFailCount !== null) {
    const successCount = rawSuccessCount ?? 0;
    const failCount = rawFailCount ?? 0;

    // Phase L-2: "部分成功/部分失败/部分异常" 关键词 → 强制 PARTIAL（即使数量全为成功也要标 PARTIAL）
    const hasPartialKeyword = /部分成功|部分失败|部分异常/.test(text);

    if (failCount === 0 && successCount > 0 && !hasPartialKeyword) {
      return { status: 'SUCCESS', successCount, failCount, message: text };
    }
    if (successCount === 0 && failCount > 0 && !hasPartialKeyword) {
      return { status: 'FAILED', successCount, failCount, message: text };
    }
    if (successCount > 0 && failCount > 0) {
      return { status: 'PARTIAL', successCount, failCount, message: text };
    }
    if (hasPartialKeyword) {
      return { status: 'PARTIAL', successCount, failCount, message: text };
    }
    // 两者都为 0，数量异常
    return {
      status: 'UNKNOWN_NEEDS_MANUAL_CHECK',
      successCount,
      failCount,
      message: `解析到成功${successCount}失败${failCount}，数量异常: ${text}`,
    };
  }

  // ── 无具体数量的文案 ──

  // Phase L-2: "部分成功/部分失败/部分异常" 纯文案（无数量）→ PARTIAL
  if (/部分成功|部分失败|部分异常/.test(text)) {
    return {
      status: 'PARTIAL',
      successCount: null,
      failCount: null,
      message: `部分成功（无具体数量），需人工核实: ${text}`,
    };
  }

  // Phase L-2: 补充其他成功变体 "已完成N条" "处理成功N条"
  const doneMatch = text.match(/(?:已完成|处理成功)\s*(\d+)\s*条/);
  if (doneMatch) {
    const count = parseInt(doneMatch[1], 10);
    return { status: 'SUCCESS', successCount: count, failCount: 0, message: text };
  }

  // 纯成功文案（无具体数量）
  if (/派件成功|批量派件成功|上传成功|操作成功|全部成功|提交成功/.test(text)) {
    return { status: 'SUCCESS', successCount: batchSize, failCount: 0, message: text };
  }

  // 纯失败文案（无具体数量）
  if (/操作失败|派件失败|上传失败|批量派件失败|全部失败|提交失败/.test(text)) {
    return { status: 'FAILED', successCount: 0, failCount: batchSize, message: text };
  }

  // 无法解析 → UNKNOWN
  return {
    status: 'UNKNOWN_NEEDS_MANUAL_CHECK',
    successCount: null,
    failCount: null,
    message: `toast 文案无法解析，需人工核实: ${text}`,
  };
}
