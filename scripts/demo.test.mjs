import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDemoEnvironment } from './demo.mjs';

const paths = { database: 'D:/example/data/demo/demo.db', uploads: 'D:/example/data/demo/uploads', port: 3000 };

test('offline startup overrides inherited credentials and provider without mutating them', () => {
  const sourceEnvironment = Object.freeze({ MODEL_PROVIDER: 'glm', MODEL_API_KEY: 'synthetic-test-key', MODEL_BASE_URL: 'https://example.invalid', DATABASE_URL: 'file:original.db' });
  const env = createDemoEnvironment({ ...paths, sourceEnvironment, real: false });
  assert.equal(env.MODEL_PROVIDER, 'mock');
  assert.equal(env.MODEL_API_KEY, '');
  assert.equal(env.MODEL_BASE_URL, 'http://127.0.0.1:0');
  assert.equal(env.DEMO_MODE, '1');
  assert.equal(env.DATABASE_URL, `file:${paths.database}`);
  assert.equal(sourceEnvironment.MODEL_API_KEY, 'synthetic-test-key');
});

test('explicit real startup preserves configured models and credentials in the server environment', () => {
  const env = createDemoEnvironment({ ...paths, real: true, sourceEnvironment: {
    MODEL_PROVIDER: 'glm', MODEL_API_KEY: 'synthetic-test-key', MODEL_NAME: 'configured-text',
    MODEL_VISION_NAME: 'configured-vision', MODEL_BASE_URL: 'https://example.invalid',
    DATABASE_URL: 'file:original.db', PRIVATE_STORAGE_DIR: 'original-uploads',
  } });
  assert.equal(env.MODEL_PROVIDER, 'glm');
  assert.equal(env.MODEL_API_KEY, 'synthetic-test-key');
  assert.equal(env.MODEL_NAME, 'configured-text');
  assert.equal(env.MODEL_VISION_NAME, 'configured-vision');
  assert.equal(env.MODEL_BASE_URL, 'https://example.invalid');
  assert.equal(env.DEMO_MODE, '1');
  assert.equal(env.DATABASE_URL, `file:${paths.database}`);
  assert.equal(env.PRIVATE_STORAGE_DIR, paths.uploads);
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.MODEL_THINKING, 'disabled');
  assert.equal(env.MODEL_VISION_THINKING, 'disabled');
});

test('real startup respects explicit independent thinking settings and rejects invalid settings', () => {
  const sourceEnvironment = { MODEL_PROVIDER: 'glm', MODEL_API_KEY: 'synthetic-test-key', MODEL_THINKING: 'enabled', MODEL_VISION_THINKING: 'disabled' };
  const env = createDemoEnvironment({ ...paths, real: true, sourceEnvironment });
  assert.equal(env.MODEL_THINKING, 'enabled');
  assert.equal(env.MODEL_VISION_THINKING, 'disabled');
  for (const name of ['MODEL_THINKING', 'MODEL_VISION_THINKING']) {
    assert.throws(() => createDemoEnvironment({ ...paths, real: true, sourceEnvironment: { ...sourceEnvironment, [name]: 'automatic' } }), { message: 'DEMO_REAL_THINKING_INVALID' });
  }
});

test('offline startup overrides inherited thinking settings along with the key and provider', () => {
  const env = createDemoEnvironment({ ...paths, real: false, sourceEnvironment: { MODEL_PROVIDER: 'glm', MODEL_API_KEY: 'synthetic-test-key', MODEL_THINKING: 'automatic', MODEL_VISION_THINKING: 'enabled' } });
  assert.equal(env.MODEL_PROVIDER, 'mock');
  assert.equal(env.MODEL_API_KEY, '');
  assert.equal(env.MODEL_THINKING, 'disabled');
  assert.equal(env.MODEL_VISION_THINKING, 'disabled');
});

test('real startup fails closed for missing or whitespace-only API keys', () => {
  for (const key of [undefined, '', '  ']) {
    assert.throws(() => createDemoEnvironment({ ...paths, real: true,
      sourceEnvironment: { MODEL_PROVIDER: 'glm', MODEL_API_KEY: key } }),
    { message: 'DEMO_REAL_KEY_REQUIRED' });
  }
});

test('real startup fails closed until the existing supported provider is explicitly configured', () => {
  for (const provider of [undefined, 'mock', 'unsupported']) {
    assert.throws(() => createDemoEnvironment({ ...paths, real: true,
      sourceEnvironment: { MODEL_PROVIDER: provider, MODEL_API_KEY: 'synthetic-test-key' } }),
    { message: 'DEMO_REAL_PROVIDER_REQUIRED' });
  }
});

test('real CLI validates local configuration without touching storage or leaking credentials', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./demo.mjs', import.meta.url)), '--real', '--check-config'], {
    encoding: 'utf8', env: { ...process.env, MODEL_PROVIDER: 'glm', MODEL_API_KEY: 'synthetic-cli-key',
      MODEL_NAME: 'synthetic-text', MODEL_VISION_NAME: 'synthetic-vision', MODEL_BASE_URL: 'https://example.invalid',
      MODEL_THINKING: 'enabled', MODEL_VISION_THINKING: 'disabled' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { provider: 'glm', apiKeyPresent: true,
    model: 'synthetic-text', visionModel: 'synthetic-vision', thinking: 'enabled', visionThinking: 'disabled', real: true, demoMode: true });
  assert.equal(`${result.stdout}${result.stderr}`.includes('synthetic-cli-key'), false);
});

test('real CLI reports missing credentials before any database or server preparation', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./demo.mjs', import.meta.url)), '--real', '--check-config'], {
    encoding: 'utf8', env: { ...process.env, MODEL_PROVIDER: 'glm', MODEL_API_KEY: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /真实模式缺少 MODEL_API_KEY/);
  assert.equal(result.stdout, '');
});
