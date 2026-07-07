// === Mock Data for Application Shell V2 ===
// All data is static mock. No API calls.

export interface NavItem {
  key: string;
  label: string;
  icon?: string;
  path?: string;
  type: 'item' | 'section' | 'separator';
  /** Phase 3-G-2: 仅指定角色可见，不传则所有角色可见 */
  roles?: string[];
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'sec-exec',   label: '执行中心',  type: 'section' },
  { key: 'arrival',    label: '到件扫描',    icon: 'PackageOpen',       path: '/arrival',    type: 'item' },
  { key: 'dispatch',   label: '派件扫描',    icon: 'Truck',             path: '/dispatch',   type: 'item' },
  { key: 'integrated', label: '到派一体',    icon: 'Combine',           path: '/integrated', type: 'item' },
  { key: 'sign',       label: '签收录入',    icon: 'ClipboardCheck',    path: '/sign',       type: 'item' },
  { key: 'sep-1',      label: '',           type: 'separator' },
  { key: 'sec-mon',    label: '监控中心',  type: 'section' },
  { key: 'tasks',      label: '任务中心',    icon: 'LayoutList',        path: '/tasks',      type: 'item' },
  { key: 'sep-2',      label: '',           type: 'separator' },
  { key: 'sec-sys',    label: '系统',      type: 'section', roles: ['super_admin', 'tenant_admin'] },
  { key: 'system',     label: '系统管理',    icon: 'MonitorCog',        path: '/system',      type: 'item', roles: ['super_admin', 'tenant_admin'] },
  { key: 'settings',   label: '设置中心',    icon: 'Settings',          path: '/settings',   type: 'item', roles: ['super_admin', 'tenant_admin'] },
];

export interface MockUser {
  name: string;
  role: string;
  avatar: string;
}

export const MOCK_USER: MockUser = {
  name: '张伟',
  role: '操作员',
  avatar: '张',
};

export interface MockBranch {
  name: string;
  code: string;
}

export const MOCK_BRANCH: MockBranch = {
  name: '天津分拨中心',
  code: 'TJ-ND-01',
};

export interface MockOperatorStatus {
  status: 'idle' | 'running' | 'error';
  label: string;
  activeTask?: string;
}

export const MOCK_OPERATOR: MockOperatorStatus = {
  status: 'idle',
  label: '就绪',
};

export const MOCK_NOTIFICATIONS = {
  count: 2,
  items: [
    { id: 1, text: '批次扫描完成：142件', time: '2分钟前', type: 'success' as const },
    { id: 2, text: '新任务分配：A线', time: '15分钟前', type: 'info' as const },
  ],
};

export interface MockStat {
  label: string;
  value: string;
  sub?: string;
  trend?: 'up' | 'down' | 'flat';
  trendValue?: string;
}

export const MOCK_STATS: MockStat[] = [
  { label: '今日扫描',      value: '1,247',  trend: 'up',   trendValue: '+12%' },
  { label: '成功率',         value: '99.4%',  trend: 'flat', trendValue: '±0.1%' },
  { label: '活跃任务',      value: '3',      sub: '/ 共12个' },
  { label: '平均响应',      value: '0.8秒',   trend: 'down', trendValue: '-0.2秒' },
];

export interface MockTask {
  id: string;
  title: string;
  route: string;
  progress: number;
  total: number;
  done: number;
  status: 'active' | 'queued' | 'done' | 'error';
}

export const MOCK_TASKS: MockTask[] = [
  { id: 'T-1042', title: 'A线派件',     route: 'TJ-A', progress: 75, total: 48, done: 36, status: 'active' },
  { id: 'T-1041', title: 'B线派件',     route: 'TJ-B', progress: 0,  total: 32, done: 0,  status: 'queued' },
  { id: 'T-1040', title: '第56批到件',   route: 'INB',  progress: 100,total: 56, done: 56, status: 'done' },
  { id: 'T-1039', title: 'C线派件',     route: 'TJ-C', progress: 22, total: 28, done: 6,  status: 'active' },
  { id: 'T-1038', title: '第12批签收',   route: 'SIGN', progress: 90, total: 20, done: 18, status: 'active' },
];

