// UnifiedTaskPage 配置类型定义
// Phase D-2B: 配置驱动的统一任务页面

/**
 * 任务页面配置
 *
 * 通过同一份 UnifiedTaskPage 组件 + 不同 TaskPageConfig 实现多业务页面。
 * 后端 AssignmentEngine 已统一 arrival/dispatch/integrated 三种类型，
 * 前端通过此配置对齐。
 */
export interface TaskPageConfig {
  /** 任务类型标识（对应后端 taskType） */
  type: 'arrival' | 'dispatch' | 'integrated' | 'sign' | 'return';

  /** 页面标题 */
  title: string;

  /** 页面描述 */
  description: string;

  /** 任务提交 API 路径（完整路径，如 /api/operations/arrive） */
  submitApi: string;

  /** 功能开关：控制页面局部组件的显隐 */
  features: {
    /** 多员工选择（dispatch/sign/integrated） */
    workerSelector?: boolean;
    /** 上一级网点选择（arrival/integrated） */
    branchSelector?: boolean;
    /** 派件员选择（dispatch/integrated） */
    courierSelector?: boolean;
    /** 暂停/继续按钮（全部任务类型） */
    pauseResume?: boolean;
  };
}
