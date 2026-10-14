import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelRunner, type RunnerClient } from '../../src/application/model-runner';

let db: PrismaClient;
let temporaryDirectory: string;
let storageDirectory: string;
const previousStorageDirectory = process.env.PRIVATE_STORAGE_DIR;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'campus-demo-real-storage-'));
  storageDirectory = path.join(temporaryDirectory, 'configured-private-uploads');
  await mkdir(storageDirectory);
  const databaseUrl = `file:${path.join(temporaryDirectory, 'storage.db').replaceAll('\\', '/')}`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
  });
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  process.env.PRIVATE_STORAGE_DIR = storageDirectory;
}, 30_000);

afterAll(async () => {
  if (previousStorageDirectory === undefined) delete process.env.PRIVATE_STORAGE_DIR;
  else process.env.PRIVATE_STORAGE_DIR = previousStorageDirectory;
  await db?.$disconnect();
  if (temporaryDirectory) {
    const directory = path.resolve(temporaryDirectory);
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('campus-demo-real-storage-')) throw new Error('TEMP_CLEANUP_PATH_INVALID');
    await rm(directory, { recursive: true, force: true });
  }
});

async function imageDraft(storageKey: string) {
  const id = randomUUID();
  const artifact = await db.sourceArtifact.create({ data: { id: `artifact-${id}`, sha256: id, mediaType: 'image/png', privateStorageKey: storageKey, originLabel: '合成边界测试', size: png.length } });
  const intake = await db.intake.create({ data: { id: `intake-${id}`, sourceArtifactId: artifact.id, text: '[合成图片待识别]', stage: 'text_review' } });
  return { intakeId: intake.id, artifactId: artifact.id, storageKey, mediaType: artifact.mediaType };
}

describe('configured demo image storage (stub provider boundary, not recognition quality)', () => {
  it('reads the uploaded PNG from PRIVATE_STORAGE_DIR and sends those exact bytes to the vision boundary', async () => {
    const storageKey = `${randomUUID()}.png`;
    await writeFile(path.join(storageDirectory, storageKey), png);
    const draft = await imageDraft(storageKey);
    let imageCalls = 0;
    const stub: RunnerClient = {
      chat: async () => { throw new Error('Text repair must not run for this synthetic image boundary'); },
      chatWithImage: async (_messages, dataUrl) => {
        imageCalls += 1;
        expect(dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`);
        return { text: JSON.stringify({ text: '合成报名通知。需要报名表。' }), raw: {} };
      },
    };
    const runner = new ModelRunner(db, stub, 'stub-storage-boundary', 'stub-text', stub, 'stub-vision');
    const before = await db.intake.findUniqueOrThrow({ where: { id: draft.intakeId } });
    const output = await runner.recognizeImage(draft);
    expect(output.text).toBe('合成报名通知。需要报名表。');
    expect(output.callCount).toBe(1);
    expect(imageCalls).toBe(1);
    expect(await db.agentRun.findUnique({ where: { id: output.runId } })).toMatchObject({ stage: 'recognition', status: 'succeeded', provider: 'stub-storage-boundary', model: 'stub-vision', callCount: 1 });
    expect(await db.intake.findUnique({ where: { id: draft.intakeId } })).toEqual(before);
    expect(await db.task.count()).toBe(0);
    expect(await db.case.count()).toBe(0);
  });

  it.each(['missing', 'traversal', 'absolute'] as const)('rejects %s storage before any provider call without exposing a filesystem path', async (kind) => {
    const storageKey = kind === 'missing' ? `${randomUUID()}.png` : kind === 'traversal' ? '../outside.png' : path.join(temporaryDirectory, 'outside.png');
    if (kind !== 'missing') await writeFile(path.join(temporaryDirectory, 'outside.png'), png);
    const draft = await imageDraft(storageKey);
    let providerCalls = 0;
    const stub: RunnerClient = {
      chat: async () => { providerCalls += 1; return { text: '{}', raw: {} }; },
      chatWithImage: async () => { providerCalls += 1; return { text: '{}', raw: {} }; },
    };
    const runner = new ModelRunner(db, stub, 'stub-storage-boundary', 'stub-model');
    const before = await db.intake.findUniqueOrThrow({ where: { id: draft.intakeId } });
    const outcome = await runner.recognizeImage(draft).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: 'STORAGE_UNAVAILABLE', message: 'STORAGE_UNAVAILABLE' });
    expect(String(outcome)).not.toContain(storageDirectory);
    expect(String(outcome)).not.toContain('outside.png');
    expect(providerCalls).toBe(0);
    expect(await db.agentRun.count({ where: { intakeId: draft.intakeId } })).toBe(0);
    expect(await db.intake.findUnique({ where: { id: draft.intakeId } })).toEqual(before);
    expect(await db.task.count()).toBe(0);
  });
});
