// Phase 3-B: 密码 hash 工具
// 使用 Node.js 内置 crypto.scrypt，每个密码独立 salt

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify<string, string, number, Buffer>(scrypt);

/** hash 格式前缀，用于版本识别 */
const FORMAT_VERSION = 'v1';

/** scrypt 参数 */
const KEY_LENGTH = 64;   // 512 bits
const SALT_LENGTH = 32;  // 256 bits

/**
 * hash 格式：`v1$<salt_base64>$<hash_base64>`
 */

/**
 * 对密码进行 hash
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH).toString('base64');
  const derivedKey = await scryptAsync(password, salt, KEY_LENGTH);
  const hash = derivedKey.toString('base64');
  return `${FORMAT_VERSION}$${salt}$${hash}`;
}

/**
 * 验证密码是否匹配存储的 hash
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== FORMAT_VERSION) {
    return false;
  }
  const [, salt, expectedHash] = parts;
  const derivedKey = await scryptAsync(password, salt, KEY_LENGTH);
  const derivedHash = derivedKey.toString('base64');

  // 使用 timingSafeEqual 防时序攻击
  const expectedBuf = Buffer.from(expectedHash, 'base64');
  const derivedBuf = Buffer.from(derivedHash, 'base64');

  if (expectedBuf.length !== derivedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, derivedBuf);
}