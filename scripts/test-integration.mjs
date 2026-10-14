import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = await mkdtemp(path.join(os.tmpdir(), 'campus-integration-'));
const db = path.join(dir, 'integration.db').replaceAll('\\', '/');
const env = { ...process.env, DATABASE_URL: `file:${db}` };
try {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { cwd: process.cwd(), env, stdio: 'inherit' });
  execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/integration', '--maxWorkers=1', '--minWorkers=1'], { cwd: process.cwd(), env, stdio: 'inherit' });
} finally {
  await rm(dir, { recursive: true, force: true });
}
