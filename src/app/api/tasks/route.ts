import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

export async function GET() {
  const tasks = await db.task.findMany();
  const caseIds = [...new Set(tasks.map((task) => task.caseId))];
  const taskIds = tasks.map((task) => task.id);
  const [cases, preparations, handoffs, exports, audits, requirements, completions, notices] = await Promise.all([
    db.case.findMany({ where: { id: { in: caseIds } } }),
    db.preparation.findMany({ where: { taskId: { in: taskIds } } }),
    db.handoff.findMany({ where: { taskId: { in: taskIds } }, orderBy: { createdAt: 'desc' } }),
    db.calendarExport.findMany({ where: { taskId: { in: taskIds } }, orderBy: { generatedAt: 'desc' } }),
    db.auditEvent.findMany({ where: { caseId: { in: caseIds } }, orderBy: { createdAt: 'desc' } }),
    db.requirement.findMany({ where: { taskId: { in: taskIds } }, orderBy: { id: 'asc' } }),
    db.completionRecord.findMany({ where: { taskId: { in: taskIds } }, orderBy: { createdAt: 'desc' } }),
    db.noticeRevision.findMany({ where: { caseId: { in: caseIds } }, orderBy: { createdAt: 'asc' } }),
  ]);
  const revisionIds = [...new Set(notices.map((notice) => notice.textRevisionId))];
  const [revisions, evidence] = await Promise.all([
    db.textRevision.findMany({ where: { id: { in: revisionIds } } }),
    db.evidence.findMany({ where: { textRevisionId: { in: revisionIds } }, orderBy: { start: 'asc' } }),
  ]);
  const versions = new Map(cases.map((entry) => [entry.id, entry.version]));
  const texts = new Map(revisions.map((revision) => [revision.id, revision]));
  return NextResponse.json({ tasks: tasks.map((task) => ({
    ...task,
    caseVersion: versions.get(task.caseId) ?? 1,
    requirements: requirements.filter((requirement) => requirement.taskId === task.id).map((requirement) => ({ id: requirement.id, label: requirement.label, active: requirement.active, satisfaction: requirement.satisfaction })),
    completionRecords: completions.filter((completion) => completion.taskId === task.id).map((completion) => ({ id: completion.id, coveredEpoch: completion.coveredEpoch, coveredRequirementIds: JSON.parse(completion.coveredRequirementIdsJson) as string[], statement: completion.statement, kind: completion.kind, evidenceIds: JSON.parse(completion.evidenceIdsJson) as string[], recordedBy: completion.recordedBy, createdAt: completion.createdAt })),
    sources: notices.filter((notice) => notice.caseId === task.caseId).map((notice) => ({ id: notice.id, textRevisionId: notice.textRevisionId, text: texts.get(notice.textRevisionId)?.text ?? null, method: texts.get(notice.textRevisionId)?.method ?? null, issuedAt: notice.issuedAt, issuer: notice.issuer, evidence: evidence.filter((entry) => entry.textRevisionId === notice.textRevisionId).map((entry) => ({ id: entry.id, quote: entry.quote, start: entry.start, end: entry.end, origin: entry.origin })) })),
    preparations: preparations.filter((preparation) => preparation.taskId === task.id).map((preparation) => ({ id: preparation.id, title: preparation.title, status: preparation.status, planState: preparation.planState, dependencyIds: JSON.parse(preparation.dependencyIdsJson) as string[], requirementIds: JSON.parse(preparation.requirementIdsJson) as string[], start: preparation.start, end: preparation.end, durationMinutes: preparation.durationMinutes })),
    handoffs: handoffs.filter((handoff) => handoff.taskId === task.id).map((handoff) => ({ id: handoff.id, fromOwnerId: handoff.fromOwnerId, toOwnerId: handoff.toOwnerId, status: handoff.status, basisEvidenceId: handoff.basisEvidenceId, createdAt: handoff.createdAt })),
    calendarExports: exports.filter((entry) => entry.taskId === task.id).map((entry) => ({ id: entry.id, uid: entry.uid, sequence: entry.sequence, caseVersion: entry.caseVersion, generatedAt: entry.generatedAt, sha256: entry.sha256, stale: entry.stale })),
    calendarStale: exports.find((entry) => entry.taskId === task.id)?.stale ?? false,
    history: audits.filter((audit) => audit.caseId === task.caseId).map((audit) => ({ eventType: audit.eventType, caseVersion: audit.caseVersion, createdAt: audit.createdAt })),
  })) });
}
