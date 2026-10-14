import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { assertAcyclic, preparationPlanState } from '../domain/preparation.ts';

type Tx = Prisma.TransactionClient;
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export class CommandError extends Error {
  readonly code: string;
  readonly requestId: string;
  constructor(code: string, requestId = randomUUID()) { super(code); this.code = code; this.requestId = requestId; }
}
function conflict(code: string): CommandError { return new CommandError(code); }

async function commitMutation(tx: Tx, input: { caseId: string; expectedVersion: number; key: string; scope: string; payload: unknown; event: string; before: unknown; after: unknown }): Promise<number> {
  const payloadHash = hash(input.payload);
  const previous = await tx.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: input.scope, idempotencyKey: input.key } } });
  if (previous) {
    if (previous.payloadHash !== payloadHash) throw conflict('IDEMPOTENCY_KEY_REUSED');
    return (JSON.parse(previous.responseJson) as { caseVersion: number }).caseVersion;
  }
  const updated = await tx.case.updateMany({ where: { id: input.caseId, version: input.expectedVersion }, data: { version: { increment: 1 } } });
  if (!updated.count) throw conflict('VERSION_CONFLICT');
  const next = input.expectedVersion + 1;
  const commandId = randomUUID();
  await tx.auditEvent.create({ data: { id: randomUUID(), caseId: input.caseId, caseVersion: next, commandId, eventType: input.event, beforeJson: JSON.stringify(input.before), afterJson: JSON.stringify(input.after) } });
  await tx.commandResult.create({ data: { id: randomUUID(), scope: input.scope, idempotencyKey: input.key, payloadHash, responseJson: JSON.stringify({ caseVersion: next, commandId }) } });
  return next;
}

