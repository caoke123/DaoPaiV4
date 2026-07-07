/**
 * V4 Preflight Isolation Check
 *
 * Runs before V4 dev/start commands.
 * Aborts immediately if any V3 resource configuration is detected.
 *
 * Usage: node scripts/preflight-v4-isolation-check.mjs
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const FORBIDDEN = {
  env: [
    { key: 'PORT', forbidden: '3300', label: 'backend port' },
    { key: 'FRONTEND_PORT', forbidden: '5176', label: 'frontend port' },
    { key: 'PG_PORT', forbidden: '5436', label: 'postgres port' },
    { key: 'REDIS_PORT', forbidden: '6381', label: 'redis port' },
    { key: 'PG_DATABASE', forbidden: 'daopai_v3', label: 'database name' },
    { key: 'POSTGRES_DB', forbidden: 'daopai_v3', label: 'postgres db' },
  ],
  docker: [
    { pattern: /daopai-v3-postgres/i, label: 'V3 postgres container' },
    { pattern: /daopai-v3-redis/i, label: 'V3 redis container' },
    { pattern: /daopai_v3_pgdata/i, label: 'V3 postgres volume' },
    { pattern: /daopai_v3_redisdata/i, label: 'V3 redis volume' },
    { pattern: /POSTGRES_DB:\s*daopai_v3/, label: 'V3 database in POSTGRES_DB' },
    { pattern: /5436/, label: 'V3 postgres port in compose' },
    { pattern: /6381/, label: 'V3 redis port in compose' },
    { pattern: /3300/, label: 'V3 backend port in compose' },
    { pattern: /5176/, label: 'V3 frontend port in compose' },
  ],
  configFiles: [
    { pattern: /"cloudApiUrl":\s*"http:\/\/localhost:3300"/, label: 'V3 backend in agent cloudApiUrl' },
    { pattern: /"cloudBaseUrl":\s*"http:\/\/localhost:3300"/, label: 'V3 backend in agent cloudBaseUrl' },
    { pattern: /cloudApiUrl.*localhost:3300/, label: 'V3 backend in agent config doc' },
    { pattern: /port:\s*5176/, label: 'V3 frontend port in vite config' },
    { pattern: /target:\s*'http:\/\/localhost:3300/, label: 'V3 backend in vite proxy' },
    { pattern: /process\.env\.PORT \|\| '3300'/, label: 'V3 backend port default in backend/index.ts' },
    { pattern: /process\.env\.PG_PORT \|\| '5436'/, label: 'V3 PG port default in PgDatabase.ts' },
    { pattern: /process\.env\.PG_DATABASE \|\| 'daopai_v3'/, label: 'V3 DB name default in PgDatabase.ts' },
    { pattern: /process\.env\.REDIS_PORT \|\| '6381'/, label: 'V3 Redis port default in source' },
  ],
};

function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    env[key] = value;
  }
  return env;
}

function loadDockerCompose() {
  const path = resolve(ROOT, 'docker-compose.yml');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

function heading(text) {
  console.log(`\n[V4 PREFLIGHT] ${text}`);
}

let failures = 0;

function ok(label) {
  console.log(`[V4 PREFLIGHT]   OK: ${label}`);
}

function fail(label, detail) {
  console.log(`[V4 PREFLIGHT]   FAIL: ${label}${detail ? ` (${detail})` : ''}`);
  failures++;
}

// ── Check .env ──
heading('checking .env isolation...');

const env = loadEnv();

// But first: require at least PG_PORT be set (sanity)
if (!env['PG_PORT']) {
  fail('.env not loaded or empty', 'PG_PORT not found');
  process.exit(1);
}

for (const item of FORBIDDEN.env) {
  const actual = env[item.key];
  if (actual && actual === item.forbidden) {
    fail(`forbidden V3 ${item.label}`, `${item.key}=${actual}`);
  } else {
    ok(`${item.label} ${actual || '(not set)'}`);
  }
}

// ── Check docker-compose.yml ──
heading('checking docker-compose.yml isolation...');

const compose = loadDockerCompose();
if (!compose) {
  fail('docker-compose.yml not found');
  process.exit(1);
}

for (const item of FORBIDDEN.docker) {
  if (item.pattern.test(compose)) {
    fail(`forbidden V3 ${item.label}`, compose.match(item.pattern)[0]?.slice(0, 60));
  } else {
    ok(`no V3 ${item.label}`);
  }
}

// ── Check config files ──
heading('checking config files isolation...');

const configFilePaths = [
  ['packages/agent/agent.example.json', 'agent.example.json'],
  ['packages/agent/agent.json', 'agent.json'],
  ['packages/agent/README.md', 'agent README'],
  ['frontend/vite.config.ts', 'vite.config.ts'],
  ['backend/index.ts', 'backend/index.ts'],
  ['backend/db/PgDatabase.ts', 'PgDatabase.ts'],
  ['.env.example', '.env.example'],
  ['package.json', 'package.json'],
];

for (const [relPath, label] of configFilePaths) {
  const fpath = resolve(ROOT, ...relPath.split('/'));
  if (!existsSync(fpath)) {
    ok(`${label} not found, skipping`);
    continue;
  }
  const content = readFileSync(fpath, 'utf-8');
  let matched = false;
  for (const item of FORBIDDEN.configFiles) {
    if (item.pattern.test(content)) {
      fail(`forbidden V3 ${item.label}`, `in ${label}`);
      matched = true;
    }
  }
  if (!matched) {
    ok(`no V3 in ${label}`);
  }
}

// ── Result ──
heading(failures === 0 ? 'PASS' : 'DONE');

if (failures > 0) {
  console.log(`\n[V4 PREFLIGHT] ABORT: ${failures} forbidden V3 resource(s) detected.`);
  console.log('[V4 PREFLIGHT] Fix .env, docker-compose.yml, and config files before starting V4.');
  process.exit(1);
}

console.log('[V4 PREFLIGHT] All checks passed. V4 is isolated from V3.');
