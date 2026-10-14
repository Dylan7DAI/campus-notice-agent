import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntakeService } from '../../src/application/intake-service';
import { TaskCommands } from '../../src/application/task-commands';
import { ProposalService } from '../../src/application/proposal-service';
import type { NoticeCandidate } from '../../src/application/notice-candidate';

let db: PrismaClient;
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'campus-demo-update-'));
  const databaseUrl = `file:${path.join(temporaryDirectory, 'update.db').replaceAll('\\', '/')}`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
  });
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  await db?.$disconnect();
  if (temporaryDirectory) {
    const directory = path.resolve(temporaryDirectory);
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('campus-demo-update-')) throw new Error('TEMP_CLEANUP_PATH_INVALID');
    await rm(directory, { recursive: true, force: true });
  }
});

type MaterialFact = { label: string; evidenceRefs: string[] };

async function approvedIntake(text: string, relation: NoticeCandidate['relation'], requirement: string | MaterialFact[], removed: MaterialFact[] = []) {
  const id = randomUUID();
  const sourceId = `source-${id}`;
  const revisionId = `text-${id}`;
  const materials = typeof requirement === 'string' ? [{ label: requirement, evidenceRefs: ['seg-2'] }] : requirement;
  const candidate: NoticeCandidate = {
    schema_version: '1.0', text_revision_id: revisionId, relation,
    facts: [
      { id: 'title', field: 'title', value: '合成奖学金申请', evidence_refs: ['seg-1'] },
      { id: 'category', field: 'category', value: 'submission', evidence_refs: ['seg-1'] },
      ...materials.map((material, index) => ({ id: `material-${index}`, field: 'requirement_add' as const, value: material.label, evidence_refs: material.evidenceRefs })),
      ...removed.map((material, index) => ({ id: `removed-${index}`, field: 'requirement_remove' as const, value: material.label, evidence_refs: material.evidenceRefs })),
    ], questions: [],
  };
  await db.sourceArtifact.create({ data: { id: sourceId, sha256: id, mediaType: 'text/plain', privateStorageKey: `text/${id}`, originLabel: '合成演示', size: Buffer.byteLength(text) } });
  await db.textRevision.create({ data: { id: revisionId, sourceId, text, method: 'manual' } });
  await db.textApproval.create({ data: { id: `approval-${id}`, intakeId: id, textRevisionId: revisionId } });
  await db.intake.create({ data: { id, sourceArtifactId: sourceId, textRevisionId: revisionId, text, approved: true, stage: 'proposal_ready', candidateJson: JSON.stringify(candidate) } });
  return { id, sourceId, revisionId };
}

async function formalCounts() {
  return {
    cases: await db.case.count(), tasks: await db.task.count(), requirements: await db.requirement.count(),
    notices: await db.noticeRevision.count(), relations: await db.noticeRelation.count(), evidence: await db.evidence.count(),
    audits: await db.auditEvent.count(), commands: await db.commandResult.count(),
  };
}