// === Arrival Scan Mock Data ===

export interface ArrivalWaybill {
  barcode: string;
  status: 'valid' | 'exception';
  reason?: string;
}

export const MOCK_ARRIVAL_WAYBILLS: ArrivalWaybill[] = [
  { barcode: '75001234567', status: 'valid' },
  { barcode: '75001234568', status: 'valid' },
  { barcode: '75001234569', status: 'valid' },
  { barcode: '75001234570', status: 'valid' },
  { barcode: '75001234571', status: 'valid' },
  { barcode: '75001234572', status: 'exception', reason: '运单不存在' },
  { barcode: '75001234573', status: 'valid' },
  { barcode: '75001234574', status: 'valid' },
  { barcode: '75001234575', status: 'exception', reason: '重复运单' },
  { barcode: '75001234576', status: 'valid' },
  { barcode: '75001234577', status: 'valid' },
  { barcode: '75001234578', status: 'exception', reason: '网点不匹配' },
  { barcode: '75001234579', status: 'valid' },
  { barcode: '75001234580', status: 'valid' },
  { barcode: '75001234581', status: 'exception', reason: '运单已签收' },
  { barcode: '75001234582', status: 'valid' },
  { barcode: '75001234583', status: 'exception', reason: '运单状态异常' },
  { barcode: '75001234584', status: 'valid' },
  { barcode: '75001234585', status: 'valid' },
  { barcode: '75001234586', status: 'valid' },
];

export interface ArrivalStats {
  total: number;
  valid: number;
  exception: number;
  exceptions: ArrivalWaybill[];
}

export function getArrivalStats(): ArrivalStats {
  const valid = MOCK_ARRIVAL_WAYBILLS.filter(w => w.status === 'valid');
  const exception = MOCK_ARRIVAL_WAYBILLS.filter(w => w.status === 'exception');
  return {
    total: MOCK_ARRIVAL_WAYBILLS.length,
    valid: valid.length,
    exception: exception.length,
    exceptions: exception,
  };
}

export interface ExecutionStatus {
  progress: number;
  total: number;
  done: number;
  success: number;
  failed: number;
  remaining: number;
  eta: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
}

export const MOCK_EXECUTION: ExecutionStatus = {
  progress: 65,
  total: 530,
  done: 345,
  success: 335,
  failed: 10,
  remaining: 185,
  eta: '14:24:11',
  status: 'running',
};

export interface MockLogEntry {
  id: number;
  timestamp: string;
  type: 'success' | 'warning' | 'error' | 'info';
  barcode: string;
  message: string;
}

export function generateArrivalLogs(count: number = 30): MockLogEntry[] {
  const successMessages = ['到件成功', '到件成功', '到件成功', '到件成功', '到件成功'];
  const warningMessages = ['重复扫描，已跳过'];
  const errorMessages = ['运单不存在', '网点不匹配', '运单已签收'];
  const infoMessages = ['开始扫描批次', '扫描完成，等待上传'];

  const logs: MockLogEntry[] = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const time = new Date(now.getTime() - i * 1200);
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    const ss = String(time.getSeconds()).padStart(2, '0');
    const ts = `${hh}:${mm}:${ss}`;

    let type: MockLogEntry['type'];
    let message: string;
    const roll = i % 20;

    if (roll < 14) {
      type = 'success';
      message = successMessages[i % successMessages.length];
    } else if (roll < 16) {
      type = 'warning';
      message = warningMessages[i % warningMessages.length];
    } else if (roll < 18) {
      type = 'error';
      message = errorMessages[i % errorMessages.length];
    } else {
      type = 'info';
      message = infoMessages[i % infoMessages.length];
    }

    logs.push({
      id: count - i,
      timestamp: ts,
      type,
      barcode: `750012${String(34500 + count - i)}`,
      message,
    });
  }

  return logs;
}

