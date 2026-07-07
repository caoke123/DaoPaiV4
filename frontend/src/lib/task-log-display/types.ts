// types — Task Log Display 类型定义
// Phase L-1A-Fix: 前端实时日志中文化与聚合展示

/** 业务任务类型 */
export type TaskType = 'arrival' | 'dispatch' | 'integrated' | 'sign';

/** 原始日志（来自 API TaskLogEntry，不做任何修改） */
export interface RawTaskLog {
  id: string;
  taskId: string;
  timestamp: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  source: string;
  staffName?: string;
  windowId?: string;
}

/** 展示层日志（翻译 + 聚合后） */
export interface DisplayTaskLog {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  /** 中文展示标题 */
  title: string;
  /** 可选补充说明 */
  detail?: string;
  /** 日志分类 */
  category: 'business' | 'runtime' | 'navigator' | 'guard' | 'unknown';
  /** 默认视图是否可见 */
  defaultVisible: boolean;
  /** 原始日志引用（不可变） */
  raw: RawTaskLog;
  /** 聚合子日志 */
  children?: DisplayTaskLog[];
}
