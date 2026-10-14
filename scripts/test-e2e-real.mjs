import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const run = (file, args, cwd, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { cwd, env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
});

if (process.argv.includes('--serve')) {
  if (!process.env.E2E_REAL_APP_DIR) throw new Error('E2E_REAL_APP_REQUIRED');
  process.exitCode = await run(next, ['dev', '--hostname', '127.0.0.1', '--port', '3001'], process.env.E2E_REAL_APP_DIR, process.env);
} else {
  // Next's Windows webpack entry paths must share a drive with node_modules.
  // Allocate a unique ignored test directory on the workspace drive.
  const temporaryRoot = path.resolve(root, 'data');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, 'campus-real-e2e-'));
  const app = path.join(directory, 'app');
  let calls = 0;
  const provider = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/chat/completions'
        || request.headers.authorization !== 'Bearer local-synthetic-e2e-key') {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"TEST_REQUEST_REJECTED"}'); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls += 1;
      const content = body.messages[0].content;
      const prompt = typeof content === 'string' ? content : content.find((part) => part.type === 'text').text;
      if (prompt.includes('PROVIDER_FAIL')) {
        response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"SYNTHETIC_PROVIDER_UNAVAILABLE"}'); return;
      }
      let output;
      if (Array.isArray(content)) {
        output = { text: '合成图书活动报名。\n截止2026-11-02，含当日。\n报名需提交报名表。' };
      } else {
        const revisionId = /^text_revision_id=(.+)$/m.exec(prompt)?.[1];
        const text = /通知正文：\n([\s\S]+?)\n\n输出符合/.exec(prompt)?.[1];
        if (!revisionId || !text) throw new Error('SYNTHETIC_PROMPT_NOT_SUPPORTED');
        output = { schema_version: '1.0', text_revision_id: revisionId,
          relation: { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] },
          facts: [
            { id: 'title', field: 'title', value: text.split('\n')[0].replace(/。$/, ''), evidence_refs: ['seg-1'] },
            { id: 'category', field: 'category', value: 'registration', evidence_refs: ['seg-1'] },
            { id: 'due', field: 'due', value: { kind: 'date', date: '2026-11-02', timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: '2026-11-02，含当日' }, evidence_refs: ['seg-2'] },
            { id: 'material', field: 'requirement_add', value: '报名表', evidence_refs: ['seg-3'] },
          ], questions: [] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { total_tokens: 10 } }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"SYNTHETIC_PROVIDER_REQUEST_INVALID"}');
    }
  });
  try {
    await mkdir(app);
    // A fresh application snapshot owns its .next cache. No dotenv files or
    // personal data are copied, and the active demo on port 3000 stays untouched.
    for (const file of ['src', 'prisma/schema.prisma', 'package.json', 'next.config.ts', 'tsconfig.json', 'next-env.d.ts']) {
      await cp(path.join(root, file), path.join(app, file), { recursive: true });
    }
    await symlink(path.join(root, 'node_modules'), path.join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('SYNTHETIC_PROVIDER_NOT_READY');
    const env = { ...process.env, E2E_REAL_APP_DIR: app,
      E2E_REAL_DATABASE_URL: `file:${path.join(directory, 'test.db').replaceAll('\\', '/')}`,
      E2E_REAL_STORAGE_DIR: path.join(directory, 'uploads'), E2E_REAL_PROVIDER_URL: `http://127.0.0.1:${address.port}`,
      MODEL_PROVIDER: 'glm', MODEL_API_KEY: 'local-synthetic-e2e-key',
      MODEL_BASE_URL: `http://127.0.0.1:${address.port}`, MODEL_NAME: 'synthetic-text', MODEL_VISION_NAME: 'synthetic-vision',
      NEXT_TELEMETRY_DISABLED: '1', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' };
    execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(app, 'prisma/schema.prisma')], {
      cwd: app, env: { ...env, DATABASE_URL: env.E2E_REAL_DATABASE_URL }, stdio: 'inherit', windowsHide: true,
    });
    process.exitCode = await run(path.join(root, 'node_modules/@playwright/test/cli.js'),
      ['test', '--config', 'playwright.real.config.ts', ...process.argv.slice(2)], root, env);
    console.log(`Local synthetic provider requests: ${calls}; no online model quality claim.`);
  } finally {
    await new Promise((resolve) => provider.close(resolve));
    if (path.dirname(path.resolve(directory)) !== temporaryRoot || !path.basename(directory).startsWith('campus-real-e2e-')) throw new Error('UNSAFE_REAL_E2E_CLEANUP_PATH');
    await rm(directory, { recursive: true, force: true });
  }
}
