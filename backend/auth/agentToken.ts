/**
 * Agent Token 工具函数
 *
 * 执行电脑授权码的生成、哈希、验证。
 * 只保存 hash 到数据库，明文 token 只在创建时展示一次。
 *
 * 安全要求：
 *   - token 明文格式：daopai_agent_ + 64 字符 hex 随机串
 *   - 使用 SHA-256 做 hash
 *   - 比对使用 crypto.timingSafeEqual 防时序攻击
 *   - 日志中不输出明文 token
 *   - 不将 token 写入任何文件
 */

import crypto from 'crypto';

/** 随机字节长度（32 字节 = 64 字符 hex） */
const TOKEN_RANDOM_BYTES = 32;

/** token 前缀 — 便于在日志中快速识别 */
export const AGENT_TOKEN_PREFIX = 'daopai_agent_';

/**
 * 生成一个新的执行电脑授权码
 *
 * @returns 明文 token（只展示一次，不存储）
 */
export function generateAgentToken(): string {
  const randomPart = crypto.randomBytes(TOKEN_RANDOM_BYTES).toString('hex');
  return `${AGENT_TOKEN_PREFIX}${randomPart}`;
}

/**
 * 对执行电脑授权码做 SHA-256 hash
 *
 * @param plainToken 明文 token
 * @returns hex 格式的 hash 值
 */
export function hashAgentToken(plainToken: string): string {
  return crypto.createHash('sha256').update(plainToken).digest('hex');
}

/**
 * 验证执行电脑授权码是否匹配
 *
 * 使用 crypto.timingSafeEqual 做时间恒定比较，避免时序攻击。
 * 虽然 Agent Token 是 32 字节随机数生成的长 token，风险较低，
 * 但正式实现时仍建议使用 timingSafeEqual。
 *
 * @param plainToken 明文 token（来自 HTTP 请求头）
 * @param storedHash 数据库中保存的 hash
 * @returns 是否匹配
 */
export function verifyAgentToken(plainToken: string, storedHash: string): boolean {
  try {
    const computedHash = Buffer.from(hashAgentToken(plainToken), 'hex');
    const storedHashBuffer = Buffer.from(storedHash, 'hex');

    if (computedHash.length !== storedHashBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(computedHash, storedHashBuffer);
  } catch {
    // hash 格式错误（如存储在数据库中的 hash 不是合法 hex）
    return false;
  }
}