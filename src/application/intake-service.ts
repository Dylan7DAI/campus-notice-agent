import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ProposalService, type ProposalApplyResult, type ProposalNoticeSource, type ProposalOperation } from './proposal-service';
import {
  evidenceCatalog,
  normalizeCandidateDue,
  parseCandidate,
  type NoticeCandidate,
  validateCandidateEvidence,
} from './notice-candidate';
import { CommandError } from './task-commands';

type CandidateFact = NoticeCandidate['facts'][number];

export type IntakePreview = {
  kind: 'new' | 'update';
  caseId: string | null;
  caseVersion: number | null;
  taskId: string | null;
  title: string;
  category: string;
  requirement: string | null;
  due: unknown;
  operations: Array<{ op: string; taskId?: string; requirementId?: string; value?: unknown }>;
};

export type CandidateApplyResult = {
  code: 'CASE_CREATED' | 'APPLIED';
  caseId: string;
  taskId: string;
  caseVersion: number;
  commandId: string;
  proposalId?: string;
  replayed: boolean;
};

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fact(candidate: NoticeCandidate, field: CandidateFact['field']) {
  return candidate.facts.find((entry) => entry.field === field);
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}-${digest(value).slice(0, 32)}`;
}

function candidateRequirements(candidate: NoticeCandidate, field: 'requirement_add' | 'requirement_remove') {
  const requirements = new Map<string, Set<string>>();
  for (const entry of candidate.facts) {
    if (entry.field !== field || typeof entry.value !== 'string' || !entry.value.trim()) continue;
    const label = entry.value.trim();
    const evidenceRefs = requirements.get(label) ?? new Set<string>();
    for (const ref of entry.evidence_refs) evidenceRefs.add(ref);
    requirements.set(label, evidenceRefs);
  }
  return [...requirements].map(([label, evidenceRefs]) => ({ label, evidenceRefs: [...evidenceRefs] }));
}

function candidateTitle(candidate: NoticeCandidate) {
  const value = fact(candidate, 'title')?.value;
  if (typeof value !== 'string' || !value.trim()) throw new CommandError('CANDIDATE_TITLE_REQUIRED');
  return value.trim();
}

function candidateCategory(candidate: NoticeCandidate) {
  const value = fact(candidate, 'category')?.value;
  if (value !== 'registration' && value !== 'submission' && value !== 'event_change') throw new CommandError('CANDIDATE_CATEGORY_REQUIRED');
  return value;
}

function candidateDue(candidate: NoticeCandidate) {
  const entry = fact(candidate, 'due');
  if (!entry) return { due: null as ReturnType<typeof normalizeCandidateDue>['due'] };
  const normalized = normalizeCandidateDue(entry.value);
  if (normalized.error) throw new CommandError(normalized.error);
  return normalized;
}

export class IntakeService {
  private readonly proposals: ProposalService;

  constructor(private readonly db: PrismaClient) {
    this.proposals = new ProposalService(db);
  }

  async validateStoredCandidate(intakeId: string): Promise<{ intake: { id: string; text: string; approved: boolean; stage: string; candidateJson: string | null; sourceArtifactId: string | null; textRevisionId: string | null }; candidate: NoticeCandidate; title: string; category: string; due: ReturnType<typeof normalizeCandidateDue>['due'] }> {
    const intake = await this.db.intake.findUnique({ where: { id: intakeId } });
    if (!intake || !intake.candidateJson) throw new CommandError('CANDIDATE_NOT_FOUND');
    if (!intake.approved || !intake.textRevisionId) throw new CommandError('TEXT_REVISION_NOT_APPROVED');
    const raw = parseCandidate(intake.candidateJson);
    if (intake.textRevisionId !== raw.text_revision_id) throw new CommandError('TEXT_REVISION_STALE');
    const revision = await this.db.textRevision.findUnique({ where: { id: raw.text_revision_id } });
    const approval = await this.db.textApproval.findFirst({ where: { intakeId, textRevisionId: raw.text_revision_id } });
    if (!revision || revision.sourceId !== intake.sourceArtifactId || !approval) throw new CommandError('TEXT_REVISION_NOT_APPROVED');
    validateCandidateEvidence(raw, revision.id, evidenceCatalog(revision.text));
    if (raw.questions.some((question) => question.blocking)) throw new CommandError('PROPOSAL_QUESTIONS_UNANSWERED');
    const due = candidateDue(raw).due;
    return { intake, candidate: raw, title: candidateTitle(raw), category: candidateCategory(raw), due };
  }

  async preview(intakeId: string, selectedCaseId?: string, selectedTaskId?: string): Promise<IntakePreview> {
    const checked = await this.validateStoredCandidate(intakeId);
    const relation = checked.candidate.relation;
    if (relation.kind === 'unknown') throw new CommandError('CLARIFICATION_REQUIRED');
    if (relation.kind === 'new') {
      return {
        kind: 'new', caseId: null, caseVersion: null, taskId: null, title: checked.title, category: checked.category,
        requirement: this.requirement(checked.candidate), due: checked.due,
        operations: [{ op: 'create_task' }],
      };
    }
    const caseId = selectedCaseId ?? relation.target_case_id;
    if (!caseId || caseId !== relation.target_case_id) throw new CommandError('TARGET_CASE_REQUIRED');
    const targetCase = await this.db.case.findUnique({ where: { id: caseId } });
    if (!targetCase || targetCase.category !== checked.category) throw new CommandError('TARGET_CASE_REQUIRED');
    const task = await this.targetTask(caseId, selectedTaskId);
    const operations = await this.updateOperations(intakeId, task, checked.candidate, checked.due, targetCase.title);
    return { kind: 'update', caseId, caseVersion: targetCase.version, taskId: task.id, title: checked.title, category: checked.category, requirement: this.requirement(checked.candidate), due: checked.due, operations };
  }

  async apply(intakeId: string, idempotencyKey: string, selectedCaseId?: string, selectedTaskId?: string, expectedCaseVersion?: number | null, previewHash?: string): Promise<CandidateApplyResult> {
    if (!idempotencyKey) throw new CommandError('IDEMPOTENCY_KEY_REQUIRED');
    const checked = await this.validateStoredCandidate(intakeId);
    const relation = checked.candidate.relation;
    if (relation.kind === 'unknown') throw new CommandError('CLARIFICATION_REQUIRED');
    if (relation.kind === 'new') return this.applyNew(intakeId, idempotencyKey, checked);
    const caseId = selectedCaseId ?? relation.target_case_id;
    if (!caseId || caseId !== relation.target_case_id) throw new CommandError('TARGET_CASE_REQUIRED');
    if (typeof expectedCaseVersion !== 'number' || !Number.isSafeInteger(expectedCaseVersion) || expectedCaseVersion < 1) throw new CommandError('VERSION_CONFLICT');
    const task = await this.targetTask(caseId, selectedTaskId);
    // The request identity stays stable after its derived operations have applied.
    const payload = { intakeId, candidate: checked.candidate, caseId, taskId: task.id, expectedCaseVersion, previewHash: previewHash ?? null };
    const payloadJson = JSON.stringify(payload);
    const payloadHash = digest(payload);
    const previous = await this.db.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: 'proposal', idempotencyKey } } });
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw new CommandError('IDEMPOTENCY_KEY_REUSED');
      const replay = JSON.parse(previous.responseJson) as ProposalApplyResult;
      return { code: 'APPLIED', caseId, taskId: task.id, caseVersion: replay.caseVersion, commandId: replay.commandId, proposalId: replay.proposalId, replayed: true };
    }
    const targetCase = await this.db.case.findUnique({ where: { id: caseId } });
    if (!targetCase || targetCase.category !== checked.category) throw new CommandError('TARGET_CASE_REQUIRED');
    if (targetCase.version !== expectedCaseVersion) throw new CommandError('VERSION_CONFLICT');
    const operations = await this.updateOperations(intakeId, task, checked.candidate, checked.due, targetCase.title);
    const proposal = await this.db.changeProposal.findFirst({ where: { caseId, expectedCaseVersion, payloadHash, status: 'pending' } });
    const pending = proposal
      ? { proposalId: proposal.id, expectedCaseVersion: proposal.expectedCaseVersion }
      : await this.proposals.create({ caseId, expectedVersion: expectedCaseVersion, operations, payload: payloadJson, requiresNoticeSource: true });
    const revision = await this.db.textRevision.findUniqueOrThrow({ where: { id: checked.candidate.text_revision_id } });
    const refs = [...new Set([...checked.candidate.relation.evidence_refs, ...checked.candidate.facts.flatMap((entry) => entry.evidence_refs)])];
    const catalog = evidenceCatalog(revision.text);
    const noticeSource: ProposalNoticeSource = {
      intakeId, noticeId: stableId('notice', intakeId), relationId: stableId('relation', intakeId), sourceId: revision.sourceId, textRevisionId: revision.id,
      candidateJson: checked.intake.candidateJson,
      relationEvidenceIds: checked.candidate.relation.evidence_refs.map((ref) => stableId('evidence', { intakeId, ref })),
      evidence: refs.map((ref) => {
        const evidence = catalog.find((entry) => entry.id === ref);
        if (!evidence) throw new CommandError('EVIDENCE_INVALID');
        return { ...evidence, id: stableId('evidence', { intakeId, ref }) };
      }),
    };
    const applied = await this.proposals.apply({ proposalId: pending.proposalId, expectedVersion: expectedCaseVersion, key: idempotencyKey, payload: payloadJson, noticeSource });
    return { code: 'APPLIED', caseId, taskId: task.id, caseVersion: applied.caseVersion, commandId: applied.commandId, proposalId: pending.proposalId, replayed: false };
  }

  private requirement(candidate: NoticeCandidate) {
    return candidateRequirements(candidate, 'requirement_add').map((requirement) => requirement.label).join('、') || null;
  }

  private async targetTask(caseId: string, selectedTaskId?: string) {
    const tasks = await this.db.task.findMany({ where: { caseId }, orderBy: { id: 'asc' } });
    if (selectedTaskId) {
      const task = tasks.find((entry) => entry.id === selectedTaskId);
      if (!task) throw new CommandError('TASK_SELECTION_INVALID');
      return task;
    }
    if (tasks.length !== 1) throw new CommandError(tasks.length ? 'TARGET_TASK_REQUIRED' : 'TASK_NOT_FOUND');
    return tasks[0];
  }

  private async updateOperations(intakeId: string, task: { id: string; caseId: string; dueJson: string | null; location?: string | null }, candidate: NoticeCandidate, due: ReturnType<typeof normalizeCandidateDue>['due'], currentCaseTitle: string) {
    const operations: ProposalOperation[] = [];
    const evidenceIds = (entry: CandidateFact) => entry.evidence_refs.map((ref) => stableId('evidence', { intakeId, ref }));
    const currentDue = task.dueJson ? JSON.parse(task.dueJson) : null;
    const dueFact = fact(candidate, 'due');
    if (due && dueFact && JSON.stringify(due) !== JSON.stringify(currentDue)) operations.push({ op: 'set_due', taskId: task.id, value: due, evidenceIds: evidenceIds(dueFact) });
    for (const addition of candidateRequirements(candidate, 'requirement_add')) {
      const exists = await this.db.requirement.findFirst({ where: { taskId: task.id, active: true, label: addition.label } });
      if (!exists) operations.push({ op: 'add_requirement', taskId: task.id, requirementId: stableId('requirement', { taskId: task.id, label: addition.label }), value: addition.label, evidenceIds: addition.evidenceRefs.map((ref) => stableId('evidence', { intakeId, ref })) });
    }
    for (const removal of candidateRequirements(candidate, 'requirement_remove')) {
      const existing = await this.db.requirement.findFirst({ where: { taskId: task.id, active: true, label: removal.label } });
      if (existing) operations.push({ op: 'retire_requirement', taskId: task.id, requirementId: existing.id, evidenceIds: removal.evidenceRefs.map((ref) => stableId('evidence', { intakeId, ref })) });
    }
    const cancellation = fact(candidate, 'cancellation');
    if (cancellation?.value === true) operations.push({ op: 'cancel_task', taskId: task.id, evidenceIds: evidenceIds(cancellation) });
    const title = fact(candidate, 'title')?.value;
    const location = fact(candidate, 'location')?.value;
    const unsupported = (typeof title === 'string' && title !== currentCaseTitle)
      || (typeof location === 'string' && location !== (task.location ?? null))
      || candidate.facts.some((entry) => entry.field === 'owner_hint');
    if (unsupported) throw new CommandError('UNSUPPORTED_UPDATE_FIELD');
    return operations;
  }

  private async applyNew(intakeId: string, idempotencyKey: string, checked: Awaited<ReturnType<IntakeService['validateStoredCandidate']>>): Promise<CandidateApplyResult> {
    const payload = { intakeId, candidate: checked.candidate };
    const payloadHash = digest(payload);
    return this.db.$transaction(async (tx) => {
      const old = await tx.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: 'intake-confirm', idempotencyKey } } });
      if (old) {
        if (old.payloadHash !== payloadHash) throw new CommandError('IDEMPOTENCY_KEY_REUSED');
        return { ...(JSON.parse(old.responseJson) as CandidateApplyResult), replayed: true };
      }
      const current = await tx.intake.findUnique({ where: { id: intakeId } });
      if (!current) throw new CommandError('CANDIDATE_NOT_FOUND');
      if (current.stage === 'applied') throw new CommandError('INTAKE_ALREADY_APPLIED');
      if (current.textRevisionId !== checked.intake.textRevisionId || current.candidateJson !== checked.intake.candidateJson || current.approved !== checked.intake.approved || !current.approved || current.sourceArtifactId !== checked.intake.sourceArtifactId) throw new CommandError('TEXT_REVISION_STALE');
      const caseId = stableId('case', intakeId);
      const taskId = stableId('task', intakeId);
      const requirements = candidateRequirements(checked.candidate, 'requirement_add');
      const noticeId = stableId('notice', intakeId);
      const evidenceRefs = [...new Set([...(checked.candidate.relation.evidence_refs ?? []), ...checked.candidate.facts.flatMap((entry) => entry.evidence_refs)])];
      const evidenceIds = evidenceRefs.map((ref) => stableId('evidence', { intakeId, ref }));
      const revision = await tx.textRevision.findUniqueOrThrow({ where: { id: checked.candidate.text_revision_id } });
      await tx.case.create({ data: { id: caseId, title: checked.title, category: checked.category } });
      const location = fact(checked.candidate, 'location')?.value;
      await tx.task.create({ data: { id: taskId, caseId, title: checked.title, dueJson: checked.due ? JSON.stringify(checked.due) : null, location: typeof location === 'string' ? location : null } });
      for (const requirement of requirements) await tx.requirement.create({ data: { id: stableId('requirement', { taskId, label: requirement.label }), taskId, label: requirement.label } });
      await tx.noticeRevision.create({ data: { id: noticeId, caseId, textRevisionId: revision.id, evidenceIdsJson: JSON.stringify(evidenceIds) } });
      await tx.noticeRelation.create({ data: { id: stableId('relation', intakeId), caseId, noticeId, evidenceIdsJson: JSON.stringify(evidenceIds) } });
      const catalog = evidenceCatalog(revision.text);
      for (const ref of evidenceRefs) {
        const evidence = catalog.find((entry) => entry.id === ref);
        if (!evidence) throw new CommandError('EVIDENCE_INVALID');
        await tx.evidence.create({ data: { id: stableId('evidence', { intakeId, ref }), sourceId: revision.sourceId, textRevisionId: revision.id, quote: evidence.quote, start: evidence.start, end: evidence.end, origin: 'notice' } });
      }
      const commandId = stableId('command', { scope: 'intake-confirm', idempotencyKey });
      const response: CandidateApplyResult = { code: 'CASE_CREATED', caseId, taskId, caseVersion: 1, commandId, replayed: false };
      await tx.auditEvent.create({ data: { id: stableId('audit', { intakeId, idempotencyKey }), caseId, caseVersion: 1, commandId, eventType: 'case_created_from_candidate', beforeJson: '{}', afterJson: JSON.stringify(response) } });
      await tx.intake.update({ where: { id: intakeId }, data: { stage: 'applied' } });
      await tx.commandResult.create({ data: { id: stableId('command-result', { scope: 'intake-confirm', idempotencyKey }), scope: 'intake-confirm', idempotencyKey, payloadHash, responseJson: JSON.stringify(response) } });
      return response;
    });
  }
}
