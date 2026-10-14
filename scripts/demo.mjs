import { spawn, spawnSync } from 'node:child_process';
import { access, lstat, mkdir, open, realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep demo storage isolated in both modes; real mode needs explicit opt-in. */
export function createDemoEnvironment({ sourceEnvironment, real, database, uploads, port }) {
  if (real && sourceEnvironment.MODEL_PROVIDER !== 'glm') throw new Error('DEMO_REAL_PROVIDER_REQUIRED');
  if (real && !sourceEnvironment.MODEL_API_KEY?.trim()) throw new Error('DEMO_REAL_KEY_REQUIRED');
  if (real && ['MODEL_THINKING', 'MODEL_VISION_THINKING'].some((name) => sourceEnvironment[name] !== undefined && !['enabled', 'disabled'].includes(sourceEnvironment[name]))) throw new Error('DEMO_REAL_THINKING_INVALID');
  return {
    ...sourceEnvironment,
    DATABASE_URL: `file:${database.replaceAll('\\', '/')}`,
    PRIVATE_STORAGE_DIR: uploads,
    APP_TIMEZONE: 'Asia/Shanghai',
    HOST: '127.0.0.1',
    PORT: String(port),
    DEMO_MODE: '1',
    MODEL_PROVIDER: real ? 'glm' : 'mock',
    MODEL_API_KEY: real ? sourceEnvironment.MODEL_API_KEY : '',
    MODEL_BASE_URL: real ? sourceEnvironment.MODEL_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4' : 'http://127.0.0.1:0',
    MODEL_NAME: sourceEnvironment.MODEL_NAME ?? 'glm-4.5-flash',
    MODEL_VISION_NAME: sourceEnvironment.MODEL_VISION_NAME ?? 'glm-4.5v',
    MODEL_THINKING: real ? sourceEnvironment.MODEL_THINKING ?? 'disabled' : 'disabled',
    MODEL_VISION_THINKING: real ? sourceEnvironment.MODEL_VISION_THINKING ?? 'disabled' : 'disabled',
    SAVE_RAW_MODEL_RESPONSE: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
  };
}

async function runDemo() {
// Both entry points ignore the configured application database. Demo data
// persists between runs, and never gets reseeded.
const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
let port = 3000;
let prepareOnly = false;
let real = false;
let checkConfigOnly = false;
for (const argument of args) {
  if (argument === '--prepare-only') prepareOnly = true;
  else if (argument === '--real') real = true;
  else if (argument === '--check-config') checkConfigOnly = true;
  else if (/^--port=\d+$/.test(argument)) port = Number(argument.slice(7));
  else if (argument === '--help') {
    console.log('用法：npm run demo -- [--port=3000] [--prepare-only] [--check-config]');
    console.log('离线演示；仅监听 127.0.0.1；数据保存在 data/demo/；不会清空已有内容。');
    console.log('真实识别：npm run demo:real -- [--port=3000] [--check-config]');
    console.log('真实模式从本机 .env.local 加载 GLM 配置；手动调用模型时，通知文本或图片将发送到已配置的模型服务。');
    console.log('真实 Demo 默认关闭文本和视觉深度思考；MODEL_THINKING / MODEL_VISION_THINKING 可明确设为 enabled 或 disabled。');
    process.exit(0);
  } else {
    console.error('不支持的参数。请运行 npm run demo -- --help。');
    process.exit(1);
  }
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error('端口必须在 1–65535 之间。');
  process.exit(1);
}

const demoDirectory = path.join(root, 'data', 'demo');
const database = path.join(demoDirectory, 'demo.db');
const uploads = path.join(demoDirectory, 'uploads');
const schema = path.join(root, 'prisma', 'schema.prisma');
const prisma = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
let env;

async function statIfPresent(target) {
  try { return await lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function ensureDirectory(target) {
  const current = await statIfPresent(target);
  if (current && (!current.isDirectory() || current.isSymbolicLink())) {
    throw new Error('DEMO_PATH_INVALID');
  }
  await mkdir(target, { recursive: true });
  if (await realpath(target) !== path.resolve(target)) throw new Error('DEMO_PATH_INVALID');
}

function runPrisma(arguments_, allowDifference = false) {
  const result = spawnSync(process.execPath, [prisma, ...arguments_], {
    cwd: root, env, encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw new Error('DEMO_PRISMA_UNAVAILABLE');
  if (result.status !== 0 && !(allowDifference && result.status === 2)) {
    // Prisma diagnostics contain schema/runtime errors; do not dump the ambient
    // environment or model configuration to troubleshoot a failed preparation.
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error('DEMO_DATABASE_PREPARATION_FAILED');
  }
  return result.status;
}

async function assertAvailablePort() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('DEMO_PORT_IN_USE')));
    server.listen(port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()));
  });
}

