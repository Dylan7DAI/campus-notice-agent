import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { GET as getTasks } from '../../src/app/api/tasks/route';
import { POST as postCommand } from '../../src/app/api/commands/route';
import { POST as postIntake } from '../../src/app/api/intakes/route';
import { POST as postDemoCandidate } from '../../src/app/api/demo/candidate/route';
import { GET as getCalendar } from '../../src/app/api/tasks/[id]/calendar.ics/route';
import { demoSamples } from '../../src/demo/samples';

const db = new PrismaClient();
const token = randomUUID();
const savedIntakeIds: string[] = [];
const savedSourceIds: string[] = [];
const appliedCaseIds: string[] = [];
const previousDemoMode = process.env.DEMO_MODE;

async function saveText(text: string) {
  const response = await postIntake(new Request('http://localhost/api/intakes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', text }) }));
  const draft = (await response.json()) as { intakeId: string; textRevisionId: string };
  savedIntakeIds.push(draft.intakeId);
  const intake = await db.intake.findUniqueOrThrow({ where: { id: draft.intakeId } });
  if (intake.sourceArtifactId) savedSourceIds.push(intake.sourceArtifactId);
  return draft;
}

function intakeAction(body: Record<string, unknown>) {
  return postIntake(new Request('http://localhost/api/intakes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

function demoCandidate(body: Record<string, unknown>, origin?: string) {
  return postDemoCandidate(new Request('http://localhost/api/demo/candidate', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }));
}
const ids = {
  caseId: `demo-projection-case-${token}`,
  taskId: `demo-projection-task-${token}`,
  requirementId: `demo-projection-requirement-${token}`,
  sourceId: `demo-projection-source-${token}`,
  revisionId: `demo-projection-revision-${token}`,
  noticeId: `demo-projection-notice-${token}`,
  evidenceId: `demo-projection-evidence-${token}`,
};

function command(body: Record<string, unknown>) {
  return postCommand(new Request('http://localhost/api/commands', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

type TaskProjection = {
  id: string;
  caseVersion: number;
  requirements: Array<{ id: string; label: string; active: boolean; satisfaction: string }>;
  completionRecords: Array<{ coveredRequirementIds: string[]; statement: string; coveredEpoch: number }>;
  sources: Array<{ id: string; text: string; textRevisionId: string; evidence: Array<{ quote: string; origin: string }> }>;
};

describe('local demo material and evidence projection', () => {
  it('reopens an identical saved text without duplicating its draft or immutable revisions', async () => {
    const text = `合成重复保存回归 ${token}：提交报名表。`;
    const save = () => postIntake(new Request('http://localhost/api/intakes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', text }) }));
    const firstResponse = await save();
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as { intakeId: string; textRevisionId: string };
    savedIntakeIds.push(first.intakeId);
    const intake = await db.intake.findUniqueOrThrow({ where: { id: first.intakeId } });
    if (intake.sourceArtifactId) savedSourceIds.push(intake.sourceArtifactId);
    const secondResponse = await save();
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({ intakeId: first.intakeId, textRevisionId: first.textRevisionId, replayed: true });
    expect(await db.intake.count({ where: { sourceArtifactId: intake.sourceArtifactId } })).toBe(1);
    expect(await db.textRevision.count({ where: { sourceId: intake.sourceArtifactId! } })).toBe(1);
  });

  it('preserves the previous text revision and invalidates approval and candidate after correction', async () => {
    process.env.DEMO_MODE = '1';
    const draft = await saveText(demoSamples.original.text);
    const original = await db.textRevision.findUniqueOrThrow({ where: { id: draft.textRevisionId } });
    await intakeAction({ action: 'approve', intakeId: draft.intakeId, textRevisionId: original.id });
    const generated = await demoCandidate({ intakeId: draft.intakeId, sampleId: 'original' });
    expect(generated.status).toBe(200);
    const candidate = await db.intake.findUniqueOrThrow({ where: { id: draft.intakeId } });
    expect(JSON.parse(candidate.candidateJson!)).toMatchObject({ schema_version: '1.0', text_revision_id: original.id });
    const text = `合成校正新稿 ${token}：报名需报名表。`;
    const corrected = await intakeAction({ action: 'revise', intakeId: draft.intakeId, textRevisionId: original.id, text });
    expect(corrected.status).toBe(200);
    const saved = await db.intake.findUniqueOrThrow({ where: { id: draft.intakeId } });
    expect(saved).toMatchObject({ text, approved: false, candidateJson: null, stage: 'text_review' });
    expect(saved.textRevisionId).not.toBe(original.id);
    expect(await db.textRevision.findUnique({ where: { id: original.id } })).toMatchObject({ text: original.text });
    expect(await db.textRevision.findUnique({ where: { id: saved.textRevisionId! } })).toMatchObject({ sourceId: original.sourceId, parentId: original.id, method: 'manual', text });
  });

  it('gates the demo and only builds candidates for an exact approved synthetic sample', async () => {
    delete process.env.DEMO_MODE;
    expect((await demoCandidate({ intakeId: 'missing', sampleId: 'original' })).status).toBe(404);
    process.env.DEMO_MODE = '1';
    const draft = await saveText(demoSamples.original.text);
    const before = await db.task.count();
    expect((await demoCandidate({ intakeId: draft.intakeId, sampleId: 'original' })).status).toBe(422);
    await intakeAction({ action: 'approve', intakeId: draft.intakeId, textRevisionId: draft.textRevisionId });
    expect((await demoCandidate({ intakeId: draft.intakeId, sampleId: 'original' }, 'http://evil.example')).status).toBe(403);
    const generated = await demoCandidate({ intakeId: draft.intakeId, sampleId: 'original' });
    expect(generated.status).toBe(200);
    expect(await db.task.count()).toBe(before);
    const mismatch = await saveText(`${demoSamples.original.text}\n合成附加文字。`);
    await intakeAction({ action: 'approve', intakeId: mismatch.intakeId, textRevisionId: mismatch.textRevisionId });
    expect((await demoCandidate({ intakeId: mismatch.intakeId, sampleId: 'original' })).status).toBe(422);

    const preview = await intakeAction({ action: 'preview', intakeId: draft.intakeId });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { previewHash: string; preview: { due: { value: string } } };
    expect(previewBody.preview.due.value).toBe('2026-10-23');
    const confirmation = await intakeAction({ action: 'confirm', intakeId: draft.intakeId, previewHash: previewBody.previewHash, idempotencyKey: `demo-sample-confirm-${token}` });
    expect(confirmation.status).toBe(200);
    const committed = (await confirmation.json()) as { caseId: string; taskId: string };
    appliedCaseIds.push(committed.caseId);
    expect(await db.requirement.findFirst({ where: { taskId: committed.taskId } })).toMatchObject({ label: '报名表', satisfaction: 'missing' });
    expect(await db.evidence.count({ where: { textRevisionId: draft.textRevisionId } })).toBeGreaterThan(0);

    const update = await saveText(demoSamples.update.text);
    await intakeAction({ action: 'approve', intakeId: update.intakeId, textRevisionId: update.textRevisionId });
    expect((await demoCandidate({ intakeId: update.intakeId, sampleId: 'update' })).status).toBe(422);
    expect((await demoCandidate({ intakeId: update.intakeId, sampleId: 'update', selectedCaseId: committed.caseId, selectedTaskId: committed.taskId })).status).toBe(200);
  });

  it('keeps an unknown deadline unknown and blocks a precise calendar export', async () => {
    process.env.DEMO_MODE = '1';
    const draft = await saveText(demoSamples.unknown.text);
    await intakeAction({ action: 'approve', intakeId: draft.intakeId, textRevisionId: draft.textRevisionId });
    expect((await demoCandidate({ intakeId: draft.intakeId, sampleId: 'unknown' })).status).toBe(200);
    const preview = await intakeAction({ action: 'preview', intakeId: draft.intakeId });
    const body = (await preview.json()) as { previewHash: string; preview: { due: unknown } };
    expect(body.preview.due).toBeNull();
    const confirmed = await intakeAction({ action: 'confirm', intakeId: draft.intakeId, previewHash: body.previewHash, idempotencyKey: `demo-unknown-confirm-${token}` });
    expect(confirmed.status).toBe(200);
    const committed = (await confirmed.json()) as { caseId: string; taskId: string };
    appliedCaseIds.push(committed.caseId);
    expect((await db.task.findUniqueOrThrow({ where: { id: committed.taskId } })).dueJson).toBeNull();
    expect((await getCalendar(new Request('http://localhost'), { params: Promise.resolve({ id: committed.taskId }) })).status).toBe(422);
  });

  it('lets the user find a missing material, prepare it, and inspect their own completion evidence', async () => {
    const text = '合成校园报名：提交报名表。';
    await db.case.create({ data: { id: ids.caseId, title: '合成校园报名', category: 'registration' } });
    await db.task.create({ data: { id: ids.taskId, caseId: ids.caseId, title: '合成校园报名' } });
    await db.requirement.create({ data: { id: ids.requirementId, taskId: ids.taskId, label: '报名表' } });
    await db.sourceArtifact.create({ data: { id: ids.sourceId, sha256: `demo-${token}`, mediaType: 'text/plain', privateStorageKey: `text/${ids.sourceId}`, originLabel: '合成演示', size: Buffer.byteLength(text) } });
    await db.textRevision.create({ data: { id: ids.revisionId, sourceId: ids.sourceId, text, method: 'manual' } });
    await db.noticeRevision.create({ data: { id: ids.noticeId, caseId: ids.caseId, textRevisionId: ids.revisionId } });
    await db.evidence.create({ data: { id: ids.evidenceId, sourceId: ids.sourceId, textRevisionId: ids.revisionId, quote: text, start: 0, end: text.length, origin: 'notice' } });

    const blocked = await command({ action: 'record_completion', taskId: ids.taskId, statement: '我记录已提交合成报名材料。', expectedCaseVersion: 1, idempotencyKey: `demo-blocked-${token}` });
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).error.code).toBe('COMPLETION_BLOCKED');

    const response = await getTasks();
    const projection = (await response.json()) as { tasks: TaskProjection[] };
    const task = projection.tasks.find((entry) => entry.id === ids.taskId);
    expect(task?.requirements).toEqual([{ id: ids.requirementId, label: '报名表', active: true, satisfaction: 'missing' }]);
    expect(task?.sources[0]).toMatchObject({ id: ids.noticeId, textRevisionId: ids.revisionId, text, evidence: [{ quote: text, origin: 'notice' }] });
    expect(JSON.stringify(task)).not.toContain('privateStorageKey');

    const ready = await command({ action: 'set_requirement_status', taskId: ids.taskId, requirementId: task!.requirements[0]!.id, satisfaction: 'ready', expectedCaseVersion: 1, idempotencyKey: `demo-ready-${token}` });
    expect(ready.status).toBe(200);
    const completed = await command({ action: 'record_completion', taskId: ids.taskId, statement: '我记录已提交合成报名材料。', expectedCaseVersion: 2, idempotencyKey: `demo-complete-${token}` });
    expect(completed.status).toBe(200);
    const completedProjection = (await (await getTasks()).json()) as { tasks: TaskProjection[] };
    expect(completedProjection.tasks.find((entry) => entry.id === ids.taskId)?.completionRecords).toEqual([expect.objectContaining({ statement: '我记录已提交合成报名材料。', coveredEpoch: 1, coveredRequirementIds: [ids.requirementId] })]);
  });
});