export class TaskCommands {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) { this.db = db; }

  async setRequirementStatus(input: { taskId: string; requirementId: string; satisfaction: 'missing' | 'ready' | 'waived'; expectedCaseVersion: number; idempotencyKey: string }) {
    return this.db.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: input.taskId } }); if (!task) throw conflict('TASK_NOT_FOUND');
      const req = await tx.requirement.findFirst({ where: { id: input.requirementId, taskId: task.id } }); if (!req) throw conflict('REQUIREMENT_NOT_FOUND');
      const key = `requirement:${input.idempotencyKey}`; const payload = { ...input };
      const old = await tx.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: 'requirement', idempotencyKey: input.idempotencyKey } } });
      if (old) { if (old.payloadHash !== hash(payload)) throw conflict('IDEMPOTENCY_KEY_REUSED'); return JSON.parse(old.responseJson) as { caseVersion: number }; }
      await tx.requirement.update({ where: { id: req.id }, data: { satisfaction: input.satisfaction } });
      if (task.executionStatus === 'completed' && input.satisfaction !== 'ready') await tx.task.update({ where: { id: task.id }, data: { consistencyStatus: 'needs_review' } });
      const version = await commitMutation(tx, { caseId: task.caseId, expectedVersion: input.expectedCaseVersion, key, scope: 'requirement', payload, event: 'requirement_status_changed', before: req.satisfaction, after: input.satisfaction });
      return { caseVersion: version };
    });
  }

  async recordCompletion(input: { taskId: string; statement: string; kind?: 'user_attested' | 'receipt_attached'; evidenceIds?: string[]; expectedCaseVersion: number; idempotencyKey: string; id?: string }) {
    return this.db.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: input.taskId } }); if (!task) throw conflict('TASK_NOT_FOUND');
      const payload = { ...input };
      const old = await tx.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: 'completion', idempotencyKey: input.idempotencyKey } } });
      if (old) { if (old.payloadHash !== hash(payload)) throw conflict('IDEMPOTENCY_KEY_REUSED'); return JSON.parse(old.responseJson) as { completionId: string; caseVersion: number }; }
      const requirements = await tx.requirement.findMany({ where: { taskId: task.id, active: true } });
      if (requirements.some((r) => !['ready', 'waived'].includes(r.satisfaction))) throw conflict('COMPLETION_BLOCKED');
      const id = input.id ?? randomUUID();
      await tx.completionRecord.create({ data: { id, taskId: task.id, coveredEpoch: task.requirementEpoch, coveredRequirementIdsJson: JSON.stringify(requirements.map((r) => r.id)), statement: input.statement, kind: input.kind ?? 'user_attested', evidenceIdsJson: JSON.stringify(input.evidenceIds ?? []), recordedBy: 'local_user' } });
      await tx.task.update({ where: { id: task.id }, data: { executionStatus: 'completed', consistencyStatus: 'clear' } });
      const version = await commitMutation(tx, { caseId: task.caseId, expectedVersion: input.expectedCaseVersion, key: input.idempotencyKey, scope: 'completion', payload, event: 'completion_recorded', before: { executionStatus: task.executionStatus }, after: { completionId: id, coveredEpoch: task.requirementEpoch } });
      return { completionId: id, caseVersion: version };
    });
  }

  async savePreparation(input: { id: string; taskId: string; title: string; dependencies: string[]; requirementIds?: string[]; start?: string; end?: string; durationMinutes?: number; expectedCaseVersion: number; idempotencyKey: string }) {
    return this.db.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: input.taskId } }); if (!task) throw conflict('TASK_NOT_FOUND');
      if (!input.title.trim()) throw conflict('PREPARATION_TITLE_REQUIRED');
      const payload = { ...input };
      const old = await tx.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: 'preparation', idempotencyKey: input.idempotencyKey } } });
      if (old) { if (old.payloadHash !== hash(payload)) throw conflict('IDEMPOTENCY_KEY_REUSED'); return JSON.parse(old.responseJson) as { preparationId: string; caseVersion: number }; }
      const existing = await tx.preparation.findMany({ where: { taskId: task.id } });
      if (input.dependencies.includes(input.id) || input.dependencies.some((dependency) => !existing.some((preparation) => preparation.id === dependency))) throw conflict('PREPARATION_DEPENDENCY_NOT_FOUND');
      if (input.requirementIds?.length) {
        const requirements = await tx.requirement.findMany({ where: { id: { in: input.requirementIds }, taskId: task.id }, select: { id: true } });
        if (requirements.length !== new Set(input.requirementIds).size) throw conflict('REQUIREMENT_NOT_FOUND');
      }
      const edges = Object.fromEntries([...existing.map((p) => [p.id, JSON.parse(p.dependencyIdsJson) as string[]]), [input.id, input.dependencies]]);
      try { assertAcyclic(edges); } catch (error) { if (error instanceof Error && error.message === 'PREPARATION_DEPENDENCY_CYCLE') throw conflict(error.message); throw error; }
      const preparation = await tx.preparation.create({ data: { id: input.id, taskId: task.id, title: input.title, dependencyIdsJson: JSON.stringify(input.dependencies), requirementIdsJson: JSON.stringify(input.requirementIds ?? []), start: input.start, end: input.end, durationMinutes: input.durationMinutes, status: 'planned', planState: preparationPlanState(task.dueJson, input.end) } });
      const version = await commitMutation(tx, { caseId: task.caseId, expectedVersion: input.expectedCaseVersion, key: input.idempotencyKey, scope: 'preparation', payload, event: 'preparation_saved', before: null, after: { preparationId: input.id, dependencies: input.dependencies } });
      return { preparationId: preparation.id, caseVersion: version };
    });
  }

  async requestHandoff(input: { taskId: string; toOwnerId: string; basisEvidenceId: string; expectedCaseVersion: number; idempotencyKey: string; id: string }) {
    return this.db.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: input.taskId } }); if (!task) throw conflict('TASK_NOT_FOUND');
      if (!input.toOwnerId.trim()) throw conflict('HANDOFF_TARGET_REQUIRED');
      const payload = { ...input }; const old = await tx.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: 'handoff', idempotencyKey: input.idempotencyKey } } });
      if (old) { if (old.payloadHash !== hash(payload)) throw conflict('IDEMPOTENCY_KEY_REUSED'); return JSON.parse(old.responseJson) as { handoffId: string; caseVersion: number }; }
      const pending = await tx.handoff.findFirst({ where: { taskId: task.id, status: 'awaiting_confirmation' } });
      if (pending) throw conflict('HANDOFF_ALREADY_PENDING');
      const handoff = await tx.handoff.create({ data: { id: input.id, taskId: task.id, fromOwnerId: task.effectiveOwnerId, toOwnerId: input.toOwnerId, status: 'awaiting_confirmation', recordedBy: 'local_user', basisEvidenceId: input.basisEvidenceId } });
      const version = await commitMutation(tx, { caseId: task.caseId, expectedVersion: input.expectedCaseVersion, key: input.idempotencyKey, scope: 'handoff', payload, event: 'handoff_requested', before: { effectiveOwnerId: task.effectiveOwnerId }, after: { handoffId: handoff.id, status: handoff.status } });
      return { handoffId: handoff.id, status: handoff.status, caseVersion: version };
    });
  }

  async resolveHandoff(input: { handoffId: string; status: 'accepted_reported' | 'declined' | 'cancelled'; expectedCaseVersion: number; idempotencyKey: string; actor: 'local_user' }) {
    return this.db.$transaction(async (tx) => {
      const handoff = await tx.handoff.findUnique({ where: { id: input.handoffId } }); if (!handoff) throw conflict('HANDOFF_NOT_FOUND');
      const task = await tx.task.findUnique({ where: { id: handoff.taskId } }); if (!task) throw conflict('TASK_NOT_FOUND');
      const payload = { ...input }; const old = await tx.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: 'handoff-resolution', idempotencyKey: input.idempotencyKey } } });
      if (old) { if (old.payloadHash !== hash(payload)) throw conflict('IDEMPOTENCY_KEY_REUSED'); return JSON.parse(old.responseJson) as { caseVersion: number; status: string }; }
      if (handoff.status !== 'awaiting_confirmation') throw conflict('HANDOFF_ALREADY_RESOLVED');
      await tx.handoff.update({ where: { id: handoff.id }, data: { status: input.status, recordedBy: 'local_user' } });
      if (input.status === 'accepted_reported') await tx.task.update({ where: { id: task.id }, data: { effectiveOwnerId: handoff.toOwnerId } });
      const version = await commitMutation(tx, { caseId: task.caseId, expectedVersion: input.expectedCaseVersion, key: input.idempotencyKey, scope: 'handoff-resolution', payload, event: `handoff_${input.status}`, before: { status: handoff.status, owner: task.effectiveOwnerId }, after: { status: input.status, owner: input.status === 'accepted_reported' ? handoff.toOwnerId : task.effectiveOwnerId } });
      return { status: input.status, caseVersion: version };
    });
  }

  async recordReminder(taskId: string, displayedAt: string, id: string) {
    return this.db.reminderLog.create({ data: { id, taskId, displayedAt: new Date(displayedAt), status: 'displayed' } });
  }
}
