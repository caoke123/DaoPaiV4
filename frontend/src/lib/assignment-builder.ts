// assignment-builder — 运单分配构建器
// Phase D-2D: 根据 selectedWorkers + waybillNos 生成 Assignment[]
//
// 分配规则：Round Robin（轮询分配）
//   单号1 → 员工A
//   单号2 → 员工B
//   单号3 → 员工A
//   单号4 → 员工B
//
// 禁止过度设计：不实现权重、负载均衡、优先级、动态调度。

/**
 * 任务分配（与后端 Assignment 模型对齐）
 */
export interface Assignment {
  staffName: string;
  siteId?: string;
  windowId?: string;
  browserId?: string | null;
  runtimeKey?: string;
  waybillNos: string[];
  /** Phase 2-B: 指定模式 — 目标派件员姓名 */
  targetCourierName?: string;
  /** Phase 2-B: 指定模式 — 目标派件员账号 */
  targetCourierAccount?: string;
  /** Phase 2-B: 指定模式签收 — 签收人（仅签收页面使用） */
  signerPerson?: '本人' | '家人' | '家门口' | '代收点';
}

/**
 * Round Robin 分配运单到员工
 *
 * @param workers    员工姓名列表（已选中的）
 * @param waybillNos 运单号列表（已校验有效的）
 * @returns Assignment[] — 每个员工一组运单
 *
 * @example
 * buildAssignments(['肖飞', '刘磊'], ['W1', 'W2', 'W3', 'W4'])
 * // => [
 * //   { staffName: '肖飞', waybillNos: ['W1', 'W3'] },
 * //   { staffName: '刘磊', waybillNos: ['W2', 'W4'] },
 * // ]
 */
export function buildAssignments(
  workers: string[],
  waybillNos: string[],
): Assignment[] {
  if (workers.length === 0 || waybillNos.length === 0) {
    return [];
  }

  // 初始化每个员工的运单桶
  const buckets: Map<string, string[]> = new Map();
  for (const name of workers) {
    buckets.set(name, []);
  }

  // Round Robin：依次轮询分配
  waybillNos.forEach((wb, i) => {
    const workerName = workers[i % workers.length];
    buckets.get(workerName)!.push(wb);
  });

  // 转换为 Assignment[]
  return workers.map((staffName) => ({
    staffName,
    waybillNos: buckets.get(staffName)!,
  }));
}
