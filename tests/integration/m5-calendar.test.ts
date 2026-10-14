import { PrismaClient } from '@prisma/client';
import { afterEach, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GET } from '../../src/app/api/tasks/[id]/calendar.ics/route';
import { GET as GET_TASKS } from '../../src/app/api/tasks/route';
import { POST as POST_COMMAND } from '../../src/app/api/commands/route';
import { ProposalService } from '../../src/application/proposal-service';

const db = new PrismaClient();
const caseIds: string[] = [];

describe('M5 calendar export metadata and preparation impact', () => {
  it('records exports, marks old snapshots stale, and flags a preparation after a new deadline', async () => {
    const id = randomUUID();
    const caseId = `m5-case-${id}`;
    const taskId = `m5-task-${id}`;
    caseIds.push(caseId);
    await db.case.create({ data: { id: caseId, title: 'M5 task', category: 'submission' } });
    await db.task.create({ data: { id: taskId, caseId, title: 'M5 task', dueJson: JSON.stringify({ kind: 'date', value: '2026-10-10', timezone: 'Asia/Shanghai', boundary: 'inclusive' }) } });
    await db.preparation.create({ data: { id: `m5-prep-${id}`, taskId, title: 'Prepare material', end: '2026-10-10T18:00:00+08:00' } });

    const first = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: taskId }) });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-case-version')).toBe('1');
    expect((await db.calendarExport.findMany({ where: { taskId } })).length).toBe(1);

    const service = new ProposalService(db);
    const due = { kind: 'date', value: '2026-10-09', timezone: 'Asia/Shanghai', boundary: 'inclusive' };
    const payload = JSON.stringify([{ op: 'set_due', taskId, value: due }]);
    const proposal = await service.create({ caseId, expectedVersion: 1, operations: [{ op: 'set_due', taskId, value: due }], payload });
    await service.apply({ proposalId: proposal.proposalId, expectedVersion: 1, key: `m5-key-${id}`, payload });
    expect((await db.calendarExport.findFirstOrThrow({ where: { taskId } })).stale).toBe(true);
    expect((await db.preparation.findFirstOrThrow({ where: { taskId } })).planState).toBe('needs_review');

    const second = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: taskId }) });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-case-version')).toBe('2');
    const exports = await db.calendarExport.findMany({ where: { taskId }, orderBy: { sequence: 'asc' } });
    expect(exports).toHaveLength(2);
    expect(exports[0]?.stale).toBe(true);
    expect(exports[1]?.stale).toBe(false);
    expect(exports[1]?.sequence).toBe(2);
  });

  it('does not create export metadata when the due date is unknown', async () => {
    const id = randomUUID();
    const caseId = `m5-unknown-case-${id}`;
    const taskId = `m5-unknown-task-${id}`;
    caseIds.push(caseId);
    await db.case.create({ data: { id: caseId, title: 'Unknown date', category: 'submission' } });
    await db.task.create({ data: { id: taskId, caseId, title: 'Unknown date' } });
    const response = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: taskId }) });
    expect(response.status).toBe(422);
    expect((await db.calendarExport.count({ where: { taskId } }))).toBe(0);
  });

  it('uses the real command API for preparations and handoffs, preserving user-visible failures', async () => {
    const id = randomUUID();
    const caseId = `m5-api-case-${id}`;
    const taskId = `m5-api-task-${id}`;
    const preparationId = `m5-api-prep-${id}`;
    caseIds.push(caseId);
    await db.case.create({ data: { id: caseId, title: 'M5 API task', category: 'submission' } });
    await db.task.create({ data: { id: taskId, caseId, title: 'M5 API task', dueJson: JSON.stringify({ kind: 'date', value: '2026-10-10', timezone: 'Asia/Shanghai', boundary: 'inclusive' }) } });

    const command = (body: Record<string, unknown>) => POST_COMMAND(new Request('http://localhost/api/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const firstPreparation = { action: 'save_preparation', id: preparationId, taskId, title: '准备材料', dependencies: [], end: '2026-10-10T18:00:00+08:00', expectedCaseVersion: 1, idempotencyKey: `m5-prep-${id}` };
    expect((await command(firstPreparation)).status).toBe(200);
    expect((await command(firstPreparation)).status).toBe(200);
    expect(await db.preparation.count({ where: { taskId } })).toBe(1);
    expect((await db.preparation.findUniqueOrThrow({ where: { id: preparationId } })).planState).toBe('valid');

    const invalidDependency = await command({ action: 'save_preparation', id: `m5-invalid-prep-${id}`, taskId, title: '错误依赖', dependencies: ['missing-preparation'], expectedCaseVersion: 2, idempotencyKey: `m5-invalid-prep-${id}` });
    expect(invalidDependency.status).toBe(422);
    expect((await invalidDependency.json()).error.code).toBe('PREPARATION_DEPENDENCY_NOT_FOUND');
    expect((await db.case.findUniqueOrThrow({ where: { id: caseId } })).version).toBe(2);

    const handoffRequest = await command({ action: 'request_handoff', id: `m5-handoff-${id}`, taskId, toOwnerId: 'owner-a', basisEvidenceId: '', expectedCaseVersion: 2, idempotencyKey: `m5-handoff-${id}` });
    expect(handoffRequest.status).toBe(200);
    const duplicatePending = await command({ action: 'request_handoff', id: `m5-handoff-duplicate-${id}`, taskId, toOwnerId: 'owner-b', basisEvidenceId: '', expectedCaseVersion: 3, idempotencyKey: `m5-handoff-duplicate-${id}` });
    expect(duplicatePending.status).toBe(409);
    expect((await duplicatePending.json()).error.code).toBe('HANDOFF_ALREADY_PENDING');
    expect((await db.handoff.findMany({ where: { taskId } })).length).toBe(1);

    const declined = await command({ action: 'record_handoff_declined', handoffId: `m5-handoff-${id}`, expectedCaseVersion: 3, idempotencyKey: `m5-handoff-decline-${id}` });
    expect(declined.status).toBe(200);
    const secondRequest = await command({ action: 'request_handoff', id: `m5-handoff-second-${id}`, taskId, toOwnerId: 'owner-b', basisEvidenceId: '', expectedCaseVersion: 4, idempotencyKey: `m5-handoff-second-${id}` });
    expect(secondRequest.status).toBe(200);
    expect((await (await command({ action: 'record_handoff_cancelled', handoffId: `m5-handoff-second-${id}`, expectedCaseVersion: 5, idempotencyKey: `m5-handoff-cancel-${id}` })).json()).result.status).toBe('cancelled');
    const thirdRequest = await command({ action: 'request_handoff', id: `m5-handoff-third-${id}`, taskId, toOwnerId: 'owner-c', basisEvidenceId: '', expectedCaseVersion: 6, idempotencyKey: `m5-handoff-third-${id}` });
    expect(thirdRequest.status).toBe(200);
    expect((await (await command({ action: 'record_handoff_acceptance', handoffId: `m5-handoff-third-${id}`, expectedCaseVersion: 7, idempotencyKey: `m5-handoff-accept-${id}` })).json()).result.status).toBe('accepted_reported');

    const taskResponse = await GET_TASKS();
    const task = ((await taskResponse.json()) as { tasks: Array<{ id: string; effectiveOwnerId: string | null; preparations: Array<{ planState: string }>; handoffs: Array<{ status: string }>; history: Array<{ eventType: string }> }> }).tasks.find((item) => item.id === taskId);
    expect(task?.effectiveOwnerId).toBe('owner-c');
    expect(task?.preparations[0]?.planState).toBe('valid');
    expect(task?.handoffs.map((handoff) => handoff.status)).toEqual(expect.arrayContaining(['accepted_reported', 'cancelled', 'declined']));
    expect(task?.history.map((event) => event.eventType)).toEqual(expect.arrayContaining(['preparation_saved', 'handoff_requested', 'handoff_declined', 'handoff_cancelled', 'handoff_accepted_reported']));
  });

  it('exports instant and cancelled events with stable UID/SEQUENCE and clears the current stale hint after re-export', async () => {
    const id = randomUUID();
    const caseId = `m5-cancel-case-${id}`;
    const taskId = `m5-cancel-task-${id}`;
    caseIds.push(caseId);
    await db.case.create({ data: { id: caseId, title: 'Cancel event', category: 'event' } });
    await db.task.create({ data: { id: taskId, caseId, title: 'Cancel event', dueJson: JSON.stringify({ kind: 'instant', value: '2026-10-10T10:00:00+08:00', timezone: 'Asia/Shanghai' }) } });
    const first = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: taskId }) });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('DTSTART:20261010T020000Z');
    expect(await db.calendarExport.count({ where: { taskId } })).toBe(1);

    const service = new ProposalService(db);
    const proposal = await service.proposeCancellation({ caseId, taskId, expectedVersion: 1, payload: `cancel-${id}` });
    await service.apply({ proposalId: proposal.proposalId, expectedVersion: 1, key: `cancel-${id}`, payload: `cancel-${id}` });
    expect((await db.calendarExport.findFirstOrThrow({ where: { taskId }, orderBy: { sequence: 'asc' } })).stale).toBe(true);
    const cancelled = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: taskId }) });
    expect(cancelled.status).toBe(200);
    const cancelledText = await cancelled.text();
    expect(cancelledText).toContain(`UID:${taskId}@campus-notice.local`);
    expect(cancelledText).toContain('SEQUENCE:2');
    expect(cancelledText).toContain('STATUS:CANCELLED');
    const exports = await db.calendarExport.findMany({ where: { taskId }, orderBy: { sequence: 'asc' } });
    expect(exports.map((item) => item.stale)).toEqual([true, false]);
    const taskResponse = await GET_TASKS();
    const task = ((await taskResponse.json()) as { tasks: Array<{ id: string; calendarStale: boolean }> }).tasks.find((item) => item.id === taskId);
    expect(task?.calendarStale).toBe(false);
  });
});

async function cleanupCases() {
  for (const caseId of caseIds) {
    const tasks = await db.task.findMany({ where: { caseId }, select: { id: true } });
    const taskIds = tasks.map((task) => task.id);
    const proposals = await db.changeProposal.findMany({ where: { caseId }, select: { id: true } });
    const proposalIds = proposals.map((proposal) => proposal.id);
    await db.auditEvent.deleteMany({ where: { caseId } });
    await db.proposalApplication.deleteMany({ where: { proposalId: { in: proposalIds } } });
    await db.proposalOperation.deleteMany({ where: { proposalId: { in: proposalIds } } });
    await db.compensationTarget.deleteMany({ where: { proposalId: { in: proposalIds } } });
    await db.changeProposal.deleteMany({ where: { id: { in: proposalIds } } });
    await db.calendarExport.deleteMany({ where: { taskId: { in: taskIds } } });
    await db.preparation.deleteMany({ where: { taskId: { in: taskIds } } });
    await db.task.deleteMany({ where: { id: { in: taskIds } } });
    await db.case.delete({ where: { id: caseId } });
  }
  caseIds.splice(0, caseIds.length);
}

afterEach(cleanupCases);
afterAll(async () => {
  await cleanupCases();
  await db.$disconnect();
});
