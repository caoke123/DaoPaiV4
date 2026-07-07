// commonTranslator — 通用日志中文化（Runtime / Guard）
// Phase L-1A-Fix: 补充具体语义，消除泛化翻译
//
// 匹配所有类型共用的运行时和基础设施日志。

import type { RawTaskLog, DisplayTaskLog } from './types';

// ── 提取工具 ──

function extractValue(msg: string, pattern: RegExp, group = 1): string | undefined {
  const m = msg.match(pattern);
  return m?.[group]?.trim();
}

// ── 匹配规则 ──

interface TranslationRule {
  /** 匹配正则 */
  pattern: RegExp;
  /** 生成标题 (支持 $1 $2 引用捕获组) */
  buildTitle: (msg: string) => string;
  /** 分类 */
  category: DisplayTaskLog['category'];
  /** 默认可见 */
  defaultVisible: boolean;
}

const RUNTIME_RULES: TranslationRule[] = [
  // ── READY 窗口匹配 ──
  {
    pattern: /READY\s+窗口.*验证通过|Dashboard\s+P0\s*=\s*READY/i,
    buildTitle: () => '✅ READY 窗口验证通过，可执行任务',
    category: 'runtime',
    defaultVisible: true,
  },
  {
    pattern: /检测\s+Dashboard\s+P0/i,
    buildTitle: () => '🔍 正在检测就绪窗口...',
    category: 'runtime',
    defaultVisible: true,
  },

  // ── CDP 连接 ──
  {
    pattern: /connectOverCDP\s*成功/,
    buildTitle: () => '✅ 已连接员工浏览器窗口',
    category: 'runtime',
    defaultVisible: true,
  },

  // ── 首页操作 ──
  {
    pattern: /ensureCleanHome\s*成功/,
    buildTitle: () => '✅ 首页状态检查通过',
    category: 'runtime',
    defaultVisible: true,
  },
  {
    pattern: /restoreCleanHome\s*成功|已恢复首页/,
    buildTitle: () => '✅ 已恢复首页',
    category: 'runtime',
    defaultVisible: true,
  },

  // ── 浏览器启动 / 断开 ──
  {
    pattern: /launch.*browser|启动.*浏览/i,
    buildTitle: () => '🚀 正在启动浏览器...',
    category: 'runtime',
    defaultVisible: true,
  },
  {
    pattern: /disconnect|断开连接/i,
    buildTitle: () => '🔌 已断开浏览器连接',
    category: 'runtime',
    defaultVisible: true,
  },

  // ── 安全守卫 (会被 aggregator 折叠) ──
  {
    pattern: /\[safety\]\s*DRY_RUN=true|试运行.*(?:保护|完成|未点击)/i,
    buildTitle: (msg) => {
      const clicked = extractValue(msg, /finalSubmitClicked\s*=\s*(\S+)/);
      if (clicked === 'false') return '🛡️ 试运行保护：已阻止最终提交';
      if (clicked === 'true') return '⚠️ 试运行异常：检测到提交点击';
      return '🛡️ 试运行保护已生效';
    },
    category: 'guard',
    defaultVisible: true,
  },
  {
    pattern: /已检测.*上传按钮|检测到.*上传|submitBtn.*检测/i,
    buildTitle: (msg) => {
      if (/dry.?run|试运行|未点击/i.test(msg)) {
        return '🛡️ 已检测到上传按钮，试运行模式下不点击';
      }
      return '📤 已检测到上传按钮';
    },
    category: 'guard',
    defaultVisible: true,
  },
  {
    pattern: /已阻止.*提交|阻止.*提[交传]/,
    buildTitle: () => '🛡️ 试运行保护：已阻止最终提交',
    category: 'guard',
    defaultVisible: true,
  },
  {
    pattern: /DRY[-_]RUN\s*(?:完成|complete)/i,
    buildTitle: () => '🛡️ 试运行完成，未点击最终提交',
    category: 'guard',
    defaultVisible: true,
  },
  {
    pattern: /assignment.*本地执行完成|当前员工任务完成/i,
    buildTitle: () => '✅ 当前员工任务完成',
    category: 'runtime',
    defaultVisible: true,
  },

  // ── 导航 ──
  {
    pattern: /菜单优先导航|navigat.*menu|menu.*navigat/i,
    buildTitle: (msg) => {
      const page = extractValue(msg, /到\s*(到件|派件|签收|到派一体)\s*(?:扫描|录入|页面)?/);
      if (page) return `🧭 正在导航到${page}页面...`;
      return '🧭 正在导航到目标页面...';
    },
    category: 'navigator',
    defaultVisible: true,
  },
  {
    pattern: /导航成功.*方法[:：]\s*(\S+)/,
    buildTitle: (msg) => {
      const method = extractValue(msg, /方法[:：]\s*(\S+)/);
      return method ? `✅ 已进入目标页面（导航方式：${method}）` : '✅ 已进入目标页面';
    },
    category: 'navigator',
    defaultVisible: true,
  },
  {
    pattern: /页面已打开[:：]\s*(\S+)/,
    buildTitle: () => '✅ 页面加载完成',
    category: 'navigator',
    defaultVisible: true,
  },

  // ── runBrowserDryRun 入口 ──
  {
    pattern: /\[BrowserDryRun\]\[.*?\]\s*ENTER\s+staffName=(\S+)/,
    buildTitle: (msg) => {
      const name = extractValue(msg, /staffName\s*=\s*(\S+)/);
      return name ? `🎯 任务开始：员工 ${name}` : '🎯 任务开始';
    },
    category: 'runtime',
    defaultVisible: true,
  },
  {
    pattern: /DRY[-_]RUN\s+START|dry[-_]run\s+start|browser.*dry.?run.*start/i,
    buildTitle: () => '🚀 试运行开始',
    category: 'runtime',
    defaultVisible: true,
  },

  // ── 页面检测 (调试信息，默认折叠) ──
  {
    pattern: /页面检测[:：].*is\w+Page|检测.*页面元素/,
    buildTitle: () => '',
    category: 'runtime',
    defaultVisible: false, // 技术调试信息
  },

  // ── 弹窗清理 (静默) ──
  {
    pattern: /cleanDomPopups:\s*no_visible_popup/,
    buildTitle: () => '',
    category: 'runtime',
    defaultVisible: false,
  },

  // ── 性能数据 (默认折叠) ──
  {
    pattern: /\[perf\]\s+\w+/,
    buildTitle: () => '',
    category: 'runtime',
    defaultVisible: false,
  },

  // ── page.title() 失败警告 ──
  {
    pattern: /page\.title\(\)\s*失败/,
    buildTitle: () => '⚠️ 页面标题获取失败（页面可能正在重载）',
    category: 'runtime',
    defaultVisible: true,
  },

  // ── 通用 waiting ──
  {
    pattern: /wait(?:ing)?.*(?:element|selector|元素)/i,
    buildTitle: () => '⏳ 等待页面元素就绪...',
    category: 'runtime',
    defaultVisible: true,
  },

  // ── 执行完成 ──
  {
    pattern: /(?:执行|操作).*完[成毕]|(?:execution|operation).*(?:complete|done|finish)/i,
    buildTitle: () => '🏁 执行完成',
    category: 'runtime',
    defaultVisible: true,
  },
  {
    pattern: /DRY[-_]RUN\s+EXIT|dry[-_]run.*exit|browser.*dry.?run.*(?:done|exit|complete)/i,
    buildTitle: () => '🏁 试运行完成',
    category: 'runtime',
    defaultVisible: true,
  },
];

/**
 * 将单条原始日志翻译为通用 DisplayTaskLog
 */
export function translateCommon(raw: RawTaskLog): DisplayTaskLog | null {
  const msg = raw.message;
  for (const rule of RUNTIME_RULES) {
    if (rule.pattern.test(msg)) {
      return {
        id: raw.id,
        level: raw.level,
        title: rule.buildTitle(msg),
        category: rule.category,
        defaultVisible: rule.defaultVisible,
        raw,
      };
    }
  }
  return null;
}
