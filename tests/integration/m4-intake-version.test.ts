import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { IntakeService } from '../../src/application/intake-service';
import type { NoticeCandidate } from '../../src/application/notice-candidate';
import { POST } from '../../src/app/api/intakes/route';

const db = new PrismaClient();
const fixtures: Array<{ intakeId: string; artifactId: string; revisionId: string }> = [];
const caseIds: string[] = [];
const commandKeys: string[] = [];

function key() {
  const value = `m4-version-key-${randomUUID()}`;
  commandKeys.push(value);
  return value;
}

async function approvedCandidate(caseId?: string) {
  const id = randomUUID();
  const fixture = { intakeId: `m4-version-intake-${id}`, artifactId: `m4-version-artifact-${id}`, revisionId: `m4-version-revision-${id}` };
  fixtures.push(fixture);
  const date = caseId ? '2026-10-11' : '2026-10-10';
  const text = `Campus submission.\nDUE DATE ${date}\nLOCATION ROOM A\nMATERIAL FORM A`;
  const candidate = {
    schema_version: '1.0', text_revision_id: fixture.revisionId,
    relation: { kind: caseId ? 'update' : 'new', target_case_id: caseId ?? null, evidence_refs: ['seg-1'] },
    facts: [
      { id: 'title', field: 'title', value: 'Campus submission', evidence_refs: ['seg-1'] },
      { id: 'category', field: 'category', value: 'submission', evidence_refs: ['seg-1'] },
      { id: 'due', field: 'due', value: { kind: 'date', date, timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: `DUE DATE ${date}` }, evidence_refs: ['seg-2'] },
      { id: 'location', field: 'location', value: 'ROOM A', evidence_refs: ['seg-3'] },
      { id: 'requirement', field: 'requirement_add', value: 'FORM A', evidence_refs: ['seg-4'] },
    ], questions: [],
  };
  await db.sourceArtifact.create({ data: { id: fixture.artifactId, sha256: id, mediaType: 'text/plain', privateStorageKey: `synthetic/${id}`, originLabel: 'synthetic version fixture', size: Buffer.byteLength(text) } });
  await db.textRevision.create({ data: { id: fixture.revisionId, sourceId: fixture.artifactId, text, method: 'manual' } });
  await db.intake.create({ data: { id: fixture.intakeId, sourceArtifactId: fixture.artifactId, textRevisionId: fixture.revisionId, text, approved: true, stage: 'proposal_ready', candidateJson: JSON.stringify(candidate) } });
  await db.textApproval.create({ data: { id: `m4-version-approval-${id}`, intakeId: fixture.intakeId, textRevisionId: fixture.revisionId } });
  return fixture;
}

async function existingTarget() {
  const id = randomUUID();
  const caseId = `m4-version-case-${id}`;
  const taskId = `m4-version-task-${id}`;
  caseIds.push(caseId);
  await db.case.create({ data: { id: caseId, title: 'Campus submission', category: 'submission' } });
  await db.task.create({ data: { id: taskId, caseId, title: 'Campus submission', location: 'ROOM A' } });
  const fixture = await approvedCandidate(caseId);
  return { ...fixture, caseId, taskId };
}

