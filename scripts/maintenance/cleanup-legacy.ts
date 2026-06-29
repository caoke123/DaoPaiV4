#!/usr/bin/env npx tsx
/**
 * cleanup-legacy.ts — 历史遗留文件归档脚本
 *
 * 用途：将过期临时脚本、一次性辅助工具、历史设计文档安全移动到 archive/ 目录。
 *
 * 安全约束：
 *   1. 仅执行移动（rename），绝不删除（unlink）
 *   2. 移动前自动创建目标目录
 *   3. 源文件不存在时打印 WARN 并跳过，不崩溃
 *   4. 运行结束后打印清晰的执行报告
 *
 * 用法：
 *   npx tsx scripts/maintenance/cleanup-legacy.ts
 *
 * 注：从项目根目录（bnsy-operator-next/）运行。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 项目根目录（脚本所在目录向上两级） ──
const ROOT = path.resolve(__dirname, '..', '..');

// ── 归档清单：{ 源路径(相对根目录), 目标路径(相对根目录), 标签 } ──
interface ArchiveEntry {
  /** 相对于 ROOT 的源路径（文件或目录） */
  src: string;
  /** 相对于 ROOT 的目标路径 */
  dest: string;
  /** 人类可读标签（如 "临时脚本"） */
  label: string;
}

const ENTRIES: ArchiveEntry[] = [
  // ── 临时/废弃脚本 → archive/scripts/ ──
  { src: 'scripts/test-easybr-flow.ts', dest: 'archive/scripts/test-easybr-flow.ts', label: '废弃脚本' },
  { src: 'scripts/_temp_login_all_windows.ts', dest: 'archive/scripts/_temp_login_all_windows.ts', label: '废弃脚本' },
  { src: 'scripts/_temp_screenshots', dest: 'archive/scripts/_temp_screenshots', label: '废弃截图目录' },
  { src: 'scripts/get-logs.ps1', dest: 'archive/scripts/get-logs.ps1', label: '废弃脚本' },

  // ── 根目录一次性辅助工具 → archive/root-tools/ ──
  { src: 'cleanup.ts', dest: 'archive/root-tools/cleanup.ts', label: '根目录工具' },
  { src: 'collect-code.js', dest: 'archive/root-tools/collect-code.js', label: '根目录工具' },
  { src: 'debug-menu.ts', dest: 'archive/root-tools/debug-menu.ts', label: '根目录工具' },
  { src: 'explore-menu.ts', dest: 'archive/root-tools/explore-menu.ts', label: '根目录工具' },
  { src: 'extract-strings.ts', dest: 'archive/root-tools/extract-strings.ts', label: '根目录工具' },
  { src: 'generate-report.ts', dest: 'archive/root-tools/generate-report.ts', label: '根目录工具' },

  // ── 过期设计文档 → archive/docs/phase-d-design/ ──
  { src: '.trae/documents/Phase-D-1-任务1-EasyBRClient设计.md', dest: 'archive/docs/phase-d-design/Phase-D-1-任务1-EasyBRClient设计.md', label: '设计文档' },
  { src: '.trae/documents/Phase-D-1-任务2-EasyBR重构影响分析.md', dest: 'archive/docs/phase-d-design/Phase-D-1-任务2-EasyBR重构影响分析.md', label: '设计文档' },
  { src: '.trae/documents/Phase-D-1-任务3-WindowProfile设计方案.md', dest: 'archive/docs/phase-d-design/Phase-D-1-任务3-WindowProfile设计方案.md', label: '设计文档' },
  { src: '.trae/documents/Phase-D-1-任务4-选择器稳定性报告.md', dest: 'archive/docs/phase-d-design/Phase-D-1-任务4-选择器稳定性报告.md', label: '设计文档' },
  { src: '.trae/documents/Phase-D-2A-任务1-PopupManager设计.md', dest: 'archive/docs/phase-d-design/Phase-D-2A-任务1-PopupManager设计.md', label: '设计文档' },
  { src: '.trae/documents/Phase-D-2A-任务2-PageStateManager设计.md', dest: 'archive/docs/phase-d-design/Phase-D-2A-任务2-PageStateManager设计.md', label: '设计文档' },
  { src: '.trae/documents/Phase-D-2A-任务3-NavigationGovernance设计.md', dest: 'archive/docs/phase-d-design/Phase-D-2A-任务3-NavigationGovernance设计.md', label: '设计文档' },
  { src: '.trae/documents/Phase-D-1-任务5-审查报告.md', dest: 'archive/docs/phase-d-design/Phase-D-1-任务5-审查报告.md', label: '设计文档' },
  { src: '.trae/documents/debug-review-audit.md', dest: 'archive/docs/phase-d-design/debug-review-audit.md', label: '设计文档' },
];

