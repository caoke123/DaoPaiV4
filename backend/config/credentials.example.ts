// 笨鸟速运网点系统登录凭据配置
// EasyBR 窗口已保存账号密码，此文件仅用于记录和自动登录时的账号匹配
//
// ★ 使用说明：
//   1. 复制此文件为 credentials.ts
//   2. 填入真实员工凭据（或留空 password，仅用 settings.json 作为真理源）
//   3. credentials.ts 已在 .gitignore 中排除，不会被提交
//   4. 推荐做法：通过设置中心 UI 配置窗口凭据，写入 data/settings.json（Base64 编码）
//      credentials.ts 仅作为 settings.json 不可用时的兜底

export interface StaffCredential {
  /** 员工姓名（与 EasyBR 窗口名称匹配） */
  name: string;
  /** 登录账号 */
  account: string;
  /** 登录密码（请替换为真实数据，或留空仅用 settings.json） */
  password: string;
}

/** 天南大网点员工凭据（请替换为真实数据） */
export const TIANNANDA_CREDENTIALS: StaffCredential[] = [
  { name: '员工A', account: 'ACCOUNT_A', password: 'PASSWORD_A' },
  { name: '员工B', account: 'ACCOUNT_B', password: 'PASSWORD_B' },
  { name: '员工C', account: 'ACCOUNT_C', password: 'PASSWORD_C' },
];

/** 和苑网点员工凭据（请替换为真实数据） */
export const HEYUAN_CREDENTIALS: StaffCredential[] = [
  { name: '员工D', account: 'ACCOUNT_D', password: 'PASSWORD_D' },
];

/** 根据员工姓名查找凭据（跨所有网点搜索） */
export function findCredential(staffName: string): StaffCredential | undefined {
  return TIANNANDA_CREDENTIALS.find(c => c.name === staffName)
      ?? HEYUAN_CREDENTIALS.find(c => c.name === staffName);
}