async function post(body: Record<string, unknown>) {
  const response = await POST(new Request('http://localhost/api/intakes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: response.status, data: await response.json() };
}

afterEach(async () => {
  const intakeIds = fixtures.map((fixture) => fixture.intakeId);
  const revisionIds = fixtures.map((fixture) => fixture.revisionId);
  const artifactIds = fixtures.map((fixture) => fixture.artifactId);
  const tasks = await db.task.findMany({ where: { caseId: { in: caseIds } }, select: { id: true } });
  const proposals = await db.changeProposal.findMany({ where: { caseId: { in: caseIds } }, select: { id: true } });
  const proposalIds = proposals.map((proposal) => proposal.id);
  await db.proposalApplication.deleteMany({ where: { proposalId: { in: proposalIds } } });
  await db.proposalOperation.deleteMany({ where: { proposalId: { in: proposalIds } } });
  await db.changeProposal.deleteMany({ where: { id: { in: proposalIds } } });
  await db.noticeRelation.deleteMany({ where: { caseId: { in: caseIds } } });
  await db.noticeRevision.deleteMany({ where: { caseId: { in: caseIds } } });
  await db.auditEvent.deleteMany({ where: { caseId: { in: caseIds } } });
  await db.commandResult.deleteMany({ where: { idempotencyKey: { in: commandKeys } } });
  await db.requirement.deleteMany({ where: { taskId: { in: tasks.map((task) => task.id) } } });
  await db.task.deleteMany({ where: { caseId: { in: caseIds } } });
  await db.case.deleteMany({ where: { id: { in: caseIds } } });
  await db.textApproval.deleteMany({ where: { intakeId: { in: intakeIds } } });
  await db.intake.deleteMany({ where: { id: { in: intakeIds } } });
  await db.evidence.deleteMany({ where: { textRevisionId: { in: revisionIds } } });
  await db.textRevision.deleteMany({ where: { id: { in: revisionIds } } });
  await db.sourceArtifact.deleteMany({ where: { id: { in: artifactIds } } });
  fixtures.length = 0; caseIds.length = 0; commandKeys.length = 0;
});

afterAll(async () => { await db.$disconnect(); });

describe('M4 intake revision confirmation regressions', () => {
  it('persists a new candidate location so the same location is valid update context', async () => {
    const fixture = await approvedCandidate();
    const service = new IntakeService(db);
    const result = await service.apply(fixture.intakeId, key());
    caseIds.push(result.caseId);
    expect((await db.task.findUniqueOrThrow({ where: { id: result.taskId } })).location).toBe('ROOM A');
    expect((await service.preview(fixture.intakeId)).caseVersion).toBeNull();
    const update = await approvedCandidate(result.caseId);
    const preview = await service.preview(update.intakeId, result.caseId, result.taskId);
    expect(preview.caseVersion).toBe(1);
    expect(preview.operations.map((operation) => operation.op)).toEqual(['set_due']);
  });

  it('rejects update application without the preview case version', async () => {
    const fixture = await existingTarget();
    const service = new IntakeService(db);
    await expect(service.apply(fixture.intakeId, key(), fixture.caseId, fixture.taskId)).rejects.toThrow('VERSION_CONFLICT');
    expect((await db.case.findUniqueOrThrow({ where: { id: fixture.caseId } })).version).toBe(1);
    expect(await db.changeProposal.count({ where: { caseId: fixture.caseId } })).toBe(0);
  });

  it('rejects a previously previewed update after an unrelated case version change', async () => {
    const fixture = await existingTarget();
    const service = new IntakeService(db);
    await service.preview(fixture.intakeId, fixture.caseId, fixture.taskId);
    await db.case.update({ where: { id: fixture.caseId }, data: { version: { increment: 1 } } });
    await expect(service.apply(fixture.intakeId, key(), fixture.caseId, fixture.taskId, 1)).rejects.toThrow('VERSION_CONFLICT');
    expect((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).dueJson).toBeNull();
    expect(await db.auditEvent.count({ where: { caseId: fixture.caseId } })).toBe(0);
    expect(await db.changeProposal.count({ where: { caseId: fixture.caseId } })).toBe(0);
  });

  it('binds the HTTP preview hash to version changes even when its operations are unchanged', async () => {
    const fixture = await existingTarget();
    const preview = await post({ action: 'preview', intakeId: fixture.intakeId, selectedCaseId: fixture.caseId, selectedTaskId: fixture.taskId });
    expect(preview.status).toBe(200);
    await db.case.update({ where: { id: fixture.caseId }, data: { version: { increment: 1 } } });
    const response = await post({ action: 'confirm', intakeId: fixture.intakeId, selectedCaseId: fixture.caseId, selectedTaskId: fixture.taskId, previewHash: preview.data.previewHash, idempotencyKey: key() });
    expect(response.status).toBe(409);
    expect(response.data.error.code).toBe('PREVIEW_STALE');
    expect((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).dueJson).toBeNull();
    expect(await db.auditEvent.count({ where: { caseId: fixture.caseId } })).toBe(0);
    expect(await db.changeProposal.count({ where: { caseId: fixture.caseId } })).toBe(0);
  });

  it('replays the same confirmed update before stale checks and rejects changed request identity', async () => {
    const fixture = await existingTarget();
    const preview = await post({ action: 'preview', intakeId: fixture.intakeId, selectedCaseId: fixture.caseId, selectedTaskId: fixture.taskId });
    const body = { action: 'confirm', intakeId: fixture.intakeId, selectedCaseId: fixture.caseId, selectedTaskId: fixture.taskId, previewHash: preview.data.previewHash, idempotencyKey: key() };
    const first = await post(body);
    expect(first.status).toBe(200);
    expect(first.data.caseVersion).toBe(2);
    await db.case.update({ where: { id: fixture.caseId }, data: { version: { increment: 1 } } });
    const replay = await post(body);
    expect(replay.status).toBe(200);
    expect(replay.data).toMatchObject({ caseId: fixture.caseId, taskId: fixture.taskId, caseVersion: 2, commandId: first.data.commandId, replayed: true });
    const changed = await post({ ...body, previewHash: 'different-preview-hash' });
    expect(changed.status).toBe(409);
    expect(changed.data.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await db.case.findUniqueOrThrow({ where: { id: fixture.caseId } })).version).toBe(3);
    expect(await db.auditEvent.count({ where: { caseId: fixture.caseId } })).toBe(1);
    expect(await db.proposalApplication.count({ where: { proposalId: first.data.proposalId } })).toBe(1);
  });

  it('binds service replay to the original expected version and stored candidate', async () => {
    const fixture = await existingTarget();
    const service = new IntakeService(db);
    const commandKey = key();
    const first = await service.apply(fixture.intakeId, commandKey, fixture.caseId, fixture.taskId, 1);
    const replay = await service.apply(fixture.intakeId, commandKey, fixture.caseId, fixture.taskId, 1);
    expect(replay).toMatchObject({ caseId: fixture.caseId, taskId: fixture.taskId, commandId: first.commandId, caseVersion: 2, replayed: true });
    await expect(service.apply(fixture.intakeId, commandKey, fixture.caseId, fixture.taskId, 2)).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    const stored = await db.intake.findUniqueOrThrow({ where: { id: fixture.intakeId } });
    const candidate = JSON.parse(stored.candidateJson!) as NoticeCandidate;
    candidate.questions.push({ id: 'changed-note', field: 'note', prompt: 'Synthetic changed candidate', blocking: false });
    await db.intake.update({ where: { id: fixture.intakeId }, data: { candidateJson: JSON.stringify(candidate) } });
    await expect(service.apply(fixture.intakeId, commandKey, fixture.caseId, fixture.taskId, 1)).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    expect(await db.auditEvent.count({ where: { caseId: fixture.caseId } })).toBe(1);
    expect(await db.commandResult.count({ where: { idempotencyKey: commandKey } })).toBe(1);
  });
});
