// 运单号解析工具
// 用于文本批量录入运单号

/**
 * 运单号校验
 * - 5 开头 + 13 位数字（14 位）
 * - BN + 14 位数字
 * - 10-15 位纯数字（兼容）
 */
export function isValidWaybillNo(str: string): boolean {
  const s = str.trim();
  if (/^5\d{13}$/.test(s)) return true;   // 5开头14位
  if (/^BN\d{14}$/i.test(s)) return true;  // BN开头14位
  if (/^\d{10,15}$/.test(s)) return true; // 兼容10-15位纯数字
  return false;
}

/** 解析结果：有效 + 无效分类 */
export interface ParsedWaybills {
  valid: string[];     // 去重后的有效运单
  invalid: string[];   // 去重后的无效运单
  rawCount: number;    // 原始输入条数（含空）
  totalCount: number;   // 去重后总条数
}

/**
 * 从文本中解析运单号（去重）
 * 支持：换行、Tab、逗号、中文逗号、分号、空格 等分隔
 */
export function parseWaybillText(text: string): ParsedWaybills {
  if (!text.trim()) {
    return { valid: [], invalid: [], rawCount: 0, totalCount: 0 };
  }
  const parts = text.split(/[\n\r\t,，;\s]+/);
  const trimmed = parts.map(s => s.trim()).filter(Boolean);
  const unique = [...new Set(trimmed)];

  const valid: string[] = [];
  const invalid: string[] = [];
  for (const item of unique) {
    if (isValidWaybillNo(item)) {
      valid.push(item);
    } else {
      invalid.push(item);
    }
  }

  return {
    valid,
    invalid,
    rawCount: trimmed.length,
    totalCount: unique.length,
  };
}
