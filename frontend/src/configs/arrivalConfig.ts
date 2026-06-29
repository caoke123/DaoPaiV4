// Arrival 任务页面配置
// Phase D-2B: 对应 ArrivalPage 业务，用于 UnifiedTaskPage
import type { TaskPageConfig } from '../components/task';

/**
 * 到件扫描配置
 *
 * 业务特征：
 *   - 单 Assignment（后端方案B 自动选择第一个在线 Worker）
 *   - 需要上一级网点选择
 *   - 无派件员选择
 *   - 无暂停/继续（当前后端 Engine 不支持 pause）
 */
export const arrivalConfig: TaskPageConfig = {
  type: 'arrival',
  title: '到件扫描',
  description: '批量扫描到件信息，自动识别并录入系统',
  submitApi: '/api/operations/arrive',
  features: {
    workerSelector: false,
    branchSelector: true,
    courierSelector: false,
    pauseResume: false,
  },
};
