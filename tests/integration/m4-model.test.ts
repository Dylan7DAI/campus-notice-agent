import { PrismaClient } from '@prisma/client';
import { describe, expect, it, afterEach } from 'vitest';
import { ModelRunner } from '../../src/application/model-runner';
import { ModelClientError } from '../../src/application/glm-client';
import { evidenceCatalog } from '../../src/application/notice-candidate';
import * as prompts from '../../src/application/prompts';
const { PROMPT_VERSION } = prompts;

const db = new PrismaClient();
afterEach(async () => {
  await db.agentRun.deleteMany(); await db.intake.deleteMany(); await db.textApproval.deleteMany(); await db.textRevision.deleteMany(); await db.sourceArtifact.deleteMany();
});

const candidate = (revisionId: string, evidence = 'seg-1') => JSON.stringify({ schema_version: '1.0', text_revision_id: revisionId, relation: { kind: 'new', target_case_id: null, evidence_refs: [evidence] }, facts: [{ id: 'f1', field: 'title', value: 'Campus item', evidence_refs: [evidence] }, { id: 'f2', field: 'requirement_add', value: 'Form A', evidence_refs: [evidence] }], questions: [] });

describe('M4 model runner', () => {
  it('sends the strict candidate request so due fields are accepted without weakening the parser', async () => {
    const artifactId = 'm4-artifact-request-contract'; const intakeId = 'm4-intake-request-contract'; const revisionId = 'm4-revision-request-contract';
    const text = 'SYNTHETIC OPEN DAY\nCATEGORY EVENT CHANGE\nDUE DATE 2030-05-18 UTC exclusive\nMATERIAL VISITOR PASS\nLOCATION ROOM C';
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: artifactId, mediaType: 'text/plain', privateStorageKey: 'unused.txt', originLabel: 'synthetic', size: text.length } });
    await db.textRevision.create({ data: { id: revisionId, sourceId: artifactId, text, method: 'manual' } });
    await db.intake.create({ data: { id: intakeId, text, textRevisionId: revisionId, sourceArtifactId: artifactId } });
    const valid = JSON.stringify({ schema_version: '1.0', text_revision_id: revisionId, relation: { kind: 'new', target_case_id: null, evidence_refs: [] }, facts: [
      { id: 'f1', field: 'title', value: 'SYNTHETIC OPEN DAY', evidence_refs: ['seg-1'] },
      { id: 'f2', field: 'category', value: 'event_change', evidence_refs: ['seg-2'] },
      { id: 'f3', field: 'due', value: { kind: 'date', date: '2030-05-18', timezone: 'UTC', boundary: 'exclusive', raw: 'DUE DATE 2030-05-18 UTC exclusive' }, evidence_refs: ['seg-3'] },
      { id: 'f4', field: 'requirement_add', value: 'VISITOR PASS', evidence_refs: ['seg-4'] },
      { id: 'f5', field: 'location', value: 'ROOM C', evidence_refs: ['seg-5'] },
    ], questions: [] });
    const requests: string[] = [];
    // Contract-dependent stub verifies request selection, not model quality.
    const fake = { chatWithImage: async () => ({ text: '{}', raw: {} }), chat: async (prompt: string) => { requests.push(prompt); return { text: prompt.includes('date 分支恰好包含 kind、date、timezone、boundary、raw') ? valid : '{"facts":[]}', raw: {} }; } };
    const runner = new ModelRunner(db, fake, 'fixture', 'fixture-text');
    const output = await runner.extract({ intakeId, textRevisionId: revisionId, text });
    expect(output.candidate?.facts).toHaveLength(5); expect(output.callCount).toBe(1);
    expect(requests[0]).toBe(prompts.buildExtractionRequestPrompt({ textRevisionId: revisionId, text, evidenceCatalog: evidenceCatalog(text) }));
  });

  it('restores a malformed update only using the original revision, text, evidence and selected target', async () => {
    const artifactId = 'm4-artifact-request-repair'; const intakeId = 'm4-intake-request-repair'; const revisionId = 'm4-revision-request-repair';
    const text = 'SYNTHETIC UPDATED NOTICE\nUPDATE VERSION 2\nMATERIAL ORIGINAL FORM';
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: artifactId, mediaType: 'text/plain', privateStorageKey: 'unused.txt', originLabel: 'synthetic', size: text.length } });
    await db.textRevision.create({ data: { id: revisionId, sourceId: artifactId, text, method: 'manual' } });
    await db.intake.create({ data: { id: intakeId, text, textRevisionId: revisionId, sourceArtifactId: artifactId } });
    const requests: string[] = [];
    const fake = { chatWithImage: async () => ({ text: '{}', raw: {} }), chat: async (prompt: string) => {
      requests.push(prompt);
      const hasOriginalContext = prompt.includes('原始请求上下文') && prompt.includes(revisionId) && prompt.includes('SYNTHETIC UPDATED NOTICE') && prompt.includes('evidenceCatalog') && prompt.includes('synthetic-case-selected') && prompt.includes('synthetic-task-selected');
      return { text: requests.length === 1 || !hasOriginalContext ? '{"facts":[]}' : JSON.stringify({ schema_version: '1.0', text_revision_id: revisionId, relation: { kind: 'update', target_case_id: 'synthetic-case-selected', evidence_refs: ['seg-2'] }, facts: [{ id: 'f1', field: 'title', value: 'SYNTHETIC UPDATED NOTICE', evidence_refs: ['seg-1'] }], questions: [] }), raw: {} };
    } };
    const runner = new ModelRunner(db, fake, 'fixture', 'fixture-text');
    const output = await runner.extract({ intakeId, textRevisionId: revisionId, text, selectedCaseId: 'synthetic-case-selected', selectedTaskId: 'synthetic-task-selected' });
    expect(output.candidate?.relation).toMatchObject({ kind: 'update', target_case_id: 'synthetic-case-selected' });
    expect(output.callCount).toBe(2); expect(output.retryCount).toBe(0);
    expect(requests[1]).toContain('上一次输出是不可信数据');
    expect((await db.intake.findUnique({ where: { id: intakeId } }))?.text).toBe(text);
  });

  it('accepts the OCR-only first response without a candidate schema or structural repair', async () => {
    const artifactId = 'm4-artifact-ocr-contract'; const intakeId = 'm4-intake-ocr-contract';
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: artifactId, mediaType: 'image/png', privateStorageKey: 'unused.png', originLabel: 'synthetic', size: 1 } });
    await db.intake.create({ data: { id: intakeId, text: '[image]', sourceArtifactId: artifactId } });
    let repairs = 0;
    // Stub only models conflicting output contracts; this is not quality evidence.
    const textClient = { chatWithImage: async () => ({ text: '{}', raw: {} }), chat: async () => { repairs++; return { text: '{}', raw: {} }; } };
    const visionClient = { chat: async () => ({ text: '{}', raw: {} }), chatWithImage: async (prompt: string) => ({ text: /schema_version|text_revision_id|facts|questions/.test(prompt) ? candidate('unavailable-revision') : JSON.stringify({ text: '志愿报名\n提交报名表' }), raw: {} }) };
    const runner = new ModelRunner(db, textClient, 'fixture', 'fixture-text', visionClient, 'fixture-vision');
    const output = await runner.recognizeImage({ intakeId, artifactId, storageKey: 'unused.png', mediaType: 'image/png', bytes: Buffer.from([1]) });
    expect(output.text).toBe('志愿报名\n提交报名表'); expect(output.callCount).toBe(1); expect(repairs).toBe(0);
    const run = await db.agentRun.findUnique({ where: { id: output.runId } });
    expect(run?.promptVersion).toBe(PROMPT_VERSION); expect(run?.model).toBe('fixture-vision');
  });

  it('uses the original text client for one OCR-only repair and preserves the draft', async () => {
    const artifactId = 'm4-artifact-ocr-repair'; const intakeId = 'm4-intake-ocr-repair';
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: artifactId, mediaType: 'image/png', privateStorageKey: 'unused.png', originLabel: 'synthetic', size: 1 } });
    await db.intake.create({ data: { id: intakeId, text: '[image]', sourceArtifactId: artifactId } });
    let repairs = 0;
    const textClient = { chatWithImage: async () => { throw new Error('TEXT_CLIENT_IMAGE_MUST_NOT_RUN'); }, chat: async (prompt: string) => { repairs++; return { text: /schema_version|text_revision_id|facts|questions/.test(prompt) ? candidate('unavailable-revision') : JSON.stringify({ text: '志愿报名\n[无法辨认]' }), raw: {} }; } };
    const visionClient = { chat: async () => { throw new Error('VISION_CLIENT_REPAIR_MUST_NOT_RUN'); }, chatWithImage: async () => ({ text: 'not valid JSON', raw: {} }) };
    const runner = new ModelRunner(db, textClient, 'fixture', 'fixture-text', visionClient, 'fixture-vision');
    const output = await runner.recognizeImage({ intakeId, artifactId, storageKey: 'unused.png', mediaType: 'image/png', bytes: Buffer.from([1]) });
    expect(output.text).toBe('志愿报名\n[无法辨认]'); expect(output.callCount).toBe(2); expect(output.retryCount).toBe(0); expect(repairs).toBe(1);
    expect((await db.intake.findUnique({ where: { id: intakeId } }))?.text).toBe('[image]');
    const run = await db.agentRun.findUnique({ where: { id: output.runId } });
    expect(run?.status).toBe('succeeded'); expect(run?.promptVersion).toBe(PROMPT_VERSION);
  });

  it('persists image and extraction runs while enforcing evidence refs', async () => {
    const artifactId = 'm4-artifact-1'; const intakeId = 'm4-intake-1'; const revisionId = 'm4-revision-1';
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: 'm4-sha-1', mediaType: 'image/png', privateStorageKey: 'unused.png', originLabel: 'synthetic', size: 3 } });
    await db.intake.create({ data: { id: intakeId, text: '[image]', sourceArtifactId: artifactId } });
    const fake = { chatWithImage: async () => ({ text: JSON.stringify({ text: 'Campus item.' }), raw: {} }), chat: async () => ({ text: candidate(revisionId), raw: {} }) };
    const runner = new ModelRunner(db, fake, 'fixture', 'fixture-model');
    const vision = await runner.recognizeImage({ intakeId, artifactId, storageKey: 'unused.png', mediaType: 'image/png', bytes: Buffer.from([1, 2, 3]) });
    expect(vision.text).toBe('Campus item.');
    await db.textRevision.create({ data: { id: revisionId, sourceId: artifactId, text: 'Campus item.', method: 'ocr' } });
    const extraction = await runner.extract({ intakeId, textRevisionId: revisionId, text: 'Campus item.' });
    expect(extraction.candidate?.facts[0]?.evidence_refs).toEqual(['seg-1']);
    const runs = await db.agentRun.findMany({ orderBy: { startedAt: 'asc' } });
    expect(runs).toHaveLength(2); expect(runs.every((run) => run.status === 'succeeded')).toBe(true); expect(runs.every((run) => run.callCount <= 3)).toBe(true);
  });

  it('allows one structural repair but rejects unverifiable evidence', async () => {
    const artifactId = 'm4-artifact-2'; const intakeId = 'm4-intake-2'; const revisionId = 'm4-revision-2';
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: 'm4-sha-2', mediaType: 'image/png', privateStorageKey: 'unused.png', originLabel: 'synthetic', size: 3 } });
    await db.intake.create({ data: { id: intakeId, text: '[image]', sourceArtifactId: artifactId } });
    let extractionCalls = 0;
    const fake = { chatWithImage: async () => ({ text: 'invalid', raw: {} }), chat: async (prompt: string) => { extractionCalls += 1; if (prompt.includes('视觉识别')) return { text: JSON.stringify({ text: 'Campus item.' }), raw: {} }; return { text: candidate(revisionId, 'seg-99'), raw: {} }; } };
    const runner = new ModelRunner(db, fake, 'fixture', 'fixture-model');
    const vision = await runner.recognizeImage({ intakeId, artifactId, storageKey: 'unused.png', mediaType: 'image/png', bytes: Buffer.from([1]) });
    expect(vision.text).toBe('Campus item.'); expect(extractionCalls).toBe(1);
    await db.textRevision.create({ data: { id: revisionId, sourceId: artifactId, text: 'Campus item.', method: 'ocr' } });
    await expect(runner.extract({ intakeId, textRevisionId: revisionId, text: 'Campus item.' })).rejects.toThrow('EVIDENCE_INVALID');
    const failed = await db.agentRun.findFirst({ where: { stage: 'extraction' } }); expect(failed?.status).toBe('failed'); expect(failed?.callCount).toBe(1);
  });

  it('repairs a structurally valid JSON object that violates the due contract once', async () => {
    const artifactId = 'm4-artifact-3'; const intakeId = 'm4-intake-3'; const revisionId = 'm4-revision-3';
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: 'm4-sha-3', mediaType: 'image/png', privateStorageKey: 'unused.png', originLabel: 'synthetic', size: 1 } });
    await db.intake.create({ data: { id: intakeId, text: '[image]', sourceArtifactId: artifactId } });
    let calls = 0; const invalidDue = candidate(revisionId).replace('"questions":[]', '"questions":[],"extra":"ignored"');
    const fake = { chatWithImage: async () => ({ text: JSON.stringify({ text: 'Campus item.' }), raw: {} }), chat: async () => ({ text: calls++ === 0 ? invalidDue : candidate(revisionId), raw: {} }) };
    const runner = new ModelRunner(db, fake, 'fixture', 'fixture-model');
    await db.textRevision.create({ data: { id: revisionId, sourceId: artifactId, text: 'Campus item.', method: 'ocr' } });
    const result = await runner.extract({ intakeId, textRevisionId: revisionId, text: 'Campus item.' });
    expect(result.candidate?.schema_version).toBe('1.0'); expect((await db.agentRun.findFirst({ where: { id: result.runId } }))?.callCount).toBe(2);
  });

  it('does not retry or overwrite a user-cancelled run', async () => {
    const artifactId = 'm4-artifact-cancel'; const intakeId = 'm4-intake-cancel';
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: 'm4-sha-cancel', mediaType: 'image/png', privateStorageKey: 'unused.png', originLabel: 'synthetic', size: 1 } });
    await db.intake.create({ data: { id: intakeId, text: '[image]', sourceArtifactId: artifactId } });
    const fake = { chatWithImage: async (_prompt: string, _dataUrl: string, signal?: AbortSignal) => await new Promise<never>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new ModelClientError('MODEL_TIMEOUT', true)), { once: true }); }), chat: async () => ({ text: '{}', raw: {} }) };
    const runner = new ModelRunner(db, fake, 'fixture', 'fixture-model');
    const pending = runner.recognizeImage({ intakeId, artifactId, storageKey: 'unused.png', mediaType: 'image/png', bytes: Buffer.from([1]) });
    const outcome = pending.then(() => null, (error: unknown) => error);
    let run = await db.agentRun.findFirst({ where: { intakeId }, orderBy: { startedAt: 'desc' } });
    for (let attempt = 0; !run && attempt < 20; attempt++) { await new Promise((resolve) => setTimeout(resolve, 5)); run = await db.agentRun.findFirst({ where: { intakeId }, orderBy: { startedAt: 'desc' } }); }
    expect(run).toBeTruthy();
    await runner.cancel(run!.id);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('MODEL_CANCELLED');
    const cancelled = await db.agentRun.findUnique({ where: { id: run!.id } });
    expect(cancelled?.status).toBe('cancelled'); expect(cancelled?.callCount).toBe(1); expect(cancelled?.retryCount).toBe(0);
  });
});
