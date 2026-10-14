import { PrismaClient } from '@prisma/client';
import { CommandError } from './task-commands';
import { createHash, randomUUID } from 'node:crypto';
import { preparationPlanState } from '../domain/preparation';

export type ProposalOperation = { op: 'set_due' | 'add_requirement' | 'retire_requirement' | 'set_owner' | 'cancel_task' | 'restore_task'; taskId: string; requirementId?: string; value?: unknown; evidenceIds?: string[] };
export type ProposalNoticeSource = {
  intakeId: string;
  noticeId: string;
  relationId: string;
  sourceId: string;
  textRevisionId: string;
  candidateJson: string | null;
  evidence: Array<{ id: string; quote: string; start: number; end: number }>;
  relationEvidenceIds: string[];
};
export type ProposalApplyResult = { code: 'APPLIED'; commandId: string; caseVersion: number; proposalId: string; taskIds: string[] };

export class ProposalService {
  constructor(private db: PrismaClient) {}

  async proposeCompensation(i: { caseId: string; taskId: string; expectedVersion: number; targetAuditEventId: string; desiredDue: unknown; reason: string; payload: string }) {
    const id = randomUUID(); const hash = createHash('sha256').update(i.payload).digest('hex');
    return this.db.$transaction(async tx => {
      const c = await tx.case.findUnique({ where: { id: i.caseId } });
      if (!c || c.version !== i.expectedVersion) throw new CommandError('VERSION_CONFLICT');
      const target = await tx.auditEvent.findUnique({ where: { id: i.targetAuditEventId } });
      if (!target || target.caseId !== i.caseId) throw new CommandError('AUDIT_EVENT_NOT_FOUND');
      await tx.changeProposal.create({ data: { id, caseId: i.caseId, expectedCaseVersion: i.expectedVersion, status: 'pending', payloadHash: hash } });
      await tx.proposalOperation.create({ data: { id: randomUUID(), proposalId: id, op: 'set_due', taskId: i.taskId, valueJson: JSON.stringify(i.desiredDue), evidenceIdsJson: '[]' } });
      await tx.compensationTarget.create({ data: { id: randomUUID(), proposalId: id, auditEventId: target.id, reason: i.reason } });
      return { proposalId: id, expectedCaseVersion: i.expectedVersion, operations: [{ op: 'set_due', taskId: i.taskId, value: i.desiredDue }] };
    });
  }

  async proposeCancellation(i: { caseId: string; taskId: string; expectedVersion: number; payload: string }) {
    const id = randomUUID(); const hash = createHash('sha256').update(i.payload).digest('hex');
    return this.db.$transaction(async tx => {
      const c = await tx.case.findUnique({ where: { id: i.caseId } });
      if (!c || c.version !== i.expectedVersion) throw new CommandError('VERSION_CONFLICT');
      await tx.changeProposal.create({ data: { id, caseId: i.caseId, expectedCaseVersion: i.expectedVersion, status: 'pending', payloadHash: hash } });
      await tx.proposalOperation.create({ data: { id: randomUUID(), proposalId: id, op: 'cancel_task', taskId: i.taskId, evidenceIdsJson: '[]' } });
      return { proposalId: id, expectedCaseVersion: i.expectedVersion, operations: [{ op: 'cancel_task', taskId: i.taskId }] };
    });
  }

  async create(i: { caseId: string; expectedVersion: number; operations: ProposalOperation[]; payload: string; requiresNoticeSource?: boolean }) {
    const id = i.requiresNoticeSource ? `notice-proposal-${randomUUID()}` : randomUUID(); const hash = createHash('sha256').update(i.payload).digest('hex');
    return this.db.$transaction(async tx => {
      const c = await tx.case.findUnique({ where: { id: i.caseId } });
      if (!c) throw new CommandError('NOT_FOUND');
      if (c.version !== i.expectedVersion) throw new CommandError('VERSION_CONFLICT');
      await tx.changeProposal.create({ data: { id, caseId: i.caseId, expectedCaseVersion: i.expectedVersion, payloadHash: hash } });
      for (const o of i.operations) await tx.proposalOperation.create({ data: { id: randomUUID(), proposalId: id, op: o.op, taskId: o.taskId, requirementId: o.requirementId, valueJson: o.value === undefined ? null : JSON.stringify(o.value), evidenceIdsJson: JSON.stringify(o.evidenceIds ?? []) } });
      return { proposalId: id, expectedCaseVersion: i.expectedVersion, operations: i.operations };
    });
  }