export const MOCK_ARRIVAL_LOGS = generateArrivalLogs(30);

export const MOCK_LOGS = generateArrivalLogs(50);

// Mock streaming: returns logs one at a time with delay
export function* mockLogStream(): Generator<MockLogEntry, void, unknown> {
  for (const log of MOCK_LOGS) {
    yield log;
  }
}

// === Upload Mock ===

export interface MockUploadFile {
  id: number;
  name: string;
  size: string;
  type: string;
}

export const MOCK_UPLOAD_FILES: MockUploadFile[] = [
  { id: 1, name: '到件清单_20260618.xlsx', size: '48KB', type: 'Excel' },
];

// === Dispatch Scan Mock Data ===

export interface DispatchOperator {
  id: string;
  name: string;
  window: string;
  totalAssigned: number;
  assignedBarcodes: string[];
  completed: number;
  success: number;
  failed: number;
  status: 'waiting' | 'running' | 'completed' | 'error';
}

export const MOCK_DISPATCH_OPERATORS: DispatchOperator[] = [
  { id: 'OP01', name: '张三', window: '窗口1', totalAssigned: 138, assignedBarcodes: [], completed: 0, success: 0, failed: 0, status: 'waiting' },
  { id: 'OP02', name: '李四', window: '窗口2', totalAssigned: 126, assignedBarcodes: [], completed: 0, success: 0, failed: 0, status: 'waiting' },
  { id: 'OP03', name: '王五', window: '窗口3', totalAssigned: 134, assignedBarcodes: [], completed: 0, success: 0, failed: 0, status: 'waiting' },
  { id: 'OP04', name: '赵六', window: '窗口4', totalAssigned: 132, assignedBarcodes: [], completed: 0, success: 0, failed: 0, status: 'waiting' },
];

export function getDispatchStats() {
  return {
    totalWaybills: 530,
    operatorCount: 4,
    windowCount: 4,
    estimatedTime: '2分30秒',
  };
}

export function getDispatchStrategy() {
  return {
    name: '平均随机分配',
    description: '系统将自动平均分配运单，并加入随机阈值平衡任务量。',
  };
}

export function generateDispatchBarcodes(count: number = 530): string[] {
  const barcodes: string[] = [];
  for (let i = 0; i < count; i++) {
    barcodes.push(`8800${String(1000000 + i).slice(0, 7)}`);
  }
  return barcodes;
}

export function getOperatorBarcodes(operator: DispatchOperator, allBarcodes: string[], startIndex: number): string[] {
  return allBarcodes.slice(startIndex, startIndex + operator.totalAssigned);
}

export const MOCK_DISPATCH_ALL_BARCODES = generateDispatchBarcodes(530);

export interface DispatchLogEntry {
  id: number;
  timestamp: string;
  operator: string;
  barcode: string;
  type: 'success' | 'warning' | 'error' | 'info';
  message: string;
}

