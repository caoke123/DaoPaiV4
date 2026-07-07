import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 使用 Node.js 环境（后端测试）
    environment: 'node',
    // 测试超时 10 秒（模拟超时用 500ms，正常测试不超 5 秒）
    testTimeout: 10_000,
    // 全局设置
    globals: false,
    // 排除归档文件、编译输出和非 Vitest 格式测试文件
    exclude: [
      'archive/**',
      'dist/**',
      'backend/**/__tests__/arriveScanResult.test.ts',   // tsx 格式，独立运行
      'backend/**/__tests__/dispatchScanResult.test.ts',  // tsx 格式，独立运行
      'backend/**/__tests__/WindowLockManager.test.ts',   // tsx 格式，独立运行
      '**/node_modules/**',
    ],
  },
});
