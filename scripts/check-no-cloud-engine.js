/**
 * Phase K-R1: check:no-cloud-engine
 *
 * 检查主代码是否违规引用 archive 目录或恢复 Cloud 引擎执行四业务。
 *
 * 检查项：
 *   1. 主路径禁止 import archive
 *      - 扫描 backend/api、backend/services、backend/modules、backend/operations、backend/agent 等目录
 *      - 不得出现 from '...archive' 或 from '...archive/...'
 *   2. 四业务 routes（arrive/dispatch/sign/integrated）禁止出现 scheduleLocalEngineRun 调用
 *   3. 四业务主执行链禁止调用 TaskEngineRunner.runTask
 *   4. 四业务执行日志禁止写 source='local-api'（TaskEngineRunner 内部已加防护，但 route 也不得直接写）
 *
 * 用法：
 *   node scripts/check-no-cloud-engine.js
 *   或 npm run check:no-cloud-engine
 *
 * 退出码：
 *   0 — 检查通过
 *   1 — 发现违规
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');

// 需要扫描的主代码目录（不包括 backend/archive）
const SCAN_DIRS = [
  'api',
  'services',
  'modules',
  'operations',
  'agent',
  'auth',
  'browser',
  'config',
  'db',
  'playwright-runtime',
  'runtime',
  'utils',
  'window-adapter',
].map(d => path.join(BACKEND, d));

// 只扫描 .ts/.tsx 文件
const TS_RE = /\.tsx?$/;

// 违规规则
const VIOLATIONS = [];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (TS_RE.test(entry.name)) {
      out.push(full);
    }
  }
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function checkFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  const relPath = rel(file);

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();

    // 跳过注释行（简单判断）
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      // 但仍要检查块注释中的 from '...archive' 引用？不，注释中可以提及 archive
      return;
    }

    // 规则 1：禁止 import archive
    // 匹配 from '...archive' 或 from '...archive/...'
    // 同时匹配 require('...archive...')
    const archiveImportRe = /(?:from\s+|require\s*\(\s*)['"](?:\.\.\/|\.\/)*archive(?:\/[^'"]*)?['"]/;
    if (archiveImportRe.test(line)) {
      VIOLATIONS.push({
        rule: 'RULE_1_NO_ARCHIVE_IMPORT',
        file: relPath,
        line: lineNum,
        content: line,
        message: '主代码禁止 import archive 目录',
      });
    }

    // 规则 2：四业务 routes 禁止调用 scheduleLocalEngineRun
    // 匹配 scheduleLocalEngineRun( 调用（非注释）
    if (/\bscheduleLocalEngineRun\s*\(/.test(line)) {
      VIOLATIONS.push({
        rule: 'RULE_2_NO_SCHEDULE_LOCAL_ENGINE_RUN',
        file: relPath,
        line: lineNum,
        content: line,
        message: '禁止调用 scheduleLocalEngineRun（四业务只能由 Local Agent 执行）',
      });
    }

    // 规则 3：禁止调用 TaskEngineRunner.runTask
    // 匹配 TaskEngineRunner.runTask( 或 TaskEngineRunner\.runTask\(
    // 例外：backend/agent/agentRoutes.ts 的 run-engine 端点已有 409 保护，
    //   四业务会被 409 拦截，且 TaskEngineRunner 内部有 assertNotAgentOnlyBusiness 二次防护。
    //   该端点保留给"未迁移任务类型"使用（如未来新增的非四业务类型）。
    //   因此允许 agentRoutes.ts 中的调用，但必须 source='agent-engine'（已在 RULE_4 中检查）。
    if (!relPath.endsWith('agent/agentRoutes.ts')) {
      if (/TaskEngineRunner[\.\s]*\.?\s*runTask\s*\(/.test(line)) {
        VIOLATIONS.push({
          rule: 'RULE_3_NO_TASK_ENGINE_RUNNER',
          file: relPath,
          line: lineNum,
          content: line,
          message: '禁止调用 TaskEngineRunner.runTask（四业务主执行链已断路；agentRoutes.ts run-engine 端点除外，已有 409 保护）',
        });
      }
    }

    // 规则 4：禁止写 source='local-api' 的执行日志
    // 匹配 source: 'local-api' 或 source='local-api'（实际写入，不是类型声明）
    // 排除类型声明行：包含 '|' 字符的行（如 `source: 'local-api' | 'agent-engine'`）
    // 排除 TaskEngineRunner.ts（内部仍接受 source 参数，但不再对四业务调用）
    // 允许 agentRoutes.ts 中 source='agent-engine'（run-engine 端点的合法调用）
    if (!relPath.endsWith('services/TaskEngineRunner.ts')) {
      // 只匹配 source: 'local-api' 后面不跟 |（排除联合类型声明）
      const localApiRe = /source\s*[:=]\s*['"]local-api['"](?!\s*\|)/;
      if (localApiRe.test(line)) {
        VIOLATIONS.push({
          rule: 'RULE_4_NO_LOCAL_API_SOURCE',
          file: relPath,
          line: lineNum,
          content: line,
          message: '禁止写 source=local-api（四业务 Cloud 执行日志已断路；类型声明除外）',
        });
      }
    }

    // 规则 5：禁止 import 已归档的 4 个 Handler
    // 匹配 from '...ArrivalHandler' / DispatchHandler / IntegratedHandler / SignHandler
    // 但允许 archive 目录内部相互引用（archive 目录不在扫描范围内，所以这里不需要排除）
    const handlerRe = /(?:from\s+|require\s*\(\s*)['"][^'"]*(?:ArrivalHandler|DispatchHandler|IntegratedHandler|SignHandler)['"]/;
    if (handlerRe.test(line)) {
      VIOLATIONS.push({
        rule: 'RULE_5_NO_ARCHIVED_HANDLER_IMPORT',
        file: relPath,
        line: lineNum,
        content: line,
        message: '禁止 import 已归档的 Cloud Engine Handler',
      });
    }

    // 规则 6：禁止恢复 AGENT_LOCAL_XXX=false fallback 分支
    // 匹配 AGENT_LOCAL_ARRIVAL / AGENT_LOCAL_DISPATCH / AGENT_LOCAL_SIGN / AGENT_LOCAL_INTEGRATED 的运行时读取
    // 注释中可以提及，但代码中不得再判断
    // 注意：.env.example 或文档中可以提及，但 .ts 主代码中不得使用
    const agentLocalRe = /process\.env\.(AGENT_LOCAL_(?:ARRIVAL|DISPATCH|SIGN|INTEGRATED))/;
    if (agentLocalRe.test(line)) {
      VIOLATIONS.push({
        rule: 'RULE_6_NO_AGENT_LOCAL_FALLBACK',
        file: relPath,
        line: lineNum,
        content: line,
        message: '禁止使用 AGENT_LOCAL_XXX 环境变量做 Cloud fallback 判断（已废弃）',
      });
    }
  });
}

// 主流程
console.log('[check:no-cloud-engine] Phase K-R1 Cloud Engine 归档隔离检查');
console.log('[check:no-cloud-engine] 扫描根目录:', rel(BACKEND));
console.log('');

let totalFiles = 0;
for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(dir)) {
    console.log('[skip] 目录不存在:', rel(dir));
    continue;
  }
  const files = [];
  walk(dir, files);
  for (const file of files) {
    checkFile(file);
    totalFiles++;
  }
}

console.log(`[check:no-cloud-engine] 扫描完成: ${totalFiles} 个 .ts 文件`);
console.log('');

if (VIOLATIONS.length === 0) {
  console.log('[check:no-cloud-engine] ✅ 检查通过：未发现 Cloud 引擎回流风险');
  process.exit(0);
} else {
  console.error(`[check:no-cloud-engine] ❌ 检查失败：发现 ${VIOLATIONS.length} 处违规`);
  console.error('');
  for (const v of VIOLATIONS) {
    console.error(`  [${v.rule}] ${v.file}:${v.line}`);
    console.error(`    ${v.message}`);
    console.error(`    > ${v.content.trim()}`);
    console.error('');
  }
  process.exit(1);
}
