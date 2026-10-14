import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let db: PrismaClient;
let directory: string;
let uploads: string;
let server: http.Server;
let post: typeof import('../../src/app/api/intakes/route')['POST'];
let get: typeof import('../../src/app/api/intakes/route')['GET'];
let providerCalls = 0;
let respond: (body: Record<string, unknown>) => Promise<string>;
const intakeIds: string[] = [];
const sourceIds: string[] = [];
const caseIds: string[] = [];
const commandKeys: string[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

function extractionResponse(body: Record<string, unknown>) {
  const prompt = JSON.stringify(body.messages);
  const revisionId = /text_revision_id=([^\\\n"]+)/u.exec(prompt)?.[1];
  if (!revisionId) throw new Error('STUB_REVISION_MISSING');
  return JSON.stringify({ schema_version: '1.0', text_revision_id: revisionId, relation: { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, facts: [
    { id: 'title', field: 'title', value: '合成报名', evidence_refs: ['seg-1'] },
    { id: 'category', field: 'category', value: 'registration', evidence_refs: ['seg-1'] },
    { id: 'material', field: 'requirement_add', value: '报名表', evidence_refs: ['seg-1'] },
  ], questions: [] });
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'campus-demo-real-intake-'));
  uploads = path.join(directory, 'uploads');
  await mkdir(uploads);
  // The integration harness owns the temporary SQLite lifecycle and deletes it
  // after the route's Prisma client has exited. Never use an application DB.
  const databaseUrl = process.env.DATABASE_URL;
  const databasePath = databaseUrl?.startsWith('file:') ? path.resolve(databaseUrl.slice(5)) : '';
  if (!databaseUrl || !databasePath.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error('TEMP_DATABASE_REQUIRED');
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  respond = async (body) => JSON.stringify(body.messages).includes('image_url') ? JSON.stringify({ text: '合成报名，需报名表。' }) : extractionResponse(body);
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    providerCalls += 1;
    const output = await respond(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('STUB_LOOPBACK_UNAVAILABLE');
  vi.stubEnv('DATABASE_URL', databaseUrl);
  vi.stubEnv('PRIVATE_STORAGE_DIR', uploads);
  vi.stubEnv('MODEL_PROVIDER', 'glm');
  vi.stubEnv('MODEL_API_KEY', 'synthetic-local-stub-key');
  vi.stubEnv('MODEL_BASE_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('MODEL_NAME', 'stub-text-boundary');
  vi.stubEnv('MODEL_VISION_NAME', 'stub-vision-boundary');
  vi.resetModules();
  const route = await import('../../src/app/api/intakes/route');
  post = route.POST;
  get = route.GET;
}, 30_000);

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (db) {
    const tasks = await db.task.findMany({ where: { caseId: { in: caseIds } }, select: { id: true } });
    await db.requirement.deleteMany({ where: { taskId: { in: tasks.map((task) => task.id) } } });
    await db.task.deleteMany({ where: { caseId: { in: caseIds } } });
    await db.auditEvent.deleteMany({ where: { caseId: { in: caseIds } } });
    await db.noticeRelation.deleteMany({ where: { caseId: { in: caseIds } } });
    await db.noticeRevision.deleteMany({ where: { caseId: { in: caseIds } } });
    await db.evidence.deleteMany({ where: { sourceId: { in: sourceIds } } });
    await db.case.deleteMany({ where: { id: { in: caseIds } } });
    await db.commandResult.deleteMany({ where: { idempotencyKey: { in: commandKeys } } });
    await db.agentRun.deleteMany({ where: { intakeId: { in: intakeIds } } });
    await db.textApproval.deleteMany({ where: { intakeId: { in: intakeIds } } });
    await db.intake.deleteMany({ where: { id: { in: intakeIds } } });
    await db.textRevision.deleteMany({ where: { sourceId: { in: sourceIds } } });
    await db.sourceArtifact.deleteMany({ where: { id: { in: sourceIds } } });
  }
  await db?.$disconnect();
  vi.unstubAllEnvs();
  if (directory) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('campus-demo-real-intake-')) throw new Error('TEMP_CLEANUP_PATH_INVALID');
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

function action(body: Record<string, unknown>) {
  return post(new Request('http://localhost/api/intakes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

async function formalCounts() {
  return Promise.all([
    db.case.count(), db.task.count(), db.requirement.count(), db.noticeRevision.count(),
    db.noticeRelation.count(), db.evidence.count(), db.auditEvent.count(), db.commandResult.count(),
    db.changeProposal.count(), db.proposalOperation.count(), db.proposalApplication.count(),
  ]);
}

async function fixture(applied = false) {
  const id = randomUUID();
  const storageKey = `${id}.png`;
  await writeFile(path.join(uploads, storageKey), png);
  const artifact = await db.sourceArtifact.create({ data: { id: `artifact-${id}`, sha256: id, mediaType: 'image/png', privateStorageKey: storageKey, originLabel: '合成HTTP边界测试', size: png.length } });
  const revision = await db.textRevision.create({ data: { id: `revision-${id}`, sourceId: artifact.id, text: '合成报名，需报名表。', method: 'manual' } });
  const intake = await db.intake.create({ data: { id: `intake-${id}`, sourceArtifactId: artifact.id, textRevisionId: revision.id, text: revision.text, approved: true, stage: applied ? 'applied' : 'proposal_ready', candidateJson: JSON.stringify({ title: '合成报名', requirement: '报名表', evidence: { quote: revision.text, start: 0, end: revision.text.length } }) } });
  intakeIds.push(intake.id);
  sourceIds.push(artifact.id);
  await db.textApproval.create({ data: { id: `approval-${id}`, intakeId: intake.id, textRevisionId: revision.id } });
  return { intake, revision, artifact };
}

describe('real intake safety (loopback HTTP stub, not model quality)', () => {
  it('returns sourceMediaType without exposing the private storage key', async () => {
    const f = await fixture();
    const response = await get(new Request(`http://localhost/api/intakes?id=${f.intake.id}`));
    const body = await response.json();
    expect(body.sourceMediaType).toBe('image/png');
    expect(JSON.stringify(body)).not.toContain('privateStorageKey');
  });

  it('reuses an identical image and its applied draft without leaving another file or source', async () => {
    const upload = () => {
      const form = new FormData();
      form.set('file', new File([png], 'synthetic.png', { type: 'image/png' }));
      return post(new Request('http://localhost/api/intakes', { method: 'POST', body: form }));
    };
    const first = await upload();
    expect(first.status).toBe(200);
    const saved = (await first.json()) as { intakeId: string; sourceArtifactId: string };
    intakeIds.push(saved.intakeId);
    sourceIds.push(saved.sourceArtifactId);
    await db.intake.update({ where: { id: saved.intakeId }, data: { stage: 'applied' } });
    const files = await readdir(uploads);
    const replay = await upload();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ intakeId: saved.intakeId, sourceArtifactId: saved.sourceArtifactId, stage: 'applied', replayed: true });
    expect(await db.sourceArtifact.count({ where: { sha256: createHash('sha256').update(png).digest('hex') } })).toBe(1);
    expect(await db.intake.count({ where: { sourceArtifactId: saved.sourceArtifactId } })).toBe(1);
    expect(await readdir(uploads)).toEqual(files);
  });

  it('removes a newly written image when the real SQLite intake transaction is rejected', async () => {
    const bytes = Buffer.concat([png, Buffer.from(randomUUID())]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const files = await readdir(uploads);
    await db.$executeRawUnsafe("CREATE TRIGGER reject_new_image_draft BEFORE INSERT ON Intake WHEN NEW.text = '[图片尚未识别，请识别文字或填写人工校正稿]' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_INTAKE_FAILURE'); END;");
    try {
      const form = new FormData();
      form.set('file', new File([bytes], 'synthetic-rejected.png', { type: 'image/png' }));
      const response = await post(new Request('http://localhost/api/intakes', { method: 'POST', body: form }));
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('STORAGE_UNAVAILABLE');
      expect(await readdir(uploads)).toEqual(files);
      expect(await db.sourceArtifact.count({ where: { sha256 } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER reject_new_image_draft;');
    }
  });

  it.each(['glm', 'mock'])('rejects arbitrary legacy candidate fields in %s mode without rewriting the draft', async (provider) => {
    const f = await fixture();
    const counts = await formalCounts();
    const calls = providerCalls;
    vi.stubEnv('MODEL_PROVIDER', provider);
    try {
      const response = await action({ action: 'candidate', intakeId: f.intake.id, title: '原文没有的合成标题', requirement: '原文没有的合成材料' });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe('LEGACY_CANDIDATE_UNSUPPORTED');
      expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(f.intake);
      expect(await formalCounts()).toEqual(counts);
      expect(providerCalls).toBe(calls);
    } finally {
      vi.stubEnv('MODEL_PROVIDER', 'glm');
    }
  });

  it.each([undefined, 'synthetic-unused-preview'])('rejects a previously stored legacy candidate with previewHash %s without formal writes', async (previewHash) => {
    const f = await fixture();
    const counts = await formalCounts();
    const key = `legacy-intake-rejected-${randomUUID()}`;
    commandKeys.push(key);
    const response = await action({ action: 'confirm', intakeId: f.intake.id, idempotencyKey: key, previewHash });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('LEGACY_CANDIDATE_UNSUPPORTED');
    expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(f.intake);
    expect(await formalCounts()).toEqual(counts);
  });

  it('requires a schema 1.0 preview before confirming and replays the confirmed request with its original evidence', async () => {
    const f = await fixture();
    const extracted = await action({ action: 'extract', intakeId: f.intake.id, textRevisionId: f.revision.id });
    expect(extracted.status).toBe(200);
    expect(await extracted.json()).toMatchObject({ mode: 'real', candidate: { schema_version: '1.0', text_revision_id: f.revision.id } });
    const approved = await db.intake.findUniqueOrThrow({ where: { id: f.intake.id } });
    const counts = await formalCounts();
    const key = `real-intake-replay-${randomUUID()}`;
    commandKeys.push(key);
    const missing = await action({ action: 'confirm', intakeId: f.intake.id, idempotencyKey: key });
    expect(missing.status).toBe(422);
    expect((await missing.json()).error.code).toBe('PREVIEW_REQUIRED');
    expect(await formalCounts()).toEqual(counts);
    expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(approved);
    const previewed = await action({ action: 'preview', intakeId: f.intake.id });
    expect(previewed.status).toBe(200);
    const preview = (await previewed.json()) as { previewHash: string; preview: { kind: string } };
    expect(preview.preview.kind).toBe('new');
    expect(await formalCounts()).toEqual(counts);
    const body = { action: 'confirm', intakeId: f.intake.id, idempotencyKey: key, previewHash: preview.previewHash };
    const first = await action(body);
    expect(first.status).toBe(200);
    const committed = (await first.json()) as { caseId: string; taskId: string; replayed: boolean };
    caseIds.push(committed.caseId);
    const before = await db.intake.findUniqueOrThrow({ where: { id: f.intake.id } });
    const afterCounts = await formalCounts();
    const repeated = await action(body);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ ...committed, replayed: true });
    expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(before);
    expect(await formalCounts()).toEqual(afterCounts);
    expect(await db.task.count({ where: { caseId: committed.caseId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { caseId: committed.caseId } })).toBe(1);
    expect(await db.requirement.findMany({ where: { taskId: committed.taskId } })).toMatchObject([{ label: '报名表', satisfaction: 'missing' }]);
    const notice = await db.noticeRevision.findFirstOrThrow({ where: { caseId: committed.caseId } });
    const relation = await db.noticeRelation.findFirstOrThrow({ where: { caseId: committed.caseId, noticeId: notice.id } });
    expect(notice.textRevisionId).toBe(f.revision.id);
    const evidenceIds = [...JSON.parse(notice.evidenceIdsJson) as string[], ...JSON.parse(relation.evidenceIdsJson) as string[]];
    expect(evidenceIds.length).toBeGreaterThan(0);
    for (const id of evidenceIds) {
      expect(await db.evidence.findUnique({ where: { id } })).toMatchObject({ sourceId: f.artifact.id, textRevisionId: f.revision.id, quote: f.revision.text, start: 0, end: f.revision.text.length, origin: 'notice' });
    }
  });

  it.each(['recognize', 'extract', 'approve', 'candidate', 'revise'])('preserves an applied intake when %s is requested', async (name) => {
    const f = await fixture(true);
    const calls = providerCalls;
    const response = await action({ action: name, intakeId: f.intake.id, textRevisionId: f.revision.id, text: '已经提交后不应保存的合成校正。' });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('INTAKE_ALREADY_APPLIED');
    expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(f.intake);
    expect(await db.textRevision.count({ where: { sourceId: f.artifact.id } })).toBe(1);
    expect(providerCalls).toBe(calls);
  });

  it('rejects a save from an old tab without replacing the newer approved manual revision', async () => {
    const f = await fixture();
    const saved = await action({ action: 'revise', intakeId: f.intake.id, textRevisionId: f.revision.id, text: '新标签页保存的合成校正稿。' });
    expect(saved.status).toBe(200);
    const revised = await db.intake.findUniqueOrThrow({ where: { id: f.intake.id } });
    await action({ action: 'approve', intakeId: f.intake.id, textRevisionId: revised.textRevisionId });
    const current = await db.intake.findUniqueOrThrow({ where: { id: f.intake.id } });
    const response = await action({ action: 'revise', intakeId: f.intake.id, textRevisionId: f.revision.id, text: '旧标签页迟到的合成修改。' });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('TEXT_REVISION_STALE');
    expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(current);
    expect(await db.textRevision.count({ where: { sourceId: f.artifact.id } })).toBe(2);
    expect(await db.textRevision.findUnique({ where: { id: f.revision.id } })).toEqual(f.revision);
  });

  it.each(['missing', 'null'] as const)('rejects a manual save with a %s token when a current revision exists', async (token) => {
    const f = await fixture();
    const body: Record<string, unknown> = { action: 'revise', intakeId: f.intake.id, text: '未携带当前版本的合成校正稿。' };
    if (token === 'null') body.textRevisionId = null;
    const response = await action(body);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('TEXT_REVISION_STALE');
    expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(f.intake);
    expect(await db.textRevision.count({ where: { sourceId: f.artifact.id } })).toBe(1);
  });

  it('allows an initial image manual revision with an explicit null token and replays an unchanged current save', async () => {
    const bytes = Buffer.concat([png, Buffer.from(randomUUID())]);
    const form = new FormData();
    form.set('file', new File([bytes], 'synthetic-first-manual.png', { type: 'image/png' }));
    const uploaded = await post(new Request('http://localhost/api/intakes', { method: 'POST', body: form }));
    expect(uploaded.status).toBe(200);
    const source = (await uploaded.json()) as { intakeId: string; sourceArtifactId: string; textRevisionId: null };
    intakeIds.push(source.intakeId); sourceIds.push(source.sourceArtifactId);
    expect(source.textRevisionId).toBeNull();
    const text = '首张图片的合成手工校正稿。';
    const missing = await action({ action: 'revise', intakeId: source.intakeId, text });
    expect(missing.status).toBe(409);
    expect((await missing.json()).error.code).toBe('TEXT_REVISION_STALE');
    expect(await db.textRevision.count({ where: { sourceId: source.sourceArtifactId } })).toBe(0);
    const saved = await action({ action: 'revise', intakeId: source.intakeId, textRevisionId: null, text });
    expect(saved.status).toBe(200);
    const revised = await db.intake.findUniqueOrThrow({ where: { id: source.intakeId } });
    expect(await db.textRevision.findUnique({ where: { id: revised.textRevisionId! } })).toMatchObject({ sourceId: source.sourceArtifactId, parentId: null, text, method: 'manual' });
    await action({ action: 'approve', intakeId: source.intakeId, textRevisionId: revised.textRevisionId });
    const current = await db.intake.findUniqueOrThrow({ where: { id: source.intakeId } });
    const replay = await action({ action: 'revise', intakeId: source.intakeId, textRevisionId: current.textRevisionId, text });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ intakeId: source.intakeId, textRevisionId: current.textRevisionId, approved: true, replayed: true });
    expect(await db.intake.findUnique({ where: { id: source.intakeId } })).toEqual(current);
    expect(await db.textRevision.count({ where: { sourceId: source.sourceArtifactId } })).toBe(1);
  });

  it('does not approve an old revision over a new current text', async () => {
    const f = await fixture();
    expect((await action({ action: 'revise', intakeId: f.intake.id, textRevisionId: f.revision.id, text: '合成校正新稿，需报名表。' })).status).toBe(200);
    const current = await db.intake.findUniqueOrThrow({ where: { id: f.intake.id } });
    const response = await action({ action: 'approve', intakeId: f.intake.id, textRevisionId: f.revision.id });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('TEXT_REVISION_STALE');
    expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(current);
  });

  it('does not send an old approved revision to the provider after a newer revision is approved', async () => {
    const f = await fixture();
    await action({ action: 'revise', intakeId: f.intake.id, textRevisionId: f.revision.id, text: '合成校正新稿，需报名表。' });
    const revised = await db.intake.findUniqueOrThrow({ where: { id: f.intake.id } });
    await action({ action: 'approve', intakeId: f.intake.id, textRevisionId: revised.textRevisionId });
    const current = await db.intake.findUniqueOrThrow({ where: { id: f.intake.id } });
    const calls = providerCalls;
    const response = await action({ action: 'extract', intakeId: f.intake.id, textRevisionId: f.revision.id });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('TEXT_REVISION_STALE');
    expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(current);
    expect(providerCalls).toBe(calls);
  });

  it('links a new OCR revision to its previous revision and clears its candidate and approval atomically', async () => {
    const f = await fixture();
    const response = await action({ action: 'recognize', intakeId: f.intake.id });
    expect(response.status).toBe(200);
    const current = await db.intake.findUniqueOrThrow({ where: { id: f.intake.id } });
    expect(current).toMatchObject({ approved: false, candidateJson: null, stage: 'text_review' });
    expect(current.textRevisionId).not.toBe(f.revision.id);
    expect(await db.textRevision.findUnique({ where: { id: current.textRevisionId! } })).toMatchObject({ parentId: f.revision.id, method: 'ocr', sourceId: f.artifact.id });
    expect(await db.textRevision.findUnique({ where: { id: f.revision.id } })).toEqual(f.revision);
  });

  it.each([
    ['recognize', 'revise'], ['recognize', 'applied'], ['extract', 'revise'], ['extract', 'applied'],
  ] as const)('does not overwrite a draft after %s finishes following %s', async (name, transition) => {
    const f = await fixture();
    const normalRespond = respond;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    respond = async (body) => { entered(); await gate; return normalRespond(body); };
    const pending = action({ action: name, intakeId: f.intake.id, textRevisionId: f.revision.id });
    let current: typeof f.intake;
    try {
      await started;
      if (transition === 'revise') await action({ action: 'revise', intakeId: f.intake.id, textRevisionId: f.revision.id, text: '用户在识别等待期间保存的合成校正稿。' });
      else await db.intake.update({ where: { id: f.intake.id }, data: { stage: 'applied' } });
      current = await db.intake.findUniqueOrThrow({ where: { id: f.intake.id } });
    } finally {
      release();
      respond = normalRespond;
    }
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe(transition === 'applied' ? 'INTAKE_ALREADY_APPLIED' : 'TEXT_REVISION_STALE');
    expect(await db.intake.findUnique({ where: { id: f.intake.id } })).toEqual(current);
    expect(await db.textRevision.count({ where: { sourceId: f.artifact.id } })).toBe(transition === 'revise' ? 2 : 1);
    expect(await db.task.count({ where: { caseId: { notIn: caseIds } } })).toBe(0);
  });
});
