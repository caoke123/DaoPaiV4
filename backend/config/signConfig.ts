export interface SignerConfig {
  name: string;
  weight: number;
}

export const STANDARD_SIGNERS: SignerConfig[] = [
  { name: '本人', weight: 50 },
  { name: '家人', weight: 15 },
  { name: '家门口', weight: 10 },
  { name: '代收点', weight: 25 },
];

const TOTAL_WEIGHT = STANDARD_SIGNERS.reduce((sum, s) => sum + s.weight, 0);
if (TOTAL_WEIGHT !== 100) {
  throw new Error(`[signConfig] STANDARD_SIGNERS 权重总和必须为 100，当前为 ${TOTAL_WEIGHT}`);
}
