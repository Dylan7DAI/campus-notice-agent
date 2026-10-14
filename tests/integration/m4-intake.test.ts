import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { IntakeService } from '../../src/application/intake-service';

const db = new PrismaClient();
let createdCaseId: string | undefined;
let createdTaskId: string | undefined;
let createdProposalId: string | undefined;

describe('M4 intake confirmation boundary', () => {
  it('previews and applies a server stored candidate idempotently', async () => {
    const intakeId = 'm4-intake-confirm';
    const artifactId = 'm4-intake-artifact';
    const revisionId = 'm4-intake-revision';
    const text = '提交报名表。';
    const candidate = {
      schema_version: '1.0',
      text_revision_id: revisionId,
      relation: { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] },
      facts: [
        { id: 'title', field: 'title', value: '报名事项', evidence_refs: ['seg-1'] },
        { id: 'category', field: 'category', value: 'registration', evidence_refs: ['seg-1'] },
        { id: 'requirement', field: 'requirement_add', value: '报名表', evidence_refs: ['seg-1'] },
      ],
      questions: [],
    };
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: 'm4-intake-sha', mediaType: 'text/plain', privateStorageKey: 'text/m4-intake', originLabel: 'synthetic', size: text.length } });
    await db.textRevision.create({ data: { id: revisionId, sourceId: artifactId, text, method: 'manual' } });
    await db.textApproval.create({ data: { id: 'm4-intake-approval', intakeId, textRevisionId: revisionId } });
    await db.intake.create({ data: { id: intakeId, text, approved: true, stage: 'proposal_ready', candidateJson: JSON.stringify(candidate), sourceArtifactId: artifactId, textRevisionId: revisionId } });

    const service = new IntakeService(db);
    const preview = await service.preview(intakeId);
    expect(preview.kind).toBe('new');
    const first = await service.apply(intakeId, 'm4-intake-key');
    createdCaseId = first.caseId;
    createdTaskId = first.taskId;
    const replay = await service.apply(intakeId, 'm4-intake-key');
    expect(first.code).toBe('CASE_CREATED');
    expect(replay.replayed).toBe(true);
    expect(replay.caseId).toBe(first.caseId);
    expect(await db.case.count({ where: { id: first.caseId } })).toBe(1);
    expect(await db.task.count({ where: { id: first.taskId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { caseId: first.caseId } })).toBe(1);
  });

  it('routes an update candidate through proposal CAS and keeps the target stable', async () => {
    const intakeId = 'm4-intake-update';
    const artifactId = 'm4-update-artifact';
    const revisionId = 'm4-update-revision';
    const text = '事项更新：截止 2026-10-10。';
    const candidate = {
      schema_version: '1.0',
      text_revision_id: revisionId,
      relation: { kind: 'update', target_case_id: createdCaseId, evidence_refs: ['seg-1'] },
      facts: [
        { id: 'title', field: 'title', value: '报名事项', evidence_refs: ['seg-1'] },
        { id: 'category', field: 'category', value: 'registration', evidence_refs: ['seg-1'] },
        { id: 'due', field: 'due', value: { kind: 'date', date: '2026-10-10', timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: '截止 2026-10-10' }, evidence_refs: ['seg-1'] },
      ],
      questions: [],
    };
    await db.sourceArtifact.create({ data: { id: artifactId, sha256: 'm4-update-sha', mediaType: 'text/plain', privateStorageKey: 'text/m4-update', originLabel: 'synthetic', size: text.length } });
    await db.textRevision.create({ data: { id: revisionId, sourceId: artifactId, text, method: 'manual' } });
    await db.textApproval.create({ data: { id: 'm4-update-approval', intakeId, textRevisionId: revisionId } });
    await db.intake.create({ data: { id: intakeId, text, approved: true, stage: 'proposal_ready', candidateJson: JSON.stringify(candidate), sourceArtifactId: artifactId, textRevisionId: revisionId } });
    const service = new IntakeService(db);
    const preview = await service.preview(intakeId, createdCaseId);
    expect(preview.kind).toBe('update');
    const result = await service.apply(intakeId, 'm4-update-key', createdCaseId, undefined, preview.caseVersion);
    createdProposalId = result.proposalId;
    expect(result.code).toBe('APPLIED');
    expect(result.caseVersion).toBe(2);
    expect((await db.task.findUnique({ where: { id: createdTaskId } }))?.dueJson).toContain('2026-10-10');
  });
});

afterAll(async () => {
  if (createdCaseId) {
    await db.noticeRelation.deleteMany({ where: { caseId: createdCaseId } });
    await db.noticeRevision.deleteMany({ where: { caseId: createdCaseId } });
    await db.auditEvent.deleteMany({ where: { caseId: createdCaseId } });
  }
  if (createdTaskId) {
    await db.requirement.deleteMany({ where: { taskId: createdTaskId } });
    await db.task.deleteMany({ where: { id: createdTaskId } });
  }
  if (createdCaseId) await db.case.deleteMany({ where: { id: createdCaseId } });
  await db.intake.deleteMany({ where: { id: 'm4-intake-confirm' } });
  await db.textApproval.deleteMany({ where: { intakeId: 'm4-intake-confirm' } });
  await db.evidence.deleteMany({ where: { textRevisionId: 'm4-intake-revision' } });
  await db.textRevision.deleteMany({ where: { id: 'm4-intake-revision' } });
  await db.sourceArtifact.deleteMany({ where: { id: 'm4-intake-artifact' } });
  await db.commandResult.deleteMany({ where: { scope: 'intake-confirm', idempotencyKey: 'm4-intake-key' } });
  await db.commandResult.deleteMany({ where: { scope: 'proposal', idempotencyKey: 'm4-update-key' } });
  if (createdProposalId) {
    await db.proposalApplication.deleteMany({ where: { proposalId: createdProposalId } });
    await db.proposalOperation.deleteMany({ where: { proposalId: createdProposalId } });
    await db.changeProposal.deleteMany({ where: { id: createdProposalId } });
  }
  await db.noticeRevision.deleteMany({ where: { textRevisionId: { in: ['m4-intake-revision', 'm4-update-revision'] } } });
  await db.noticeRelation.deleteMany({ where: { caseId: createdCaseId } });
  await db.$disconnect();
});