export function generateDispatchLogs(count: number = 40): DispatchLogEntry[] {
  const operators = ['张三', '李四', '王五', '赵六'];
  const successMessages = ['派件成功', '派件成功', '派件成功', '派件成功', '派件成功'];
  const warningMessages = ['重复扫描，已跳过'];
  const errorMessages = ['运单不存在', '网点不匹配', '运单状态异常'];
  const infoMessages = [`派件员 张三 正在派件`, `派件员 李四 正在派件`, `派件员 王五 正在派件`, `派件员 赵六 正在派件`, '所有运单已分配完毕', '派件批次开始'];

  const logs: DispatchLogEntry[] = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const time = new Date(now.getTime() - i * 1500);
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    const ss = String(time.getSeconds()).padStart(2, '0');
    const ts = `${hh}:${mm}:${ss}`;
    const operator = operators[i % operators.length];

    let type: DispatchLogEntry['type'];
    let message: string;
    const roll = i % 20;

    if (roll === 0) {
      type = 'info';
      message = `派件员 ${operator} 正在派件`;
    } else if (roll < 14) {
      type = 'success';
      message = successMessages[i % successMessages.length];
    } else if (roll < 16) {
      type = 'warning';
      message = warningMessages[i % warningMessages.length];
    } else if (roll < 18) {
      type = 'error';
      message = errorMessages[i % errorMessages.length];
    } else {
      type = 'info';
      message = infoMessages[Math.floor(Math.random() * infoMessages.length)];
    }

    logs.push({
      id: count - i,
      timestamp: ts,
      operator,
      barcode: `8800${String(2000000 + count - i).slice(0, 7)}`,
      type,
      message,
    });
  }

  return logs;
}

export const MOCK_DISPATCH_LOGS = generateDispatchLogs(40);

// === Sign Receive Mock Data ===

export interface SignCourier {
  id: string;
  name: string;
  pending: number;
  status: 'dispatching' | 'signing' | 'completed';
  barcodes: string[];
}

export function generateSignBarcodes(start: number, count: number): string[] {
  const barcodes: string[] = [];
  for (let i = 0; i < count; i++) {
    barcodes.push(`9900${String(3000000 + start + i).slice(0, 7)}`);
  }
  return barcodes;
}

export const MOCK_SIGN_COURIERS: SignCourier[] = [
  { id: 'OP01', name: '张三', pending: 138, status: 'dispatching', barcodes: generateSignBarcodes(0, 138) },
  { id: 'OP02', name: '李四', pending: 126, status: 'dispatching', barcodes: generateSignBarcodes(138, 126) },
  { id: 'OP03', name: '王五', pending: 134, status: 'dispatching', barcodes: generateSignBarcodes(264, 134) },
  { id: 'OP04', name: '赵六', pending: 132, status: 'dispatching', barcodes: generateSignBarcodes(398, 132) },
];

export function getSignOverview() {
  const totalPending = MOCK_SIGN_COURIERS.reduce((s, c) => s + c.pending, 0);
  return {
    dispatchingCouriers: MOCK_SIGN_COURIERS.filter(c => c.status === 'dispatching').length,
    totalPending,
    todaySigned: 247,
    exceptions: 3,
  };
}

export interface SignLogEntry {
  id: number;
  timestamp: string;
  courier: string;
  barcode: string;
  type: 'success' | 'warning' | 'error' | 'info';
  message: string;
}

export function generateSignLogs(count: number = 30): SignLogEntry[] {
  const couriers = ['张三', '李四', '王五', '赵六'];
  const successMessages = ['签收成功', '签收成功', '签收成功', '签收成功', '签收成功'];
  const warningMessages = ['重复签收，已跳过'];
  const errorMessages = ['运单不存在', '运单未派件', '运单状态异常'];
  const infoMessages = ['开始批量签收', `快递员 张三 签收中`, `快递员 李四 签收中`, `快递员 王五 签收中`, `快递员 赵六 签收中`];

  const logs: SignLogEntry[] = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const time = new Date(now.getTime() - i * 1800);
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    const ss = String(time.getSeconds()).padStart(2, '0');
    const ts = `${hh}:${mm}:${ss}`;
    const courier = couriers[i % couriers.length];

    let type: SignLogEntry['type'];
    let message: string;
    const roll = i % 20;

    if (roll === 0) {
      type = 'info';
      message = `快递员 ${courier} 签收中`;
    } else if (roll < 14) {
      type = 'success';
      message = successMessages[i % successMessages.length];
    } else if (roll < 16) {
      type = 'warning';
      message = warningMessages[i % warningMessages.length];
    } else if (roll < 18) {
      type = 'error';
      message = errorMessages[i % errorMessages.length];
    } else {
      type = 'info';
      message = infoMessages[Math.floor(Math.random() * infoMessages.length)];
    }

    logs.push({
      id: count - i,
      timestamp: ts,
      courier,
      barcode: `9900${String(3000000 + count - i).slice(0, 7)}`,
      type,
      message,
    });
  }

  return logs;
}

