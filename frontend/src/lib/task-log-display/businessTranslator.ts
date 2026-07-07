// businessTranslator — 业务日志中文化（按类型分规则）
// Phase L-1A-Fix: 消除泛化"验证通过"，每条日志映射到具体业务语义
//
// 规则结构：每个规则指定适用的 taskTypes，按优先级排序。

import type { RawTaskLog, DisplayTaskLog, TaskType } from './types';

// ── 提取工具 ──

function extractValue(msg: string, pattern: RegExp, group = 1): string | undefined {
  const m = msg.match(pattern);
  return m?.[group]?.trim();
}

// ── 规则定义 ──

interface BizRule {
  /** 适用任务类型 (空 = 全部) */
  taskTypes?: TaskType[];
  /** 匹配正则 */
  pattern: RegExp;
  /** 生成标题 (入参: 原始消息) */
  buildTitle: (msg: string) => string;
  /** 默认可见 */
  defaultVisible: boolean;
}

// ══════════════════════════════════════════════════════════════
// Integrated (到派一体) 规则
// ══════════════════════════════════════════════════════════════

const INTEGRATED_RULES: BizRule[] = [
  // ── 上一站 ──
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+START\s+target=(\S+)/,
    buildTitle: (msg) => {
      const target = extractValue(msg, /target\s*=\s*(\S+)/);
      return target ? `📍 上一站选择开始：${target}` : '📍 上一站选择开始';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+PASS\s+value=(\S+)/,
    buildTitle: (msg) => {
      const val = extractValue(msg, /value\s*=\s*(\S+)/);
      return val ? `✅ 上一站选择成功：${val}` : '✅ 上一站选择成功';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+FAIL/,
    buildTitle: (msg) => {
      const reason = extractValue(msg, /reason\s*=\s*(\S+)/);
      return reason ? `❌ 上一站选择失败：${reason}` : '❌ 上一站选择失败';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+SKIP_ALREADY_SELECTED\s+value=(\S+)/,
    buildTitle: (msg) => {
      const val = extractValue(msg, /value\s*=\s*(\S+)/);
      return val ? `⏭️ 上一站已选中，跳过：${val}` : '⏭️ 上一站已选中，跳过';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+VERIFY_AFTER_COURIER\s+matched=true\s+value=(\S+)/,
    buildTitle: (msg) => {
      const val = extractValue(msg, /value\s*=\s*(\S+)/);
      return val ? `✅ 派件员选择后复查上一站成功：${val}` : '✅ 派件员选择后复查上一站成功';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+VERIFY_AFTER_COURIER\s+matched=false/,
    buildTitle: (msg) => {
      const reason = extractValue(msg, /reason\s*=\s*(\S+)/);
      return reason ? `⚠️ 派件员选择后复查上一站失败：${reason}` : '⚠️ 派件员选择后复查上一站失败';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+VERIFY_BEFORE_WAYBILL\s+matched=true\s+value=(\S+)/,
    buildTitle: (msg) => {
      const val = extractValue(msg, /value\s*=\s*(\S+)/);
      return val ? `✅ 单号填写前复查上一站成功：${val}` : '✅ 单号填写前复查上一站成功';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+VERIFY_BEFORE_WAYBILL\s+matched=false/,
    buildTitle: (msg) => {
      const reason = extractValue(msg, /reason\s*=\s*(\S+)/);
      return reason ? `⚠️ 单号填写前复查上一站失败：${reason}` : '⚠️ 单号填写前复查上一站失败';
    },
    defaultVisible: true,
  },
  // prevStation RESELECT 系列 — 折叠为技术明细
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+RESELECT/,
    buildTitle: (msg) => {
      const reason = extractValue(msg, /reason\s*=\s*(\S+)/);
      const action = extractValue(msg, /RESELECT_(\w+)/);
      if (action === 'DURING_WAYBILL_PASS' || action === 'AFTER_COURIER_PASS' || action === 'BEFORE_WAYBILL_PASS') {
        return '✅ 上一站重新选择成功（自动恢复）';
      }
      return reason
        ? `🔄 上一站重新选择中（原因：${reason}）`
        : '🔄 上一站重新选择中';
    },
    defaultVisible: false, // 重新选择细节折叠
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[prevStation\]\s+(?:FAST_PASS|FAST_FAIL|FILTER|FILTER_INPUT|OPTIONS|CLICK_OPTION|V2_LEGACY)/,
    buildTitle: () => '',
    defaultVisible: false, // 实现细节折叠
  },

  // ── 复选框 ──
  {
    taskTypes: ['integrated'],
    pattern: /\[checkbox\]\s+START/,
    buildTitle: () => '☑️ 到派一体复选框开始勾选',
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[checkbox\]\s+PASS\s+checked=true.*inputChecked=true/,
    buildTitle: () => '✅ 到派一体复选框已勾选',
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[checkbox\]\s+PASS\s+checked=true.*already checked/,
    buildTitle: () => '✅ 到派一体复选框已勾选（已处于勾选状态）',
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[checkbox\]\s+FAIL/,
    buildTitle: (msg) => {
      const reason = extractValue(msg, /reason\s*=\s*(\w+)/);
      return reason ? `❌ 到派一体复选框勾选失败：${reason}` : '❌ 到派一体复选框勾选失败';
    },
    defaultVisible: true,
  },

  // ── 派件员 ──
  {
    taskTypes: ['integrated'],
    pattern: /\[courier\]\s+START\s+target=(\S+)/,
    buildTitle: (msg) => {
      const target = extractValue(msg, /target\s*=\s*(\S+)/);
      const empId = extractValue(msg, /employeeId\s*=\s*(\S+)/);
      let title = target ? `👤 派件员选择开始：${target}` : '👤 派件员选择开始';
      if (empId && empId !== '-') title += `（${empId}）`;
      return title;
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[courier\]\s+MATCH\s+employeeId=(\S+)\s+staffName=(\S+)/,
    buildTitle: (msg) => {
      const empId = extractValue(msg, /employeeId\s*=\s*(\S+)/);
      const name = extractValue(msg, /staffName\s*=\s*(\S+)/);
      const matchType = extractValue(msg, /matchType\s*=\s*(\S+)/);
      let title = name ? `✅ 派件员匹配成功：${name}` : '✅ 派件员匹配成功';
      if (empId && empId !== '-') title += `（${empId}）`;
      if (matchType) title += ` [${matchType}]`;
      return title;
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[courier\]\s+PASS\s+inputValue=(\S+)/,
    buildTitle: (msg) => {
      const val = extractValue(msg, /inputValue\s*=\s*(\S+)/);
      return val ? `✅ 派件员选择成功：${val}` : '✅ 派件员选择成功';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[courier\]\s+DIALOG_OPENED/,
    buildTitle: () => '📋 派件员选择弹窗已打开',
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[courier\]\s+CLICK_USE/,
    buildTitle: () => '🖱️ 已点击派件员"选用"按钮',
    defaultVisible: false, // 细节折叠
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[courier\]\s+FAIL/,
    buildTitle: (msg) => {
      const reason = extractValue(msg, /reason\s*=\s*(\w+)/);
      return reason ? `❌ 派件员选择失败：${reason}` : '❌ 派件员选择失败';
    },
    defaultVisible: true,
  },

  // ── 前置校验 ──
  {
    taskTypes: ['integrated'],
    pattern: /\[precheck\]\s+PASS\s+checkbox=true\s+prevStation=true\s+courier=true\s+attempted=(\d+)/,
    buildTitle: (msg) => {
      const count = extractValue(msg, /attempted\s*=\s*(\d+)/);
      return count
        ? `✅ 输入前置校验通过：上一站、派件员、到派一体勾选均正常，共 ${count} 条单号`
        : '✅ 输入前置校验通过';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[precheck\]\s+FAIL/,
    buildTitle: (msg) => {
      const failed = extractValue(msg, /failed\s*=\s*(\S+)/);
      return failed ? `❌ 输入前置校验失败：${failed}` : '❌ 输入前置校验失败';
    },
    defaultVisible: true,
  },

  // ── 运单批量填写 ──
  {
    taskTypes: ['integrated'],
    pattern: /\[waybill\]\s+TOTAL_BEFORE\s+pageTotal=(\S+)/,
    buildTitle: (msg) => {
      const n = extractValue(msg, /pageTotal\s*=\s*(\S+)/);
      return n ? `📊 页面当前已有 ${n} 条单号` : '📊 读取页面当前单号数';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[waybill\]\s+TOTAL\s+attempted=(\d+)/,
    buildTitle: (msg) => {
      const attempted = extractValue(msg, /attempted\s*=\s*(\d+)/);
      const before = extractValue(msg, /beforeTotal\s*=\s*(\S+)/);
      const after = extractValue(msg, /afterTotal\s*=\s*(\S+)/);
      const actual = extractValue(msg, /actualAdded\s*=\s*(\S+)/);
      const duration = extractValue(msg, /durationMs\s*=\s*(\S+)/);
      let title = attempted ? `📝 单号填写完成：${attempted} 条` : '📝 单号填写完成';
      if (duration) {
        const sec = (parseFloat(duration) / 1000).toFixed(1);
        title += `，用时 ${sec} 秒`;
      }
      if (actual && after) title += `（新增 ${actual}，总计 ${after}）`;
      return title;
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[waybill\]\s+TOTAL_READ_FAIL/,
    buildTitle: () => '⚠️ 读取页面单号总数失败',
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[waybill\]\s+FAST_ADD\s+index=(\d+)\/(\d+)/,
    buildTitle: () => '',
    defaultVisible: false, // 逐条 FAST_ADD 折叠到 TOTAL
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[waybill\]\s+FAST_ADD_FAIL/,
    buildTitle: (msg) => {
      const waybill = extractValue(msg, /waybillNo\s*=\s*(\S+)/);
      const reason = extractValue(msg, /reason\s*=\s*(\S+)/);
      let title = waybill ? `❌ 单号 ${waybill} 填写失败` : '❌ 单号填写失败';
      if (reason) title += `：${reason}`;
      return title;
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[waybill\]\s+PREV_STATION_EMPTY/,
    buildTitle: () => '⚠️ 上一站在单号填写过程中变空，正在恢复...',
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[waybill\]\s+STOP_BATCH/,
    buildTitle: (msg) => {
      const remaining = extractValue(msg, /remaining\s*=\s*(\d+)/);
      return remaining ? `❌ 批量填写停止，剩余 ${remaining} 条未处理` : '❌ 批量填写停止';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['integrated'],
    pattern: /\[waybill\]\s+CLICK_ADD/,
    buildTitle: (msg) => {
      const waybill = extractValue(msg, /waybillNo\s*=\s*(\S+)/);
      return waybill ? `⚠️ 添加按钮未找到，单号 ${waybill} 使用按键方式输入` : '⚠️ 添加按钮未找到，使用按键方式输入';
    },
    defaultVisible: false,
  },
];

// ══════════════════════════════════════════════════════════════
// Arrival (到件扫描) 规则
// ══════════════════════════════════════════════════════════════

const ARRIVAL_RULES: BizRule[] = [
  // ── 导航到页面 ──
  {
    taskTypes: ['arrival'],
    pattern: /菜单优先导航到到件扫描/,
    buildTitle: () => '🧭 正在导航到到件扫描页面...',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /检测到件页面元素/,
    buildTitle: () => '',
    defaultVisible: false,
  },
  {
    taskTypes: ['arrival'],
    pattern: /页面检测.*isArrivalPage/,
    buildTitle: () => '✅ 已进入到件扫描页面',
    defaultVisible: true,
  },

  // ── 上一站 ──
  {
    taskTypes: ['arrival'],
    pattern: /上一站填写开始[:：]\s*(\S+)/,
    buildTitle: (msg) => {
      const val = extractValue(msg, /上一站填写开始[:：]\s*(\S+)/);
      return val ? `📍 上一站选择开始：${val}` : '📍 上一站选择开始';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /目标上一站\s*=\s*([^，,]+)，匹配=true/,
    buildTitle: (msg) => {
      const val = extractValue(msg, /目标上一站\s*=\s*([^，,]+)/);
      return val ? `✅ 上一站选择成功：${val}` : '✅ 上一站选择成功';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /目标上一站\s*=\s*([^，,]+)，匹配=false/,
    buildTitle: (msg) => {
      const val = extractValue(msg, /目标上一站\s*=\s*([^，,]+)/);
      return val ? `❌ 上一站选择失败：${val} 未匹配` : '❌ 上一站选择失败';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /上一站填写异常[:：]/,
    buildTitle: (msg) => {
      const err = extractValue(msg, /异常[:：]\s*(.+)/);
      return err ? `❌ 上一站填写异常：${err}` : '❌ 上一站填写异常';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /上一站.*校验通过/,
    buildTitle: (msg) => {
      const val = extractValue(msg, /校验通过[:：]\s*"([^"]+)"/);
      return val ? `✅ 上一站选择校验通过：${val}` : '✅ 上一站选择校验通过';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /上一站.*校验失败/,
    buildTitle: () => '❌ 上一站选择校验失败',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /已输入上一站[:：]/,
    buildTitle: () => '',
    defaultVisible: false,
  },
  {
    taskTypes: ['arrival'],
    pattern: /已点击候选项[:：]/,
    buildTitle: () => '',
    defaultVisible: false,
  },
  {
    taskTypes: ['arrival'],
    pattern: /上一站.*popper.*未.*出现/,
    buildTitle: () => '⏳ 上一站下拉列表加载中...',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /候选项.*未在过滤后出现/,
    buildTitle: () => '⚠️ 上一站候选项未找到，正在重试...',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /上一站.*次尝试全部失败/,
    buildTitle: () => '❌ 上一站选择重试耗尽，全部失败',
    defaultVisible: true,
  },

  // ── 运单 ──
  {
    taskTypes: ['arrival'],
    pattern: /稳定输入测试运单\s*\((\d+)\s*条\)/,
    buildTitle: (msg) => {
      const n = extractValue(msg, /\((\d+)\s*条\)/);
      return n ? `📝 单号输入开始：${n} 条` : '📝 单号输入开始';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /运单输入校验通过[:：]\s*(\d+)\s*条/,
    buildTitle: (msg) => {
      const n = extractValue(msg, /(\d+)\s*条/);
      return n ? `✅ 单号输入校验通过：${n} 条` : '✅ 单号输入校验通过';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /运单输入校验失败/,
    buildTitle: () => '❌ 单号输入校验失败：输入框不可见',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /运单输入异常/,
    buildTitle: (msg) => {
      const err = extractValue(msg, /异常[:：]\s*(.+)/);
      return err ? `❌ 单号输入异常：${err}` : '❌ 单号输入异常';
    },
    defaultVisible: true,
  },

  // ── 查询 ──
  {
    taskTypes: ['arrival'],
    pattern: /查询前置校验开始/,
    buildTitle: () => '🔍 查询前置校验开始...',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /校验结果[:：]上一站=(\S+)/,
    buildTitle: (msg) => {
      const prev = extractValue(msg, /上一站\s*=\s*(\S+)/);
      const waybill = extractValue(msg, /运单\s*=\s*(\S+)/);
      const btn = extractValue(msg, /查询按钮\s*=\s*(\S+)/);
      return `🔍 查询前置校验结果：上一站=${prev}，运单=${waybill}，查询按钮=${btn}`;
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /查询前置校验通过/,
    buildTitle: () => '✅ 查询前置校验通过',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /已点击查询按钮/,
    buildTitle: () => '🖱️ 已点击查询按钮',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /查询按钮文本[:：].*安全检查通过/,
    buildTitle: () => '✅ 查询按钮安全检查通过',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /查询结果.*已加载/,
    buildTitle: () => '✅ 查询结果表格已加载',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /查询结果.*未加载/,
    buildTitle: () => '⚠️ 查询结果表格未加载（测试单号无数据，属正常）',
    defaultVisible: true,
  },
  {
    taskTypes: ['arrival'],
    pattern: /查询后.*table=|查询后.*submitBtn=/,
    buildTitle: (msg) => {
      const table = extractValue(msg, /table\s*=\s*(\S+)/);
      if (table === 'true') return '✅ 查询后确认表格可见';
      return '⚠️ 查询后表格状态异常';
    },
    defaultVisible: true,
  },
];

// ══════════════════════════════════════════════════════════════
// Dispatch (派件扫描) 规则
// ══════════════════════════════════════════════════════════════

const DISPATCH_RULES: BizRule[] = [
  // ── 运单 ──
  {
    taskTypes: ['dispatch'],
    pattern: /\[waybill\]\s+START\s+count=(\d+)/,
    buildTitle: (msg) => {
      const n = extractValue(msg, /count\s*=\s*(\d+)/);
      return n ? `📝 单号输入开始：${n} 条` : '📝 单号输入开始';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['dispatch'],
    pattern: /\[waybill\]\s+TOTAL_BEFORE\s+pageTotal=(\S+)/,
    buildTitle: (msg) => {
      const n = extractValue(msg, /pageTotal\s*=\s*(\S+)/);
      return n ? `📊 页面当前已有 ${n} 条单号` : '📊 读取页面当前单号数';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['dispatch'],
    pattern: /\[waybill\]\s+FAST_ADD\s+index=(\d+)\/(\d+)/,
    buildTitle: () => '',
    defaultVisible: false, // 逐条 FAST_ADD 折叠
  },
  {
    taskTypes: ['dispatch'],
    pattern: /\[waybill\]\s+TOTAL\s+attempted=(\d+)/,
    buildTitle: (msg) => {
      const attempted = extractValue(msg, /attempted\s*=\s*(\d+)/);
      const duration = extractValue(msg, /durationMs\s*=\s*(\S+)/);
      const actual = extractValue(msg, /actualAdded\s*=\s*(\S+)/);
      let title = attempted ? `📝 单号填写完成：${attempted} 条` : '📝 单号填写完成';
      if (duration) {
        const sec = (parseFloat(duration) / 1000).toFixed(1);
        title += `，用时 ${sec} 秒`;
      }
      if (actual) title += `（实际新增 ${actual}）`;
      return title;
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['dispatch'],
    pattern: /\[waybill\]\s+FAST_ADD_FAIL/,
    buildTitle: (msg) => {
      const waybill = extractValue(msg, /waybillNo\s*=\s*(\S+)/);
      const reason = extractValue(msg, /reason\s*=\s*(\S+)/);
      let title = waybill ? `❌ 单号 ${waybill} 填写失败` : '❌ 单号填写失败';
      if (reason) title += `：${reason}`;
      return title;
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['dispatch'],
    pattern: /\[waybill\]\s+ADD_BATCH_FAIL/,
    buildTitle: (msg) => {
      const reason = extractValue(msg, /reason\s*=\s*(\S+)/);
      return reason ? `❌ 批量添加失败：${reason}` : '❌ 批量添加失败';
    },
    defaultVisible: true,
  },
];

// ══════════════════════════════════════════════════════════════
// Sign (签收录入) 规则
// ══════════════════════════════════════════════════════════════

const SIGN_RULES: BizRule[] = [
  // ── 导航 ──
  {
    taskTypes: ['sign'],
    pattern: /菜单优先导航到签收录入/,
    buildTitle: () => '🧭 正在导航到签收录入页面...',
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /页面检测.*isSignPage/,
    buildTitle: () => '✅ 已进入签收录入页面',
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /检测签收页面元素/,
    buildTitle: () => '',
    defaultVisible: false,
  },

  // ── 日期 ──
  {
    taskTypes: ['sign'],
    pattern: /设置日期范围[:：]/,
    buildTitle: (msg) => {
      const m = msg.match(/设置日期范围[:：]\s*(.+)/);
      return m ? `📅 日期范围：${m[1]}` : '📅 设置日期范围';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /目标日期范围.*匹配=true/,
    buildTitle: () => '✅ 日期范围设置成功',
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /目标日期范围.*匹配=false/,
    buildTitle: () => '❌ 日期范围设置失败',
    defaultVisible: true,
  },

  // ── 派件员 ──
  {
    taskTypes: ['sign'],
    pattern: /选择派件员[:：]\s*(\S+)/,
    buildTitle: (msg) => {
      const name = extractValue(msg, /选择派件员[:：]\s*(\S+)/);
      return name ? `👤 派件员选择开始：${name}` : '👤 派件员选择开始';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /目标派件员\s*=\s*([^，,]+)，匹配=true/,
    buildTitle: (msg) => {
      const name = extractValue(msg, /目标派件员\s*=\s*([^，,]+)/);
      return name ? `✅ 派件员选择成功：${name}` : '✅ 派件员选择成功';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /目标派件员.*匹配=false/,
    buildTitle: (msg) => {
      const name = extractValue(msg, /目标派件员\s*=\s*(\S+)/);
      return name ? `❌ 派件员匹配失败：${name}` : '❌ 派件员匹配失败';
    },
    defaultVisible: true,
  },

  // ── 搜索 ──
  {
    taskTypes: ['sign'],
    pattern: /搜索前置校验开始/,
    buildTitle: () => '🔍 搜索前置校验开始...',
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /搜索前置校验[:：]date=(\S+)/,
    buildTitle: (msg) => {
      const date = extractValue(msg, /date\s*=\s*(\S+)/);
      const courier = extractValue(msg, /courier\s*=\s*(\S+)/);
      const btn = extractValue(msg, /searchButton\s*=\s*(\S+)/);
      return `🔍 搜索前置校验结果：日期=${date}，派件员=${courier}，搜索按钮=${btn}`;
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /搜索前置校验通过/,
    buildTitle: () => '✅ 搜索前置校验通过',
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /已点击搜索按钮/,
    buildTitle: () => '🖱️ 已点击搜索按钮',
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /搜索按钮文本[:：].*安全检查通过/,
    buildTitle: () => '✅ 搜索按钮安全检查通过',
    defaultVisible: true,
  },

  // ── 分页 ──
  {
    taskTypes: ['sign'],
    pattern: /设置分页大小[:：]\s*(\d+)条/,
    buildTitle: (msg) => {
      const n = extractValue(msg, /(\d+)\s*条/);
      return n ? `📄 条数/页设置开始：${n} 条/页` : '📄 条数/页设置开始';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /pageSize=(\d+)\s*设置成功/,
    buildTitle: (msg) => {
      const n = extractValue(msg, /pageSize\s*=\s*(\d+)/);
      return n ? `✅ 条数/页设置成功：${n} 条/页` : '✅ 条数/页设置成功';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /目标条数\/页=(\d+)，匹配=true/,
    buildTitle: (msg) => {
      const n = extractValue(msg, /目标条数\/页\s*=\s*(\d+)/);
      return n ? `✅ 条数/页校验通过：${n} 条/页` : '✅ 条数/页校验通过';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /pageSize.*设置失败|pageSize.*失败/,
    buildTitle: (msg) => {
      const size = extractValue(msg, /pageSize\s*=\s*(\S+)/);
      return size ? `❌ 条数/页设置失败：${size}` : '❌ 条数/页设置失败';
    },
    defaultVisible: true,
  },
  {
    taskTypes: ['sign'],
    pattern: /pageSize.*设置第/,
    buildTitle: () => '',
    defaultVisible: false,
  },
  {
    taskTypes: ['sign'],
    pattern: /已点击\s*pageSize|pageSize\s*popper|已点击候选项.*:/i,
    buildTitle: () => '',
    defaultVisible: false,
  },

  // ── 搜索后结果 ──
  {
    taskTypes: ['sign'],
    pattern: /搜索后.*table=|搜索后.*batchSignBtn=/,
    buildTitle: (msg) => {
      const table = extractValue(msg, /table\s*=\s*(\S+)/);
      const btn = extractValue(msg, /batchSignBtn\s*=\s*(\S+)/);
      if (table === 'true') return '✅ 订单列表读取成功';
      return '⚠️ 订单列表读取结果待确认';
    },
    defaultVisible: true,
  },
];

// ══════════════════════════════════════════════════════════════
// 通用 fallback 规则 (降低优先级)
// ══════════════════════════════════════════════════════════════

const FALLBACK_RULES: BizRule[] = [
  // 任务开始（有显式信息）
  {
    pattern: /任务开始|task\s+start|START\s+/i,
    buildTitle: () => '▶️ 任务开始',
    defaultVisible: true,
  },
  // 搜索/查询类
  {
    pattern: /搜索.*开始|search.*start|查询.*开始/,
    buildTitle: () => '🔍 搜索开始',
    defaultVisible: true,
  },
  // 点击类
  {
    pattern: /点击.*按钮|click.*button/,
    buildTitle: (msg) => '🖱️ ' + msg,
    defaultVisible: true,
  },
];

// ══════════════════════════════════════════════════════════════
// 规则汇总
// ══════════════════════════════════════════════════════════════

const ALL_RULES: BizRule[] = [
  ...INTEGRATED_RULES,
  ...ARRIVAL_RULES,
  ...DISPATCH_RULES,
  ...SIGN_RULES,
  ...FALLBACK_RULES,
];

/**
 * 将单条原始日志翻译为业务 DisplayTaskLog
 */
export function translateBusiness(raw: RawTaskLog, taskType: TaskType): DisplayTaskLog | null {
  const msg = raw.message;
  for (const rule of ALL_RULES) {
    // 类型过滤
    if (rule.taskTypes && !rule.taskTypes.includes(taskType)) continue;
    if (rule.pattern.test(msg)) {
      const title = rule.buildTitle(msg);
      return {
        id: raw.id,
        level: raw.level,
        title: title || msg,
        category: 'business',
        defaultVisible: rule.defaultVisible,
        raw,
      };
    }
  }
  return null;
}

/**
 * fallback: 未匹配任何规则 → unknown
 */
export function translateUnknown(raw: RawTaskLog): DisplayTaskLog {
  const isImportant = raw.level === 'error' || raw.level === 'warning';
  return {
    id: raw.id,
    level: raw.level,
    title: raw.message,
    category: 'unknown',
    defaultVisible: isImportant,
    raw,
  };
}