afterAll(async () => {
  if (previousDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = previousDemoMode;
  const appliedTasks = await db.task.findMany({ where: { caseId: { in: appliedCaseIds } }, select: { id: true } });
  const taskIds = appliedTasks.map((task) => task.id);
  await db.completionRecord.deleteMany({ where: { taskId: { in: taskIds } } });
  await db.requirement.deleteMany({ where: { taskId: { in: taskIds } } });
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.noticeRelation.deleteMany({ where: { caseId: { in: appliedCaseIds } } });
  await db.noticeRevision.deleteMany({ where: { caseId: { in: appliedCaseIds } } });
  await db.auditEvent.deleteMany({ where: { caseId: { in: appliedCaseIds } } });
  await db.case.deleteMany({ where: { id: { in: appliedCaseIds } } });
  await db.textApproval.deleteMany({ where: { intakeId: { in: savedIntakeIds } } });
  const savedRevisions = await db.textRevision.findMany({ where: { sourceId: { in: savedSourceIds } }, select: { id: true } });
  await db.evidence.deleteMany({ where: { textRevisionId: { in: savedRevisions.map((revision) => revision.id) } } });
  await db.intake.deleteMany({ where: { id: { in: savedIntakeIds } } });
  await db.textRevision.deleteMany({ where: { sourceId: { in: savedSourceIds } } });
  await db.sourceArtifact.deleteMany({ where: { id: { in: savedSourceIds } } });
  await db.completionRecord.deleteMany({ where: { taskId: ids.taskId } });
  await db.requirement.deleteMany({ where: { taskId: ids.taskId } });
  await db.task.deleteMany({ where: { id: ids.taskId } });
  await db.auditEvent.deleteMany({ where: { caseId: ids.caseId } });
  await db.case.deleteMany({ where: { id: ids.caseId } });
  await db.commandResult.deleteMany({ where: { idempotencyKey: { contains: token } } });
  await db.evidence.deleteMany({ where: { id: ids.evidenceId } });
  await db.noticeRevision.deleteMany({ where: { id: ids.noticeId } });
  await db.textRevision.deleteMany({ where: { id: ids.revisionId } });
  await db.sourceArtifact.deleteMany({ where: { id: ids.sourceId } });
  await db.$disconnect();
});
