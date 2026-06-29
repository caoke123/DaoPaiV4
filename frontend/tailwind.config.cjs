/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      /* ═══════════════════════════════════════════════════════════
         Colors — 所有颜色值映射到 :root CSS 变量（Design Token）
         来源: Demo「极简灰白 + 单品牌蓝」设计系统
         命名保持向后兼容，值已更新为 Demo 色板
         ═══════════════════════════════════════════════════════════ */
      colors: {
        /* 品牌蓝 — var(--brand) #0060FF 替代旧 primary #2563EB */
        primary: {
          DEFAULT: 'var(--brand)',
          hover: '#004CCC',              /* var(--brand-text) 较深蓝 */
          light: 'var(--brand-soft)',    /* rgba(0,96,255,0.08) 浅蓝背景 */
        },

        /* 表面层级 — 2 层白/灰 */
        surface: {
          DEFAULT: 'var(--surface)',     /* #FFFFFF 纯白卡片 */
          bg: 'var(--bg)',              /* #F4F5F7 全局页面背景 */
          light: 'var(--surface-2)',    /* #FAFAFB 次级表面 */
        },

        /* 边框 — 2 层灰 */
        border: {
          DEFAULT: 'var(--border)',      /* #E4E5E8 常规边框 */
          strong: 'var(--border-strong)',/* #C4C6CD 强调边框 (hover/label) */
        },

        /* 文本层级 — 3 层灰度 */
        text: {
          primary: 'var(--text-1)',      /* #1C1D21 主标题/正文 */
          secondary: 'var(--text-2)',    /* #4D515C 次要文本 */
          tertiary: 'var(--text-3)',     /* #878A94 辅助/占位 */
          inverted: '#FFFFFF',           /* 浅底反白文本 */
        },

        /* 语义色 — 绿/橙/红（含浅色背景变体） */
        success: {
          DEFAULT: 'var(--ok)',          /* #009951 */
          light: 'var(--ok-soft)',       /* #E5F5EC */
        },
        warning: {
          DEFAULT: 'var(--warn)',        /* #E68A00 */
          light: 'var(--warn-soft)',     /* #FDF3E5 */
        },
        danger: {
          DEFAULT: 'var(--err)',         /* #E02433 */
          light: 'var(--err-soft)',      /* #FCE9EB */
        },
      },

      /* ═══════════════════════════════════════════════════════════
         Font Family — Inter + PingFang SC (正文) / JetBrains Mono (等宽)
         ═══════════════════════════════════════════════════════════ */
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'PingFang SC', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'ui-monospace', 'Consolas', 'monospace'],
      },

      /* ═══════════════════════════════════════════════════════════
         Font Size — 保持原有排版层级
         ═══════════════════════════════════════════════════════════ */
      fontSize: {
        'display': ['32px', { lineHeight: '1.2', fontWeight: '600' }],
        'h1': ['24px', { lineHeight: '1.3', fontWeight: '600' }],
        'h2': ['20px', { lineHeight: '1.35', fontWeight: '600' }],
        'h3': ['16px', { lineHeight: '1.4', fontWeight: '600' }],
      },

      /* ═══════════════════════════════════════════════════════════
         Spacing — 壳布局固定尺寸
         ═══════════════════════════════════════════════════════════ */
      spacing: {
        'header': '52px',               /* 顶栏 h=52px */
        'sidebar': '200px',             /* 侧边栏 w=200px（对齐 Demo .sidebar-comp） */
        'sidebar-collapsed': '64px',
        'statusbar': '26px',            /* 状态栏 h=26px（对齐 Demo .statusbar） */
      },

      /* ═══════════════════════════════════════════════════════════
         Border Radius — 3 级圆角阶梯（对齐 Demo --r / --r-lg / --r-xl）
         ═══════════════════════════════════════════════════════════ */
      borderRadius: {
        'sm': '6px',       /* var(--r)    按钮/输入框小圆角 */
        'md': '10px',      /* var(--r-lg)  卡片中圆角 */
        'card': '14px',    /* var(--r-xl)  主面板大圆角 */
        'btn': '12px',     /* 保留旧值，兼容现有代码 */
        'input': '12px',   /* 保留旧值 */
        'full': '9999px',  /* 药丸全圆角 */
      },

      /* ═══════════════════════════════════════════════════════════
         Box Shadow — 克制阴影（对齐 Demo）
         ═══════════════════════════════════════════════════════════ */
      boxShadow: {
        'panel': 'var(--shadow-panel)',                  /* 卡片阴影: 0 2px 12px rgba(0,0,0,0.03) */
        'btn': 'var(--shadow-btn)',                      /* 按钮阴影: 0 2px 8px rgba(0,0,0,0.2) */
        'sm': '0 1px 2px 0 rgba(0, 0, 0, 0.05)',       /* 保留旧值 */
        'focus': '0 0 0 2px #FFFFFF, 0 0 0 4px var(--brand)', /* 聚焦环 */
      },

      /* ═══════════════════════════════════════════════════════════
         Max Width / Transition / Animation
         ═══════════════════════════════════════════════════════════ */
      maxWidth: {
        'content': '1600px',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.19, 1, 0.22, 1)',
      },
      keyframes: {
        logIn: {
          '0%': { opacity: '0', transform: 'translateX(-4px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'log-in': 'logIn 0.2s ease forwards',
        'pulse': 'pulse 2s ease-in-out infinite',
        'blink': 'blink 1s step-end infinite',
        'fade-in-up': 'fadeInUp 0.3s ease forwards',
      },
    },
  },
  plugins: [],
};