export const MOCK_SIGN_LOGS = generateSignLogs(30);

// === Task Center Mock Data ===

export type BatchStatus = 'completed' | 'executing' | 'not_started' | 'error';

export interface BatchTaskStep {
  name: string;
  status: BatchStatus;
  total?: number;
  success?: number;
  failed?: number;
}

export interface BatchCard {
  id: string;
  name: string;
  totalWaybills: number;
  createdAt: string;
  steps: BatchTaskStep[];
  currentProgress?: number;
  anomalyCount: number;
}

export const MOCK_BATCHES: BatchCard[] = [
  {
    id: 'BATCH-0620-M',
    name: '第一批次',
    totalWaybills: 530,
    createdAt: '2026-06-18 08:30',
    steps: [
      { name: '到件扫描', status: 'completed', total: 530, success: 528, failed: 2 },
      { name: '派件扫描', status: 'completed', total: 530, success: 530, failed: 0 },
      { name: '签收录入', status: 'completed', total: 530, success: 525, failed: 5 },
    ],
    anomalyCount: 0,
  },
  {
    id: 'BATCH-0620-A',
    name: '第二批次',
    totalWaybills: 480,
    createdAt: '2026-06-18 14:00',
    steps: [
      { name: '到件扫描', status: 'completed', total: 480, success: 478, failed: 2 },
      { name: '派件扫描', status: 'completed', total: 480, success: 475, failed: 5 },
      { name: '签收录入', status: 'executing', total: 480, success: 0, failed: 0 },
    ],
    currentProgress: 78,
    anomalyCount: 5,
  },
  {
    id: 'BATCH-0618-E',
    name: '第三批次',
    totalWaybills: 620,
    createdAt: '2026-06-18 18:00',
    steps: [
      { name: '到件扫描', status: 'completed', total: 620, success: 618, failed: 2 },
      { name: '派件扫描', status: 'error', total: 620, success: 580, failed: 40 },
      { name: '签收录入', status: 'not_started' },
    ],
    anomalyCount: 12,
  },
  {
    id: 'BATCH-0619-A',
    name: '第四批次',
    totalWaybills: 450,
    createdAt: '2026-06-19 08:15',
    steps: [
      { name: '到件扫描', status: 'completed', total: 450, success: 448, failed: 2 },
      { name: '派件扫描', status: 'completed', total: 450, success: 445, failed: 5 },
      { name: '签收录入', status: 'completed', total: 450, success: 442, failed: 8 },
    ],
    anomalyCount: 3,
  },
  {
    id: 'BATCH-0619-B',
    name: '第五批次',
    totalWaybills: 390,
    createdAt: '2026-06-19 10:30',
    steps: [
      { name: '到件扫描', status: 'completed', total: 390, success: 388, failed: 2 },
      { name: '派件扫描', status: 'executing', total: 390, success: 120, failed: 3 },
      { name: '签收录入', status: 'not_started' },
    ],
    currentProgress: 42,
    anomalyCount: 7,
  },
  {
    id: 'BATCH-0619-C',
    name: '第六批次',
    totalWaybills: 510,
    createdAt: '2026-06-19 13:00',
    steps: [
      { name: '到件扫描', status: 'executing', total: 510, success: 300, failed: 1 },
      { name: '派件扫描', status: 'not_started' },
      { name: '签收录入', status: 'not_started' },
    ],
    currentProgress: 35,
    anomalyCount: 1,
  },
  {
    id: 'BATCH-0619-D',
    name: '第七批次',
    totalWaybills: 380,
    createdAt: '2026-06-19 15:00',
    steps: [
      { name: '到件扫描', status: 'not_started' },
      { name: '派件扫描', status: 'not_started' },
      { name: '签收录入', status: 'not_started' },
    ],
    anomalyCount: 0,
  },
];

