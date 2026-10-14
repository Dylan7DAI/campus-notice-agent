import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { GlmClient, ModelClientError } from '../../src/application/glm-client';
import { IntakeService } from '../../src/application/intake-service';
import { ModelRunner } from '../../src/application/model-runner';

const db = new PrismaClient();
const fixtures: Array<{ intakeId: string; artifactId: string; revisionId: string }> = [];

async function approvedFixture() {
  const id = randomUUID();
  const fixture = { intakeId: `m4-boundary-intake-${id}`, artifactId: `m4-boundary-artifact-${id}`, revisionId: `m4-boundary-revision-${id}` };
  fixtures.push(fixture);
  const text = 'Campus registration requires Form A.';
  await db.sourceArtifact.create({ data: { id: fixture.artifactId, sha256: id, mediaType: 'text/plain', privateStorageKey: `synthetic/${id}`, originLabel: 'synthetic boundary fixture', size: Buffer.byteLength(text) } });
  await db.textRevision.create({ data: { id: fixture.revisionId, sourceId: fixture.artifactId, text, method: 'manual' } });
  await db.intake.create({ data: { id: fixture.intakeId, sourceArtifactId: fixture.artifactId, textRevisionId: fixture.revisionId, text, approved: true, stage: 'proposal_ready' } });
  await db.textApproval.create({ data: { id: `m4-boundary-approval-${id}`, intakeId: fixture.intakeId, textRevisionId: fixture.revisionId } });
  return { ...fixture, text };
}

async function formalCounts() {
  const [cases, tasks, requirements, audits, commands, proposals] = await Promise.all([
    db.case.count(), db.task.count(), db.requirement.count(), db.auditEvent.count(), db.commandResult.count(), db.changeProposal.count(),
  ]);
  return { cases, tasks, requirements, audits, commands, proposals };
}

afterEach(async () => {
  const intakeIds = fixtures.map((fixture) => fixture.intakeId);
  const revisionIds = fixtures.map((fixture) => fixture.revisionId);
  const artifactIds = fixtures.map((fixture) => fixture.artifactId);
  await db.agentRun.deleteMany({ where: { intakeId: { in: intakeIds } } });
  await db.textApproval.deleteMany({ where: { intakeId: { in: intakeIds } } });
  await db.intake.deleteMany({ where: { id: { in: intakeIds } } });
  await db.textRevision.deleteMany({ where: { id: { in: revisionIds } } });
  await db.sourceArtifact.deleteMany({ where: { id: { in: artifactIds } } });
  fixtures.length = 0;
});

afterAll(async () => { await db.$disconnect(); });

describe('M4 no-confirmation application boundary (stub provider; not model quality)', () => {
  it('extracts an approved revision and previews it without writing formal tasks or commands', async () => {
    const fixture = await approvedFixture();
    const before = await formalCounts();
    const candidate = {
      schema_version: '1.0', text_revision_id: fixture.revisionId,
      relation: { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] },
      facts: [
        { id: 'title', field: 'title', value: 'Campus registration', evidence_refs: ['seg-1'] },
        { id: 'category', field: 'category', value: 'registration', evidence_refs: ['seg-1'] },
        { id: 'material', field: 'requirement_add', value: 'Form A', evidence_refs: ['seg-1'] },
      ],
      questions: [],
    };
    const stub: Pick<GlmClient, 'chat' | 'chatWithImage'> = {
      chat: async () => ({ text: JSON.stringify(candidate), raw: {} }),
      chatWithImage: async () => { throw new Error('Image call is outside this extraction boundary test'); },
    };
    const runner = new ModelRunner(db, stub, 'stub-control-flow', 'stub-model');
    const output = await runner.extract({ intakeId: fixture.intakeId, textRevisionId: fixture.revisionId, text: fixture.text });
    expect(output.candidate).toEqual(candidate);
    expect(await formalCounts()).toEqual(before);
    await db.intake.update({ where: { id: fixture.intakeId }, data: { candidateJson: JSON.stringify(output.candidate) } });
    const preview = await new IntakeService(db).preview(fixture.intakeId);
    expect(preview.kind).toBe('new');
    expect(preview.requirement).toBe('Form A');
    expect(await formalCounts()).toEqual(before);
    expect((await db.agentRun.findUniqueOrThrow({ where: { id: output.runId } })).status).toBe('succeeded');
    // Confirmation is deliberately absent; positive apply/idempotence is covered by m4-intake.test.ts.
  });

  it.each(['timeout', 'invalid_json'] as const)('preserves the approved draft and formal state after %s', async (failure) => {
    const fixture = await approvedFixture();
    const before = await formalCounts();
    let calls = 0;
    const stub: Pick<GlmClient, 'chat' | 'chatWithImage'> = {
      chat: async () => {
        calls += 1;
        if (failure === 'timeout') throw new ModelClientError('MODEL_TIMEOUT', true);
        return { text: '{"schema_version":', raw: {} };
      },
      chatWithImage: async () => { throw new Error('Image call is outside this extraction boundary test'); },
    };
    const runner = new ModelRunner(db, stub, 'stub-control-flow', 'stub-model');
    await expect(runner.extract({ intakeId: fixture.intakeId, textRevisionId: fixture.revisionId, text: fixture.text }))
      .rejects.toThrow(failure === 'timeout' ? 'MODEL_TIMEOUT' : 'MODEL_INVALID_OUTPUT');
    expect(calls).toBe(2);
    expect(await formalCounts()).toEqual(before);
    const intake = await db.intake.findUniqueOrThrow({ where: { id: fixture.intakeId } });
    expect(intake.text).toBe(fixture.text);
    expect(intake.textRevisionId).toBe(fixture.revisionId);
    expect(intake.approved).toBe(true);
    expect(intake.candidateJson).toBeNull();
    const run = await db.agentRun.findFirstOrThrow({ where: { intakeId: fixture.intakeId } });
    expect(run.status).toBe('failed');
    expect(run.callCount).toBe(2);
    expect(run.retryCount).toBe(failure === 'timeout' ? 1 : 0);
    await expect(new IntakeService(db).preview(fixture.intakeId)).rejects.toThrow('CANDIDATE_NOT_FOUND');
    expect(await formalCounts()).toEqual(before);
  });
});