try {
  if (real) {
    // Use Next's existing dotenv precedence, including .env.local. Do not print
    // parsed files, credential values, or arbitrary dotenv error contents.
    const { default: nextEnvironment } = await import('@next/env');
    let loadFailed = false;
    nextEnvironment.loadEnvConfig(root, true, { info() {}, error() { loadFailed = true; } });
    if (loadFailed) throw new Error('DEMO_REAL_ENV_INVALID');
  }
  env = createDemoEnvironment({ sourceEnvironment: process.env, real, database, uploads, port });
  if (checkConfigOnly) {
    console.log(JSON.stringify({ provider: env.MODEL_PROVIDER, apiKeyPresent: Boolean(env.MODEL_API_KEY),
      model: env.MODEL_NAME, visionModel: env.MODEL_VISION_NAME,
      thinking: env.MODEL_THINKING, visionThinking: env.MODEL_VISION_THINKING, real, demoMode: true }));
    return;
  }
  try { await Promise.all([access(prisma), access(next)]); }
  catch { throw new Error('DEMO_DEPENDENCIES_MISSING'); }
  if (!prepareOnly) await assertAvailablePort();
  // Reject symlinks/reparse points before creating an isolated data directory.
  await ensureDirectory(path.join(root, 'data'));
  await ensureDirectory(demoDirectory);
  await ensureDirectory(uploads);
  const existing = await statIfPresent(database);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('DEMO_PATH_INVALID');
  runPrisma(['generate', '--schema', schema]);
  if (existing) {
    const difference = runPrisma(['migrate', 'diff', '--from-url', env.DATABASE_URL,
      '--to-schema-datamodel', schema, '--exit-code'], true);
    if (difference !== 0) throw new Error('DEMO_SCHEMA_CHANGED');
    console.log('已有演示数据库通过结构检查，保留全部演示数据。');
  } else {
    // Exclusive creation prevents another preparation from replacing a database.
    const handle = await open(database, 'wx');
    await handle.close();
    runPrisma(['db', 'push', '--skip-generate', '--schema', schema]);
    console.log('独立演示数据库已创建；任务将由你预览和确认后生成。');
  }
  console.log(real ? '演示模式：真实 GLM；手动调用模型时，通知文本或图片将外传。' : '演示模式：离线 mock。');
  console.log('数据库与附件：data/demo/；停止后保留数据。');
  if (!prepareOnly) {
    console.log(`体验地址：http://127.0.0.1:${port}（按 Ctrl+C 停止）`);
    const child = spawn(process.execPath, [next, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root, env, stdio: 'inherit', windowsHide: true,
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.once('error', () => { console.error('DEMO_SERVER_START_FAILED'); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 0 : 1); });
  }
} catch (error) {
  const messages = {
    DEMO_REAL_PROVIDER_REQUIRED: '真实模式需要配置 MODEL_PROVIDER=glm。请检查本机 .env.local。',
    DEMO_REAL_KEY_REQUIRED: '真实模式缺少 MODEL_API_KEY。请在本机 .env.local 配置服务端密钥。',
    DEMO_REAL_THINKING_INVALID: 'MODEL_THINKING / MODEL_VISION_THINKING 仅支持 enabled 或 disabled；未启动服务。',
    DEMO_REAL_ENV_INVALID: '本机模型环境文件无法读取或解析。请检查 .env.local；未启动服务。',
    DEMO_DEPENDENCIES_MISSING: '缺少本地依赖，请先执行 npm ci。',
    DEMO_PATH_INVALID: '演示路径不是普通本地目录/文件，已停止，未覆盖已有内容。',
    DEMO_PORT_IN_USE: `127.0.0.1:${port} 已被占用。请使用 npm run ${real ? 'demo:real' : 'demo'} -- --port=3001。`,
    DEMO_SCHEMA_CHANGED: '已有演示库与当前结构不同，已保留数据并停止。请先备份 data/demo/，再按迁移流程处理。',
  };
  console.error(messages[error.message] ?? '演示准备失败，已有数据保持原状；请检查上方本地运行诊断。');
  process.exitCode = 1;
}
}

// Importing the configuration helper in regression tests never starts a server
// or touches generated clients, storage, dotenv files, or the network.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runDemo();
