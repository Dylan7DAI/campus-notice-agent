import type { PrismaClient } from '@prisma/client';
import { assertStorageKey, removeStorageKey } from './data-protection';

export class CaseDeletionError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export type DeleteCaseResult = { caseId: string; deleted: Record<string, number>; storageKeys: string[] };

/** Explicit, version-checked deletion. It never cascades through Prisma relations implicitly. */
export async function deleteCaseData(db: PrismaClient, input: { caseId: string; expectedCaseVersion?: number; confirmation?: boolean; backupAcknowledged?: boolean }): Promise<DeleteCaseResult> {
  if (input.confirmation !== true) throw new CaseDeletionError('CONFIRMATION_REQUIRED');
  if (input.backupAcknowledged !== true) throw new CaseDeletionError('BACKUP_REQUIRED');
  if (!Number.isSafeInteger(input.expectedCaseVersion)) throw new CaseDeletionError('VERSION_REQUIRED');
  const current = await db.case.findUnique({ where: { id: input.caseId }, select: { id: true, version: true } });
  if (!current) throw new CaseDeletionError('CASE_NOT_FOUND');
  if (input.expectedCaseVersion !== current.version) throw new CaseDeletionError('VERSION_CONFLICT');

  const result = await db.$transaction(async (tx) => {
    const tasks = await tx.task.findMany({ where: { caseId: current.id }, select: { id: true } });
    const taskIds = tasks.map((task) => task.id);
    const proposals = await tx.changeProposal.findMany({ where: { caseId: current.id }, select: { id: true } });
    const proposalIds = proposals.map((proposal) => proposal.id);
    const notices = await tx.noticeRevision.findMany({ where: { caseId: current.id }, select: { id: true, textRevisionId: true } });
    const noticeIds = notices.map((notice) => notice.id);
    const relationIds = (await tx.noticeRelation.findMany({ where: { caseId: current.id }, select: { id: true } })).map((relation) => relation.id);
    const textRevisionIds = [...new Set(notices.map((notice) => notice.textRevisionId))];
    const sourceRows = textRevisionIds.length ? await tx.textRevision.findMany({ where: { id: { in: textRevisionIds } }, select: { id: true, sourceId: true } }) : [];
    const sourceIds = [...new Set(sourceRows.map((row) => row.sourceId))];
    const intakes = sourceIds.length ? await tx.intake.findMany({ where: { sourceArtifactId: { in: sourceIds } }, select: { id: true } }) : [];
    const intakeIds = intakes.map((intake) => intake.id);
    const storageRows = sourceIds.length ? await tx.sourceArtifact.findMany({ where: { id: { in: sourceIds } }, select: { id: true, privateStorageKey: true } }) : [];
    const deleted: Record<string, number> = {};
    const count = async (name: string, action: Promise<{ count: number }>) => { deleted[name] = (await action).count; };

    if (proposalIds.length) {
      await count('proposalApplication', tx.proposalApplication.deleteMany({ where: { proposalId: { in: proposalIds } } }));
      await count('proposalOperation', tx.proposalOperation.deleteMany({ where: { proposalId: { in: proposalIds } } }));
      await count('proposalQuestion', tx.proposalQuestion.deleteMany({ where: { proposalId: { in: proposalIds } } }));
      await count('compensationTarget', tx.compensationTarget.deleteMany({ where: { proposalId: { in: proposalIds } } }));
      await count('changeProposal', tx.changeProposal.deleteMany({ where: { id: { in: proposalIds } } }));
    }
    if (taskIds.length) {
      await count('completionRecord', tx.completionRecord.deleteMany({ where: { taskId: { in: taskIds } } }));
      await count('handoff', tx.handoff.deleteMany({ where: { taskId: { in: taskIds } } }));
      await count('reminderLog', tx.reminderLog.deleteMany({ where: { taskId: { in: taskIds } } }));
      await count('preparation', tx.preparation.deleteMany({ where: { taskId: { in: taskIds } } }));
      await count('requirement', tx.requirement.deleteMany({ where: { taskId: { in: taskIds } } }));
      await count('calendarExport', tx.calendarExport.deleteMany({ where: { taskId: { in: taskIds } } }));
      await count('task', tx.task.deleteMany({ where: { id: { in: taskIds } } }));
    }
    if (relationIds.length) await count('noticeRelation', tx.noticeRelation.deleteMany({ where: { id: { in: relationIds } } }));
    if (noticeIds.length) await count('noticeRevision', tx.noticeRevision.deleteMany({ where: { id: { in: noticeIds } } }));
    if (intakeIds.length) {
      await count('textApproval', tx.textApproval.deleteMany({ where: { intakeId: { in: intakeIds } } }));
      await count('agentRun', tx.agentRun.deleteMany({ where: { intakeId: { in: intakeIds } } }));
      await count('intake', tx.intake.deleteMany({ where: { id: { in: intakeIds } } }));
    }
    // Text revisions and artifacts may be shared by another notice; only remove unreferenced rows.
    const remainingNoticeTextIds = new Set(textRevisionIds.length ? (await tx.noticeRevision.findMany({ where: { textRevisionId: { in: textRevisionIds } }, select: { textRevisionId: true } })).map((row) => row.textRevisionId) : []);
    const deletableTextIds = textRevisionIds.filter((id) => !remainingNoticeTextIds.has(id));
    if (deletableTextIds.length) {
      await count('evidence', tx.evidence.deleteMany({ where: { textRevisionId: { in: deletableTextIds } } }));
      await count('textRevision', tx.textRevision.deleteMany({ where: { id: { in: deletableTextIds } } }));
    }
    const remainingSourceIds = new Set(sourceIds.length ? (await tx.textRevision.findMany({ where: { sourceId: { in: sourceIds } }, select: { sourceId: true } })).map((row) => row.sourceId) : []);
    const remainingIntakeSourceIds = new Set(sourceIds.length ? (await tx.intake.findMany({ where: { sourceArtifactId: { in: sourceIds } }, select: { sourceArtifactId: true } })).map((row) => row.sourceArtifactId).filter((id): id is string => Boolean(id)) : []);
    const deletableSourceIds = sourceIds.filter((id) => !remainingSourceIds.has(id) && !remainingIntakeSourceIds.has(id));
    if (deletableSourceIds.length) await count('sourceArtifact', tx.sourceArtifact.deleteMany({ where: { id: { in: deletableSourceIds } } }));
    await count('auditEvent', tx.auditEvent.deleteMany({ where: { caseId: current.id } }));
    await count('case', tx.case.deleteMany({ where: { id: current.id, version: current.version } }));
    const remaining = await tx.case.findUnique({ where: { id: current.id }, select: { id: true } });
    if (remaining) throw new CaseDeletionError('VERSION_CONFLICT');
    return { deleted, storageKeys: storageRows.filter((row) => sourceIds.includes(row.id) && deletableSourceIds.includes(row.id)).map((row) => row.privateStorageKey) };
  });
  return { caseId: current.id, ...result };
}

export async function cleanupDeletedCaseFiles(storageKeys: string[], storageDirectory: string): Promise<void> {
  for (const key of storageKeys) {
    // Validate every key even if the file is already gone; user data never controls a deletion path.
    assertStorageKey(key, storageDirectory);
    await removeStorageKey(key, storageDirectory);
  }
}

