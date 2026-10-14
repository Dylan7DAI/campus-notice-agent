import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temporaryRoot = path.resolve(os.tmpdir());
const directory = await mkdtemp(path.join(temporaryRoot, 'campus-e2e-'));
const database = path.join(directory, 'e2e.db').replaceAll('\\', '/');
try {
  execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
    cwd: process.cwd(), env: { ...process.env, E2E_DATABASE_URL: `file:${database}`, E2E_STORAGE_DIR: path.join(directory, 'uploads') }, stdio: 'inherit',
  });
} finally {
  if (path.dirname(path.resolve(directory)) !== temporaryRoot || !path.basename(directory).startsWith('campus-e2e-')) throw new Error('UNSAFE_E2E_CLEANUP_PATH');
  await rm(directory, { recursive: true, force: true });
}