export interface AnomalyCategory {
  label: string;
  count: number;
  barcodes: string[];
  source: 'arrival' | 'dispatch' | 'sign';
}

export const MOCK_ANOMALIES: AnomalyCategory[] = [
  {
    label: '运单不存在',
    count: 8,
    barcodes: ['75001234572', '75002456321', '75003451287', '75004789321', '75005234190', '75006123001', '75007123002', '75008123003'],
    source: 'arrival',
  },
  {
    label: '派件失败',
    count: 12,
    barcodes: ['88002345671', '88002345672', '88002345673', '88002345679', '88003345001', '88003345002', '88003345003', '88003345004', '88003345005', '88003345006', '88003345007', '88003345008'],
    source: 'dispatch',
  },
  {
    label: '签收失败',
    count: 8,
    barcodes: ['99003000012', '99003000045', '99003000078', '99004000001', '99004000002', '99004000003', '99004000004', '99004000005'],
    source: 'sign',
  },
];

export interface TaskEvent {
  id: number;
  timestamp: string;
  batch: string;
  step: string;
  status: 'executing' | 'completed' | 'error';
}

export const MOCK_TASK_EVENTS: TaskEvent[] = [
  { id: 1, timestamp: '15:21', batch: '第二批次', step: '签收录入', status: 'executing' },
  { id: 2, timestamp: '15:12', batch: '第二批次', step: '派件扫描', status: 'completed' },
  { id: 3, timestamp: '14:32', batch: '第一批次', step: '签收录入', status: 'completed' },
  { id: 4, timestamp: '13:05', batch: '第一批次', step: '派件扫描', status: 'completed' },
  { id: 5, timestamp: '11:42', batch: '第一批次', step: '到件扫描', status: 'completed' },
  { id: 6, timestamp: '18:05', batch: '第三批次', step: '到件扫描', status: 'completed' },
  { id: 7, timestamp: '18:10', batch: '第三批次', step: '派件扫描', status: 'error' },
];

// === Settings Page Mock Data ===

/** 窗口凭据（Base64 编码密码用于 mock 展示） */
export interface MockWindowCredential {
  windowName: string;
  employeeName: string;
  username: string;
  password: string; // Base64 编码的密码
}

/** 网点配置 */
export interface MockSiteConfig {
  id: string;
  name: string;
  windows: MockWindowCredential[];
}

/** Mock 设置配置 — 2 个网点，天南大 3 个窗口、和苑 2 个窗口 */
export const MOCK_SETTINGS_CONFIG: MockSiteConfig[] = [
  {
    id: 'tiannanda',
    name: '天南大网点',
    windows: [
      { windowName: 'CDP-1', employeeName: '孟德海', username: 'mengdehai', password: btoa('meng@2024') },
      { windowName: 'CDP-2', employeeName: '刘磊', username: 'liulei', password: btoa('liu@2024') },
      { windowName: 'CDP-3', employeeName: '肖飞', username: 'xiaofei', password: btoa('xiao@2024') },
    ],
  },
  {
    id: 'heyuan',
    name: '和苑网点',
    windows: [
      { windowName: 'CDP-4', employeeName: '张三', username: 'zhangsan', password: btoa('zhang@2024') },
      { windowName: 'CDP-5', employeeName: '李四', username: 'lisi', password: btoa('li@2024') },
    ],
  },
];

/** Mock 管理员 PIN 码（Base64 编码，默认 "123456"） */
export const MOCK_SETTINGS_PIN = btoa('123456');

/** 系统是否已初始化（Mock 模式默认 true：配置已存在） */
export const MOCK_SETTINGS_INITIALIZED = true;