  async apply(i: { proposalId: string; expectedVersion: number; key: string; payload: string; noticeSource?: ProposalNoticeSource }): Promise<ProposalApplyResult> {
    const hash = createHash('sha256').update(i.payload).digest('hex');
    return this.db.$transaction(async tx => {
      const old = await tx.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: 'proposal', idempotencyKey: i.key } } });
      if (old) {
        if (old.payloadHash !== hash) throw new CommandError('IDEMPOTENCY_KEY_REUSED');
        return JSON.parse(old.responseJson) as ProposalApplyResult;
      }
      const p = await tx.changeProposal.findUnique({ where: { id: i.proposalId } });
      if (!p || p.status !== 'pending') throw new CommandError('PROPOSAL_ALREADY_APPLIED');
      const c = await tx.case.findUnique({ where: { id: p.caseId } });
      if (!c || c.version !== i.expectedVersion || p.expectedCaseVersion !== i.expectedVersion) throw new CommandError('VERSION_CONFLICT');
      const ops = await tx.proposalOperation.findMany({ where: { proposalId: p.id } });
      if (!i.noticeSource) {
        // Persist the derived-proposal discriminator in the existing ID field.
        // Legacy source-only drafts also require their intake confirmation path.
        if (p.id.startsWith('notice-proposal-') || !ops.length) throw new CommandError('NOTICE_SOURCE_REQUIRED');
        const evidenceIds = new Set<string>();
        for (const operation of ops) {
          let refs: unknown;
          try { refs = JSON.parse(operation.evidenceIdsJson); } catch { throw new CommandError('EVIDENCE_INVALID'); }
          if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !ref)) throw new CommandError('EVIDENCE_INVALID');
          for (const ref of refs as string[]) evidenceIds.add(ref);
        }
        // Historical pending notice operations can contain IDs for evidence
        // rolled back with a failed apply. Real generic references must already
        // resolve to immutable text linked to this case, with an exact span.
        for (const id of evidenceIds) {
          const evidence = await tx.evidence.findUnique({ where: { id } });
          if (!evidence) throw new CommandError('EVIDENCE_INVALID');
          const revision = await tx.textRevision.findUnique({ where: { id: evidence.textRevisionId } });
          const notice = await tx.noticeRevision.findFirst({ where: { caseId: c.id, textRevisionId: evidence.textRevisionId } });
          if (!revision || revision.sourceId !== evidence.sourceId || !notice || !['notice', 'user_decision'].includes(evidence.origin) || !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) || evidence.start < 0 || evidence.end <= evidence.start || evidence.end > revision.text.length || revision.text.slice(evidence.start, evidence.end) !== evidence.quote) throw new CommandError('EVIDENCE_INVALID');
        }
      }
      if (i.noticeSource) {
        const source = i.noticeSource;
        const intake = await tx.intake.findUnique({ where: { id: source.intakeId } });
        const revision = await tx.textRevision.findUnique({ where: { id: source.textRevisionId } });
        const approval = await tx.textApproval.findFirst({ where: { intakeId: source.intakeId, textRevisionId: source.textRevisionId } });
        if (!intake?.approved || intake.sourceArtifactId !== source.sourceId || intake.textRevisionId !== source.textRevisionId || !revision || revision.sourceId !== source.sourceId || !approval) throw new CommandError('TEXT_REVISION_NOT_APPROVED');
        if (!source.candidateJson || intake.candidateJson !== source.candidateJson) throw new CommandError('CANDIDATE_CHANGED');
        for (const evidence of source.evidence) {
          if (evidence.start < 0 || evidence.end <= evidence.start || evidence.end > revision.text.length || revision.text.slice(evidence.start, evidence.end) !== evidence.quote) throw new CommandError('EVIDENCE_INVALID');
          await tx.evidence.upsert({ where: { id: evidence.id }, create: { ...evidence, sourceId: source.sourceId, textRevisionId: source.textRevisionId, origin: 'notice' }, update: {} });
        }
        const evidenceIds = source.evidence.map((evidence) => evidence.id);
        if (source.relationEvidenceIds.some((id) => !evidenceIds.includes(id)) || ops.some((operation) => (JSON.parse(operation.evidenceIdsJson) as string[]).some((id) => !evidenceIds.includes(id)))) throw new CommandError('EVIDENCE_INVALID');
        await tx.noticeRevision.upsert({ where: { id: source.noticeId }, create: { id: source.noticeId, caseId: c.id, textRevisionId: source.textRevisionId, evidenceIdsJson: JSON.stringify(evidenceIds) }, update: {} });
        await tx.noticeRelation.upsert({ where: { caseId_noticeId: { caseId: c.id, noticeId: source.noticeId } }, create: { id: source.relationId, caseId: c.id, noticeId: source.noticeId, evidenceIdsJson: JSON.stringify(source.relationEvidenceIds) }, update: {} });
        await tx.intake.update({ where: { id: source.intakeId }, data: { stage: 'applied' } });
      }
      const tasks = new Set<string>();
      const calendarChanged = new Set<string>();
      const requirementsChanged = new Set<string>();
      for (const o of ops) {
        if (!o.taskId) continue;
        tasks.add(o.taskId);
        const t = await tx.task.findUnique({ where: { id: o.taskId } });
        if (!t || t.caseId !== c.id) throw new CommandError('NOT_FOUND');
        if (o.op === 'set_due') { await tx.task.update({ where: { id: t.id }, data: { dueJson: o.valueJson, calendarSequence: { increment: 1 } } }); calendarChanged.add(t.id); }
        if (o.op === 'set_owner') await tx.task.update({ where: { id: t.id }, data: { effectiveOwnerId: o.valueJson ? JSON.parse(o.valueJson) as string : null } });
        if (o.op === 'cancel_task') { await tx.task.update({ where: { id: t.id }, data: { executionStatus: 'cancelled', calendarSequence: { increment: 1 } } }); calendarChanged.add(t.id); }
        if (o.op === 'restore_task') { await tx.task.update({ where: { id: t.id }, data: { executionStatus: 'open', consistencyStatus: 'needs_review', calendarSequence: { increment: 1 } } }); calendarChanged.add(t.id); }
        if (o.op === 'add_requirement' && o.requirementId) {
          await tx.requirement.create({ data: { id: o.requirementId, taskId: t.id, label: o.valueJson ? String(JSON.parse(o.valueJson)) : '' } });
          requirementsChanged.add(t.id);
        }
        if (o.op === 'retire_requirement' && o.requirementId) {
          const requirement = await tx.requirement.findFirst({ where: { id: o.requirementId, taskId: t.id } });
          if (!requirement) throw new CommandError('REQUIREMENT_NOT_FOUND');
          if (requirement.active) {
            await tx.requirement.update({ where: { id: requirement.id }, data: { active: false } });
            requirementsChanged.add(t.id);
          }
        }
      }
      for (const taskId of requirementsChanged) {
        const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
        await tx.task.update({ where: { id: taskId }, data: { requirementEpoch: { increment: 1 }, ...(task.executionStatus === 'completed' ? { consistencyStatus: 'needs_review' } : {}) } });
      }
      // Re-evaluate saved preparation plans after a due-date change. A plan is
      // never moved automatically; only its review flag changes.
      for (const o of ops.filter(x => x.op === 'set_due')) {
        if (!o.taskId) continue;
        const preparations = await tx.preparation.findMany({ where: { taskId: o.taskId } });
        for (const preparation of preparations) await tx.preparation.update({ where: { id: preparation.id }, data: { planState: preparationPlanState(o.valueJson, preparation.end) } });
      }
      for (const taskId of calendarChanged) await tx.calendarExport.updateMany({ where: { taskId, stale: false }, data: { stale: true } });
      const next = c.version + 1;
      const updated = await tx.case.updateMany({ where: { id: c.id, version: i.expectedVersion }, data: { version: next } });
      if (!updated.count) throw new CommandError('VERSION_CONFLICT');
      const cmd = randomUUID();
      const out: ProposalApplyResult = { code: 'APPLIED', commandId: cmd, caseVersion: next, proposalId: p.id, taskIds: [...tasks] };
      await tx.changeProposal.update({ where: { id: p.id }, data: { status: 'applied' } });
      await tx.proposalApplication.create({ data: { id: randomUUID(), proposalId: p.id, commandId: cmd, appliedCaseVersion: next } });
      await tx.auditEvent.create({ data: { id: randomUUID(), caseId: c.id, caseVersion: next, commandId: cmd, eventType: 'proposal_applied', beforeJson: '{}', afterJson: JSON.stringify(out) } });
      await tx.commandResult.create({ data: { id: randomUUID(), scope: 'proposal', idempotencyKey: i.key, payloadHash: hash, responseJson: JSON.stringify(out) } });
      return out;
    });
  }
}