// ── 结果收集 ──
const moved: string[] = [];
const skipped: string[] = [];

// ── 主流程 ──
console.log('══════════════════════════════════════════════');
console.log('  cleanup-legacy — 历史遗留文件归档');
console.log('══════════════════════════════════════════════');
console.log(`  根目录: ${ROOT}\n`);

for (const entry of ENTRIES) {
  const srcAbs = path.resolve(ROOT, entry.src);
  const destAbs = path.resolve(ROOT, entry.dest);
  const destDir = path.dirname(destAbs);

  // 1. 检查源是否存在
  if (!fs.existsSync(srcAbs)) {
    console.log(`  ⚠ WARN  [${entry.label}] 不存在，跳过: ${entry.src}`);
    skipped.push(entry.src);
    continue;
  }

  // 2. 确保目标目录存在
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    console.log(`  ✗ ERROR [${entry.label}] 创建目标目录失败: ${destDir}`);
    console.log(`         ${(e as Error).message}`);
    skipped.push(entry.src);
    continue;
  }

  // 3. 如果目标已存在，先移除旧目标（rename 要求目标不存在）
  if (fs.existsSync(destAbs)) {
    // 安全：仅当目标在 archive/ 下时才移除
    if (!destAbs.includes(path.sep + 'archive' + path.sep) && !destAbs.startsWith(path.resolve(ROOT, 'archive'))) {
      console.log(`  ✗ ERROR [${entry.label}] 目标不在 archive/ 内，拒绝覆盖: ${entry.dest}`);
      skipped.push(entry.src);
      continue;
    }
    try {
      const stat = fs.statSync(destAbs);
      if (stat.isDirectory()) {
        fs.rmSync(destAbs, { recursive: true, force: true });
      } else {
        fs.unlinkSync(destAbs);
      }
    } catch (e) {
      console.log(`  ✗ ERROR [${entry.label}] 移除旧目标失败: ${entry.dest}`);
      console.log(`         ${(e as Error).message}`);
      skipped.push(entry.src);
      continue;
    }
  }

  // 4. 移动（rename = 安全，非破坏性）
  try {
    fs.renameSync(srcAbs, destAbs);
    console.log(`  ✓ OK    [${entry.label}] ${entry.src}  →  ${entry.dest}`);
    moved.push(entry.src);
  } catch (e) {
    console.log(`  ✗ ERROR [${entry.label}] 移动失败: ${entry.src}`);
    console.log(`         ${(e as Error).message}`);
    skipped.push(entry.src);
  }
}

// ── 执行报告 ──
console.log('\n══════════════════════════════════════════════');
console.log('  执行报告');
console.log('══════════════════════════════════════════════');

if (moved.length > 0) {
  console.log(`\n  ✓ 成功移动 ${moved.length} 项:`);
  for (const f of moved) {
    console.log(`      ${f}`);
  }
} else {
  console.log('\n  ✓ 没有文件需要移动（已全部清理完成）');
}

if (skipped.length > 0) {
  console.log(`\n  ⚠ 跳过 ${skipped.length} 项（源文件不存在）:`);
  for (const f of skipped) {
    console.log(`      ${f}`);
  }
}

console.log('\n══════════════════════════════════════════════');
console.log('  归档完成。');
console.log('  这些文件现在位于 archive/ 目录中，可按需查看或 git rm。');
console.log('══════════════════════════════════════════════\n');