describe('demo update preserves completion coverage and notice evidence', () => {
  it('does not apply an update candidate replaced on the same approved text before its transaction', async () => {
    const regularService = new IntakeService(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const created = await regularService.apply(first.id, `create-${first.id}`);
    const update = await approvedIntake('合成奖学金申请补充材料通知。\n新增要求：成绩证明。', { kind: 'update', target_case_id: created.caseId, evidence_refs: ['seg-1'] }, '成绩证明');
    const preview = await regularService.preview(update.id, created.caseId, created.taskId);
    const formalBefore = await formalCounts();
    const taskBefore = await db.task.findUniqueOrThrow({ where: { id: created.taskId } });
    let intakeAfterChange: Awaited<ReturnType<typeof db.intake.findUniqueOrThrow>>;
    // Preserve the real validation and command path; inject a real candidate
    // replacement on the same approved SQLite text before the apply transaction.
    class CandidateReplacedAfterValidation extends IntakeService {
      override async validateStoredCandidate(intakeId: string) {
        const checked = await super.validateStoredCandidate(intakeId);
        const candidate = { ...checked.candidate, questions: [{ id: 'material-check', field: 'requirement_add', prompt: '请重新核对材料。', blocking: true }] };
        intakeAfterChange = await db.intake.update({ where: { id: intakeId }, data: { candidateJson: JSON.stringify(candidate) } });
        return checked;
      }
    }
    const service = new CandidateReplacedAfterValidation(db);
    await expect(service.apply(update.id, `stale-update-${update.id}`, created.caseId, created.taskId, preview.caseVersion)).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED' });
    expect(await db.task.findUnique({ where: { id: created.taskId } })).toEqual(taskBefore);
    expect(await db.intake.findUnique({ where: { id: update.id } })).toEqual(intakeAfterChange!);
    expect(await formalCounts()).toEqual(formalBefore);
    expect(await db.evidence.count({ where: { textRevisionId: update.revisionId } })).toBe(0);
    expect(await db.noticeRevision.count({ where: { textRevisionId: update.revisionId } })).toBe(0);
    const pending = await db.changeProposal.findFirstOrThrow({ where: { caseId: created.caseId } });
    expect(pending.status).toBe('pending');
    expect(await db.proposalApplication.count({ where: { proposalId: pending.id } })).toBe(0);
    expect(await db.commandResult.count({ where: { scope: 'proposal', idempotencyKey: `stale-update-${update.id}` } })).toBe(0);
    await expect(new ProposalService(db).apply({ proposalId: pending.id, expectedVersion: pending.expectedCaseVersion, key: `generic-bypass-${update.id}`, payload: 'generic confirmation without source' })).rejects.toMatchObject({ code: 'NOTICE_SOURCE_REQUIRED' });
    expect(await formalCounts()).toEqual(formalBefore);
    expect((await db.changeProposal.findUnique({ where: { id: pending.id } }))?.status).toBe('pending');
  });

  it('requires the source snapshot even when a derived notification changes no task fields', async () => {
    const regularService = new IntakeService(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const created = await regularService.apply(first.id, `create-${first.id}`);
    const update = await approvedIntake('合成奖学金申请材料再次确认。\n申请表仍然需要。', { kind: 'update', target_case_id: created.caseId, evidence_refs: ['seg-1'] }, '申请表');
    const originalCandidateJson = (await db.intake.findUniqueOrThrow({ where: { id: update.id } })).candidateJson;
    const preview = await regularService.preview(update.id, created.caseId, created.taskId);
    expect(preview.operations).toEqual([]);
    const formalBefore = await formalCounts();
    class CandidateReplacedAfterValidation extends IntakeService {
      override async validateStoredCandidate(intakeId: string) {
        const checked = await super.validateStoredCandidate(intakeId);
        await db.intake.update({ where: { id: intakeId }, data: { candidateJson: JSON.stringify({ ...checked.candidate, questions: [{ id: 'source-check', field: 'relation', prompt: '请重新核对关联。', blocking: true }] }) } });
        return checked;
      }
    }
    await expect(new CandidateReplacedAfterValidation(db).apply(update.id, `stale-source-only-${update.id}`, created.caseId, created.taskId, preview.caseVersion)).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED' });
    const pending = await db.changeProposal.findFirstOrThrow({ where: { caseId: created.caseId } });
    expect(await db.proposalOperation.count({ where: { proposalId: pending.id } })).toBe(0);
    await expect(new ProposalService(db).apply({ proposalId: pending.id, expectedVersion: pending.expectedCaseVersion, key: `generic-source-only-${update.id}`, payload: 'source-only confirmation' })).rejects.toMatchObject({ code: 'NOTICE_SOURCE_REQUIRED' });
    expect(await formalCounts()).toEqual(formalBefore);
    expect((await db.changeProposal.findUnique({ where: { id: pending.id } }))?.status).toBe('pending');
    await db.intake.update({ where: { id: update.id }, data: { candidateJson: originalCandidateJson } });
    const applied = await regularService.apply(update.id, `confirmed-source-only-${update.id}`, created.caseId, created.taskId, preview.caseVersion);
    expect(applied.taskId).toBe(created.taskId);
    expect(applied.caseVersion).toBe(2);
    expect(await db.requirement.count({ where: { taskId: created.taskId } })).toBe(1);
    expect(await db.noticeRevision.count({ where: { caseId: created.caseId } })).toBe(2);
    expect((await db.intake.findUnique({ where: { id: update.id } }))?.stage).toBe('applied');
  });

  it('does not consume a legacy empty proposal without its notification source', async () => {
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const created = await new IntakeService(db).apply(first.id, `create-${first.id}`);
    const service = new ProposalService(db);
    const proposal = await service.create({ caseId: created.caseId, expectedVersion: 1, operations: [], payload: 'legacy source-only proposal' });
    const formalBefore = await formalCounts();
    await expect(service.apply({ proposalId: proposal.proposalId, expectedVersion: 1, key: `legacy-empty-${first.id}`, payload: 'legacy source-only proposal' })).rejects.toMatchObject({ code: 'NOTICE_SOURCE_REQUIRED' });
    expect(await formalCounts()).toEqual(formalBefore);
    expect((await db.changeProposal.findUnique({ where: { id: proposal.proposalId } }))?.status).toBe('pending');
  });

  it.each(['missing', 'other_case', 'invalid_span'] as const)('rejects legacy generic evidence that is %s without changing the case', async (invalid) => {
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const created = await new IntakeService(db).apply(first.id, `create-${first.id}`);
    let evidenceId = `missing-evidence-${randomUUID()}`;
    if (invalid === 'other_case') {
      const other = await approvedIntake('合成奖学金申请另一事项。\n需要其他申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '其他申请表');
      await new IntakeService(db).apply(other.id, `create-${other.id}`);
      evidenceId = (await db.evidence.findFirstOrThrow({ where: { textRevisionId: other.revisionId } })).id;
    } else if (invalid === 'invalid_span') {
      evidenceId = randomUUID();
      await db.evidence.create({ data: { id: evidenceId, sourceId: first.sourceId, textRevisionId: first.revisionId, quote: '伪引用', start: 0, end: 1, origin: 'notice' } });
    }
    const service = new ProposalService(db);
    const proposal = await service.create({ caseId: created.caseId, expectedVersion: 1, payload: first.id, operations: [{ op: 'set_due', taskId: created.taskId, value: { kind: 'date', value: '2026-10-25', timezone: 'Asia/Shanghai', boundary: 'inclusive' }, evidenceIds: [evidenceId] }] });
    const taskBefore = await db.task.findUniqueOrThrow({ where: { id: created.taskId } });
    const formalBefore = await formalCounts();
    await expect(service.apply({ proposalId: proposal.proposalId, expectedVersion: 1, key: `legacy-invalid-${first.id}`, payload: first.id })).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' });
    expect(await db.task.findUnique({ where: { id: created.taskId } })).toEqual(taskBefore);
    expect(await formalCounts()).toEqual(formalBefore);
    expect((await db.changeProposal.findUnique({ where: { id: proposal.proposalId } }))?.status).toBe('pending');
  });

  it('keeps valid generic evidence, compensation, cancellation, and stale-version idempotent replay usable', async () => {
    const first = await approvedIntake('合成奖学金申请截止2026-10-25。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const created = await new IntakeService(db).apply(first.id, `create-${first.id}`);
    const evidence = await db.evidence.findFirstOrThrow({ where: { textRevisionId: first.revisionId, start: 0 } });
    const service = new ProposalService(db);
    const payload = `generic-due-${first.id}`;
    const proposal = await service.create({ caseId: created.caseId, expectedVersion: 1, payload, operations: [{ op: 'set_due', taskId: created.taskId, value: { kind: 'date', value: '2026-10-25', timezone: 'Asia/Shanghai', boundary: 'inclusive' }, evidenceIds: [evidence.id] }] });
    const applied = await service.apply({ proposalId: proposal.proposalId, expectedVersion: 1, key: payload, payload });
    expect(applied.caseVersion).toBe(2);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { caseId: created.caseId, commandId: applied.commandId } });
    const compensation = await service.proposeCompensation({ caseId: created.caseId, taskId: created.taskId, expectedVersion: 2, targetAuditEventId: audit.id, desiredDue: null, reason: '我确认恢复原先未知截止。', payload: `compensate-${first.id}` });
    const compensated = await service.apply({ proposalId: compensation.proposalId, expectedVersion: 2, key: `compensate-${first.id}`, payload: `compensate-${first.id}` });
    expect(compensated.caseVersion).toBe(3);
    const cancellation = await service.proposeCancellation({ caseId: created.caseId, taskId: created.taskId, expectedVersion: 3, payload: `cancel-${first.id}` });
    const cancelled = await service.apply({ proposalId: cancellation.proposalId, expectedVersion: 3, key: `cancel-${first.id}`, payload: `cancel-${first.id}` });
    expect(cancelled.caseVersion).toBe(4);
    expect((await db.task.findUnique({ where: { id: created.taskId } }))?.executionStatus).toBe('cancelled');
    const formalBeforeReplay = await formalCounts();
    expect(await service.apply({ proposalId: proposal.proposalId, expectedVersion: 1, key: payload, payload })).toEqual(applied);
    expect(await formalCounts()).toEqual(formalBeforeReplay);
  });

  it('rejects an old candidate even when its old text still has an approval', async () => {
    const service = new IntakeService(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const newRevisionId = randomUUID();
    const text = '合成奖学金申请修订通知。\n需要成绩证明。';
    await db.textRevision.create({ data: { id: newRevisionId, sourceId: first.sourceId, parentId: first.revisionId, text, method: 'manual' } });
    await db.textApproval.create({ data: { id: randomUUID(), intakeId: first.id, textRevisionId: newRevisionId } });
    await db.intake.update({ where: { id: first.id }, data: { text, textRevisionId: newRevisionId, approved: true } });
    const intakeBefore = await db.intake.findUniqueOrThrow({ where: { id: first.id } });
    const formalBefore = await formalCounts();
    await expect(service.preview(first.id)).rejects.toMatchObject({ code: 'TEXT_REVISION_STALE' });
    await expect(service.apply(first.id, `stale-${first.id}`)).rejects.toMatchObject({ code: 'TEXT_REVISION_STALE' });
    expect(await db.intake.findUnique({ where: { id: first.id } })).toEqual(intakeBefore);
    expect(await formalCounts()).toEqual(formalBefore);
  });

  it.each(['corrected', 'candidate_changed', 'approval_revoked', 'applied'] as const)('does not commit a validated new candidate after the draft becomes %s', async (change) => {
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    let intakeAfterChange: Awaited<ReturnType<typeof db.intake.findUniqueOrThrow>>;
    let formalAfterChange: Awaited<ReturnType<typeof formalCounts>>;
    // This hook calls the real validator, then performs an actual competing
    // SQLite write before the normal applyNew transaction starts.
    class DraftChangedAfterValidation extends IntakeService {
      override async validateStoredCandidate(intakeId: string) {
        const checked = await super.validateStoredCandidate(intakeId);
        if (change === 'corrected') {
          const revisionId = randomUUID();
          const text = '合成奖学金申请修订通知。\n需要成绩证明。';
          await db.textRevision.create({ data: { id: revisionId, sourceId: first.sourceId, parentId: first.revisionId, text, method: 'manual' } });
          await db.intake.update({ where: { id: intakeId }, data: { text, textRevisionId: revisionId, candidateJson: null, approved: false, stage: 'text_review' } });
        } else if (change === 'candidate_changed') {
          const candidate = { ...checked.candidate, questions: [{ id: 'material-check', field: 'requirement_add', prompt: '请重新核对材料。', blocking: true }] };
          await db.intake.update({ where: { id: intakeId }, data: { candidateJson: JSON.stringify(candidate) } });
        } else if (change === 'approval_revoked') {
          await db.intake.update({ where: { id: intakeId }, data: { approved: false } });
        } else {
          await new IntakeService(db).apply(intakeId, `winner-${first.id}`);
        }
        intakeAfterChange = await db.intake.findUniqueOrThrow({ where: { id: intakeId } });
        formalAfterChange = await formalCounts();
        return checked;
      }
    }
    const service = new DraftChangedAfterValidation(db);
    await expect(service.apply(first.id, `loser-${first.id}`)).rejects.toMatchObject({ code: change === 'applied' ? 'INTAKE_ALREADY_APPLIED' : 'TEXT_REVISION_STALE' });
    expect(await db.intake.findUnique({ where: { id: first.id } })).toEqual(intakeAfterChange!);
    expect(await formalCounts()).toEqual(formalAfterChange!);
    expect(await db.commandResult.count({ where: { scope: 'intake-confirm', idempotencyKey: `loser-${first.id}` } })).toBe(0);
  });

  it('creates all distinct materials and retains each fact evidence without duplicate labels', async () => {
    const service = new IntakeService(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。\n另需成绩证明。\n申请表只需提交一份。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, [
      { label: '申请表', evidenceRefs: ['seg-2'] },
      { label: '成绩证明', evidenceRefs: ['seg-3'] },
      { label: '申请表', evidenceRefs: ['seg-4'] },
    ]);
    const preview = await service.preview(first.id);
    expect.soft(preview.requirement).toBe('申请表、成绩证明');
    const applied = await service.apply(first.id, `create-${first.id}`);
    const requirements = await db.requirement.findMany({ where: { taskId: applied.taskId }, orderBy: { label: 'asc' } });
    expect.soft(requirements.map((material) => material.label).sort()).toEqual(['申请表', '成绩证明'].sort());
    expect(await db.requirement.count({ where: { taskId: applied.taskId, label: '申请表' } })).toBe(1);
    expect(await db.evidence.findMany({ where: { sourceId: first.sourceId, textRevisionId: first.revisionId } })).toHaveLength(4);
    const replay = await service.apply(first.id, `create-${first.id}`);
    expect(replay.replayed).toBe(true);
    expect(await db.requirement.findMany({ where: { taskId: applied.taskId }, orderBy: { label: 'asc' } })).toEqual(requirements);
  });

  it('previews and applies every added material alongside an explicit retirement with one epoch change', async () => {
    const service = new IntakeService(db);
    const commands = new TaskCommands(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要旧申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '旧申请表');
    const created = await service.apply(first.id, `create-${first.id}`);
    const oldRequirement = await db.requirement.findFirstOrThrow({ where: { taskId: created.taskId } });
    await commands.setRequirementStatus({ taskId: created.taskId, requirementId: oldRequirement.id, satisfaction: 'ready', expectedCaseVersion: 1, idempotencyKey: `ready-${first.id}` });
    const completed = await commands.recordCompletion({ taskId: created.taskId, statement: '我记录已提交合成旧申请表。', expectedCaseVersion: 2, idempotencyKey: `complete-${first.id}` });
    const completionBefore = await db.completionRecord.findUniqueOrThrow({ where: { id: completed.completionId } });
    const update = await approvedIntake('合成奖学金申请补充材料通知。\n新增成绩证明。\n新增在读证明。\n明确撤销旧申请表。', { kind: 'update', target_case_id: created.caseId, evidence_refs: ['seg-1'] }, [
      { label: '成绩证明', evidenceRefs: ['seg-2'] },
      { label: '在读证明', evidenceRefs: ['seg-3'] },
    ], [{ label: '旧申请表', evidenceRefs: ['seg-4'] }]);
    const preview = await service.preview(update.id, created.caseId, created.taskId);
    expect.soft(preview.operations).toHaveLength(3);
    expect(await db.requirement.count({ where: { taskId: created.taskId } })).toBe(1);
    expect((await db.task.findUnique({ where: { id: created.taskId } }))?.requirementEpoch).toBe(1);
    const applied = await service.apply(update.id, `update-${update.id}`, created.caseId, created.taskId, preview.caseVersion);
    expect(applied.taskId).toBe(created.taskId);
    expect(await db.task.findUnique({ where: { id: created.taskId } })).toMatchObject({ requirementEpoch: 2, executionStatus: 'completed', consistencyStatus: 'needs_review' });
    expect(await db.requirement.findUnique({ where: { id: oldRequirement.id } })).toMatchObject({ active: false, satisfaction: 'ready' });
    expect.soft(await db.requirement.findMany({ where: { taskId: created.taskId, active: true }, orderBy: { label: 'asc' } })).toEqual([
      expect.objectContaining({ label: '在读证明', satisfaction: 'missing' }),
      expect.objectContaining({ label: '成绩证明', satisfaction: 'missing' }),
    ]);
    expect(await db.completionRecord.findUnique({ where: { id: completed.completionId } })).toEqual(completionBefore);
    const operations = await db.proposalOperation.findMany({ where: { proposalId: applied.proposalId, op: 'add_requirement' } });
    expect.soft(operations).toHaveLength(2);
    for (const operation of operations) {
      const ids = JSON.parse(operation.evidenceIdsJson) as string[];
      const label = JSON.parse(operation.valueJson!) as string;
      expect(await db.evidence.findMany({ where: { id: { in: ids }, sourceId: update.sourceId, textRevisionId: update.revisionId } })).toEqual([expect.objectContaining({ quote: `新增${label}。` })]);
    }
    const requirementsBeforeReplay = await db.requirement.findMany({ where: { taskId: created.taskId }, orderBy: { id: 'asc' } });
    await service.apply(update.id, `update-${update.id}`, created.caseId, created.taskId, preview.caseVersion);
    expect(await db.requirement.findMany({ where: { taskId: created.taskId }, orderBy: { id: 'asc' } })).toEqual(requirementsBeforeReplay);
  });

  it('merges repeated update labels into one operation while keeping every cited segment', async () => {
    const service = new IntakeService(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const created = await service.apply(first.id, `create-${first.id}`);
    const originalRequirement = await db.requirement.findFirstOrThrow({ where: { taskId: created.taskId } });
    await new TaskCommands(db).setRequirementStatus({ taskId: created.taskId, requirementId: originalRequirement.id, satisfaction: 'ready', expectedCaseVersion: 1, idempotencyKey: `ready-${first.id}` });
    const update = await approvedIntake('合成奖学金申请补充材料通知。\n新增成绩证明。\n成绩证明只需一份。\n原申请表仍然保留。', { kind: 'update', target_case_id: created.caseId, evidence_refs: ['seg-1'] }, [
      { label: '成绩证明', evidenceRefs: ['seg-2'] },
      { label: '成绩证明', evidenceRefs: ['seg-3'] },
      { label: '申请表', evidenceRefs: ['seg-4'] },
    ]);
    const preview = await service.preview(update.id, created.caseId, created.taskId);
    expect(preview.operations).toHaveLength(1);
    const applied = await service.apply(update.id, `update-${update.id}`, created.caseId, created.taskId, preview.caseVersion);
    expect(await db.requirement.count({ where: { taskId: created.taskId } })).toBe(2);
    expect(await db.requirement.findUnique({ where: { id: originalRequirement.id } })).toEqual({ ...originalRequirement, satisfaction: 'ready' });
    const operation = await db.proposalOperation.findFirstOrThrow({ where: { proposalId: applied.proposalId, op: 'add_requirement' } });
    const evidenceIds = JSON.parse(operation.evidenceIdsJson) as string[];
    expect.soft(evidenceIds).toHaveLength(2);
    expect.soft(await db.evidence.findMany({ where: { id: { in: evidenceIds }, textRevisionId: update.revisionId }, orderBy: { start: 'asc' } })).toEqual([
      expect.objectContaining({ quote: '新增成绩证明。' }),
      expect.objectContaining({ quote: '成绩证明只需一份。' }),
    ]);
  });

  it('stores source-bound evidence IDs for the first confirmed notice and its relation', async () => {
    const service = new IntakeService(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const created = await service.apply(first.id, `create-${first.id}`);
    const notice = await db.noticeRevision.findFirstOrThrow({ where: { caseId: created.caseId, textRevisionId: first.revisionId } });
    const relation = await db.noticeRelation.findFirstOrThrow({ where: { caseId: created.caseId, noticeId: notice.id } });
    const noticeEvidenceIds = JSON.parse(notice.evidenceIdsJson) as string[];
    const relationEvidenceIds = JSON.parse(relation.evidenceIdsJson) as string[];
    expect(noticeEvidenceIds).toHaveLength(2);
    expect(relationEvidenceIds.length).toBeGreaterThan(0);
    expect.soft(await db.evidence.findMany({ where: { id: { in: noticeEvidenceIds }, sourceId: first.sourceId, textRevisionId: first.revisionId, origin: 'notice' } })).toHaveLength(noticeEvidenceIds.length);
    expect.soft(await db.evidence.findMany({ where: { id: { in: relationEvidenceIds }, sourceId: first.sourceId, textRevisionId: first.revisionId, origin: 'notice' } })).toHaveLength(relationEvidenceIds.length);
    const intake = await db.intake.findUniqueOrThrow({ where: { id: first.id } });
    expect((JSON.parse(intake.candidateJson!) as NoticeCandidate).relation.evidence_refs).toEqual(['seg-1']);
  });

  it('keeps the completed task stable and requires review after confirming a new material', async () => {
    const service = new IntakeService(db);
    const commands = new TaskCommands(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    expect((await service.preview(first.id)).kind).toBe('new');
    const created = await service.apply(first.id, `create-${first.id}`);
    const originalRequirement = await db.requirement.findFirstOrThrow({ where: { taskId: created.taskId } });
    const ready = await commands.setRequirementStatus({ taskId: created.taskId, requirementId: originalRequirement.id, satisfaction: 'ready', expectedCaseVersion: 1, idempotencyKey: `ready-${first.id}` });
    const completion = await commands.recordCompletion({ taskId: created.taskId, statement: '我记录已提交合成申请表。', expectedCaseVersion: ready.caseVersion, idempotencyKey: `complete-${first.id}` });
    const originalCompletion = await db.completionRecord.findUniqueOrThrow({ where: { id: completion.completionId } });
    const originalTask = await db.task.findUniqueOrThrow({ where: { id: created.taskId } });
    const originalCase = await db.case.findUniqueOrThrow({ where: { id: created.caseId } });
    const update = await approvedIntake('合成奖学金申请补充材料通知。\n新增要求：成绩证明。', { kind: 'update', target_case_id: created.caseId, evidence_refs: ['seg-1'] }, '成绩证明');

    const preview = await service.preview(update.id, created.caseId, created.taskId);
    expect(preview.operations).toHaveLength(1);
    expect(preview.operations[0]).toMatchObject({ op: 'add_requirement', taskId: created.taskId, value: '成绩证明' });
    expect(await db.task.findUnique({ where: { id: created.taskId } })).toEqual(originalTask);
    expect(await db.case.findUnique({ where: { id: created.caseId } })).toEqual(originalCase);
    expect(await db.requirement.count({ where: { taskId: created.taskId } })).toBe(1);
    expect(await db.noticeRevision.count({ where: { caseId: created.caseId } })).toBe(1);

    const applied = await service.apply(update.id, `update-${update.id}`, created.caseId, created.taskId, preview.caseVersion);
    expect(applied.taskId).toBe(created.taskId);
    expect(applied.caseVersion).toBe(originalCase.version + 1);
    expect(await db.task.count({ where: { caseId: created.caseId } })).toBe(1);
    const task = await db.task.findUniqueOrThrow({ where: { id: created.taskId } });
    expect.soft(task.requirementEpoch).toBe(originalTask.requirementEpoch + 1);
    expect.soft(task.executionStatus).toBe('completed');
    expect.soft(task.consistencyStatus).toBe('needs_review');
    expect(await db.completionRecord.findUnique({ where: { id: completion.completionId } })).toEqual(originalCompletion);
    expect(await db.requirement.findUnique({ where: { id: originalRequirement.id } })).toEqual({ ...originalRequirement, satisfaction: 'ready' });
    expect(await db.requirement.findFirst({ where: { taskId: created.taskId, label: '成绩证明' } })).toMatchObject({ active: true, satisfaction: 'missing' });
    expect.soft(await db.noticeRevision.count({ where: { caseId: created.caseId } })).toBe(2);
    const notice = await db.noticeRevision.findFirst({ where: { caseId: created.caseId, textRevisionId: update.revisionId } });
    expect.soft(notice).not.toBeNull();
    expect.soft(await db.noticeRelation.findFirst({ where: { caseId: created.caseId, noticeId: notice?.id ?? 'missing-notice' } })).toMatchObject({ caseId: created.caseId });
    expect.soft(await db.evidence.findMany({ where: { textRevisionId: update.revisionId } })).toEqual(expect.arrayContaining([expect.objectContaining({ quote: '新增要求：成绩证明。', origin: 'notice' })]));
    const operation = await db.proposalOperation.findFirstOrThrow({ where: { proposalId: applied.proposalId, op: 'add_requirement' } });
    const evidenceIds = JSON.parse(operation.evidenceIdsJson) as string[];
    expect.soft(evidenceIds).toHaveLength(1);
    expect.soft(await db.evidence.findMany({ where: { id: { in: evidenceIds } } })).toEqual([expect.objectContaining({ textRevisionId: update.revisionId, quote: '新增要求：成绩证明。' })]);
    expect((await db.intake.findUnique({ where: { id: update.id } }))?.stage).toBe('applied');

    const replay = await service.apply(update.id, `update-${update.id}`, created.caseId, created.taskId, preview.caseVersion);
    expect(replay.replayed).toBe(true);
    expect(replay.commandId).toBe(applied.commandId);
    expect.soft(await db.noticeRevision.count({ where: { caseId: created.caseId } })).toBe(2);
    expect(await db.requirement.count({ where: { taskId: created.taskId } })).toBe(2);
    expect(await db.auditEvent.count({ where: { caseId: created.caseId, eventType: 'proposal_applied' } })).toBe(1);
  });

  it('rolls back notice evidence and intake state when the SQLite requirement write fails', async () => {
    const service = new IntakeService(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const created = await service.apply(first.id, `create-${first.id}`);
    const taskBefore = await db.task.findUniqueOrThrow({ where: { id: created.taskId } });
    const update = await approvedIntake('合成奖学金申请补充材料通知。\n新增要求：回滚证明。', { kind: 'update', target_case_id: created.caseId, evidence_refs: ['seg-1'] }, '回滚证明');
    const preview = await service.preview(update.id, created.caseId, created.taskId);
    await db.$executeRawUnsafe("CREATE TRIGGER reject_demo_update BEFORE INSERT ON Requirement WHEN NEW.label = '回滚证明' BEGIN SELECT RAISE(ABORT, 'DEMO_TRANSACTION_FAILURE'); END;");
    try {
      // Prisma reports SQLite's trigger constraint rejection as P2003.
      await expect(service.apply(update.id, `update-${update.id}`, created.caseId, created.taskId, preview.caseVersion)).rejects.toMatchObject({ code: 'P2003' });
      expect(await db.task.findUnique({ where: { id: created.taskId } })).toEqual(taskBefore);
      expect((await db.case.findUnique({ where: { id: created.caseId } }))?.version).toBe(1);
      expect(await db.requirement.count({ where: { taskId: created.taskId } })).toBe(1);
      expect(await db.noticeRevision.count({ where: { caseId: created.caseId } })).toBe(1);
      expect(await db.noticeRelation.count({ where: { caseId: created.caseId } })).toBe(1);
      expect(await db.evidence.count({ where: { textRevisionId: update.revisionId } })).toBe(0);
      expect((await db.intake.findUnique({ where: { id: update.id } }))?.stage).toBe('proposal_ready');
      expect(await db.proposalApplication.count({ where: { proposalId: (await db.changeProposal.findFirstOrThrow({ where: { caseId: created.caseId } })).id } })).toBe(0);
      expect(await db.auditEvent.count({ where: { caseId: created.caseId, eventType: 'proposal_applied' } })).toBe(0);
      expect(await db.commandResult.count({ where: { scope: 'proposal', idempotencyKey: `update-${update.id}` } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER reject_demo_update;');
    }
  });

  it('increments completion coverage once when one proposal replaces a material', async () => {
    const intakeService = new IntakeService(db);
    const commands = new TaskCommands(db);
    const first = await approvedIntake('合成奖学金申请材料提交。\n需要申请表。', { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] }, '申请表');
    const created = await intakeService.apply(first.id, `create-${first.id}`);
    const oldRequirement = await db.requirement.findFirstOrThrow({ where: { taskId: created.taskId } });
    await commands.setRequirementStatus({ taskId: created.taskId, requirementId: oldRequirement.id, satisfaction: 'ready', expectedCaseVersion: 1, idempotencyKey: `ready-${first.id}` });
    const completed = await commands.recordCompletion({ taskId: created.taskId, statement: '我记录已提交合成申请表。', expectedCaseVersion: 2, idempotencyKey: `complete-${first.id}` });
    const completionBefore = await db.completionRecord.findUniqueOrThrow({ where: { id: completed.completionId } });
    const proposals = new ProposalService(db);
    const newRequirementId = randomUUID();
    const proposal = await proposals.create({ caseId: created.caseId, expectedVersion: 3, payload: first.id, operations: [
      { op: 'retire_requirement', taskId: created.taskId, requirementId: oldRequirement.id },
      { op: 'add_requirement', taskId: created.taskId, requirementId: newRequirementId, value: '新版申请表' },
    ] });
    await proposals.apply({ proposalId: proposal.proposalId, expectedVersion: 3, key: `replace-${first.id}`, payload: first.id });
    expect(await db.task.findUnique({ where: { id: created.taskId } })).toMatchObject({ requirementEpoch: 2, executionStatus: 'completed', consistencyStatus: 'needs_review' });
    expect(await db.requirement.findUnique({ where: { id: oldRequirement.id } })).toMatchObject({ active: false, satisfaction: 'ready' });
    expect(await db.requirement.findUnique({ where: { id: newRequirementId } })).toMatchObject({ active: true, satisfaction: 'missing' });
    expect(await db.completionRecord.findUnique({ where: { id: completed.completionId } })).toEqual(completionBefore);
  });
});
