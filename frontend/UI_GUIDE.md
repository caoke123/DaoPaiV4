# UI 设计规范与组件库指南 (UI_GUIDE)

本文件是 `bnsy-operator-next` 前端 UI 重构的**唯一真理来源**。所有页面的开发必须严格遵守以下 Design Tokens 和 Component Patterns，**严禁**在页面代码中硬编码未在指南中定义的颜色（如 `bg-blue-500`）或随意编写样式。

## 1. 设计原则 (Design Principles)
- **极简灰白底 + 单品牌蓝**：背景以灰白（#F4F5F7 / #FFFFFF）为主，仅在核心操作和状态指示上使用品牌蓝（#0060FF）。
- **克制与实用**：无花哨动画，无大面积彩色块。阴影极浅（`shadow-panel`），圆角分阶梯（6px/10px/14px）。
- **信息密度优先**：作为内部提效工具，布局紧凑（顶栏 48px，侧边栏 200px，状态栏 26px），留白克制。

## 2. 颜色系统 (Color Palette)
必须使用以下映射后的 Tailwind Class，禁止使用原生 Hex。

### 2.1 品牌色 (Brand)
- `bg-primary` / `text-primary` (品牌蓝 #0060FF)：用于主 CTA 按钮、Active 状态指示、核心高亮。
- `bg-primary-light` (品牌浅蓝 rgba(0,96,255,0.08))：用于选中项背景、Hover 态背景。

### 2.2 表面与背景 (Surfaces)
- `bg-surface-bg` (#F4F5F7)：页面最底层底色。
- `bg-surface` (#FFFFFF)：卡片、面板、侧边栏、顶栏背景。
- `bg-surface-light` (#FAFAFB)：次级面板或斑马线背景。

### 2.3 文本层级 (Typography)
- `text-primary` (#1C1D21)：主标题、核心数据、正文。
- `text-secondary` (#4D515C)：次级标题、描述文本。
- `text-tertiary` (#878A94)：占位符、辅助说明、时间戳。

### 2.4 语义色 (Semantic)
- `text-success` (#009951)：成功状态、在线指示。
- `text-warning` (#E68A00)：警告状态、部分成功。
- `text-danger` (#E02433)：错误状态、离线指示、删除操作。

## 3. 排版系统 (Typography)
- **正文 (Sans)**：`font-sans` (Inter, -apple-system, PingFang SC)。
- **等宽 (Mono)**：`font-mono` (JetBrains Mono, SF Mono)。**必须**用于运单号、日志时间戳、代码片段。

## 4. 核心组件模式 (Component Patterns)
本项目采用 Tailwind 原子类 + 全局 CSS Class 混合模式。

### 4.1 面板与卡片 (Panel)
用于包裹独立的功能区块。
```tsx
<div className="panel">
  <div className="panel-head">
    <h3 className="text-primary font-semibold">任务概览</h3>
    <span className="panel-badge">运行中</span>
  </div>
  <div className="panel-body">
    {/* 内容区 */}
  </div>
</div>
```

### 4.2 按钮 (Buttons)
- **主 CTA 按钮** (全宽黑底/蓝底白字，带 hover 上浮)：
  `<button className="launch-btn">开始执行</button>`
- **次级/幽灵按钮** (白底灰边框)：
  `<button className="btn-ghost">取消</button>`
- **小型操作按钮** (带图标)：
  `<button className="btn-sm"><Icon /> 刷新</button>`

### 4.3 状态标签 (Pills & Badges)
- **窗口在线标签** (带状态点)：
  `<span className="window-pill online"><span className="pip"></span>张三 (CDP-1)</span>`
- **执行概览药丸** (顶栏状态)：
  `<span className="exec-summary visible">正在派件... 120/500</span>`

## 5. 布局规范 (Layout Skeleton)
页面必须严格遵循以下三栏/四区结构：

- **顶栏 (`.topbar`)**：固定高度 `h-header` (48px)。包含品牌区、中部状态区、右侧窗口标签区。
- **侧边栏 (`.sidebar-comp`)**：固定宽度 `w-sidebar` (200px)。包含导航分组和底部 Profile。
- **主内容区 (`.main`)**：`flex: 1`, `overflow-y: auto`, 背景色 `bg-surface-bg`。
- **底部状态栏 (`.statusbar`)**：固定高度 `h-statusbar` (26px)。包含系统连接状态和等宽字体信息。
