import { STANDARD_SIGNERS, type SignerConfig } from '../config/signConfig';

export interface SignPlan {
  assignments: string[];
  counts: Record<string, number>;
  totalPages: number;
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function getSortedSigners(): SignerConfig[] {
  return [...STANDARD_SIGNERS].sort((a, b) => b.weight - a.weight);
}

function allocateQuotas(totalPages: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const signer of STANDARD_SIGNERS) {
    counts[signer.name] = 0;
  }

  if (totalPages <= 0) {
    return counts;
  }

  const signerCount = STANDARD_SIGNERS.length;
  const sorted = getSortedSigners();

  if (totalPages < signerCount) {
    for (let i = 0; i < totalPages; i++) {
      counts[sorted[i].name] = 1;
    }
    return counts;
  }

  let allocatedTotal = 0;
  const remainders: { name: string; remainder: number }[] = [];

  for (const signer of STANDARD_SIGNERS) {
    const exact = (signer.weight / 100) * totalPages;
    const floor = Math.floor(exact);
    const remainder = exact - floor;
    counts[signer.name] = floor;
    remainders.push({ name: signer.name, remainder });
    allocatedTotal += floor;
  }

  const remaining = totalPages - allocatedTotal;
  remainders.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < remaining; i++) {
    counts[remainders[i].name]++;
  }

  return counts;
}

function buildArrayFromCounts(counts: Record<string, number>): string[] {
  const result: string[] = [];
  for (const signer of STANDARD_SIGNERS) {
    const count = counts[signer.name] ?? 0;
    for (let i = 0; i < count; i++) {
      result.push(signer.name);
    }
  }
  return result;
}

export function generateAssignments(totalPages: number): string[] {
  if (totalPages <= 0) {
    return [];
  }

  const counts = allocateQuotas(totalPages);
  const ordered = buildArrayFromCounts(counts);
  const shuffled = fisherYatesShuffle(ordered);

  return shuffled;
}

export function generateSignPlan(totalPages: number): SignPlan {
  const assignments = generateAssignments(totalPages);
  const counts: Record<string, number> = {};
  for (const name of assignments) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return { assignments, counts, totalPages };
}

export function formatSignPlanLog(plan: SignPlan): string {
  const lines: string[] = [];
  lines.push('================================');
  lines.push('签收计划生成完成');
  lines.push(`总页数：${plan.totalPages}`);
  for (const signer of STANDARD_SIGNERS) {
    const count = plan.counts[signer.name] ?? 0;
    lines.push(`${signer.name}：${count}页`);
  }
  lines.push('================================');
  return lines.join('\n');
}
