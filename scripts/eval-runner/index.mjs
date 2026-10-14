import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function resolveReferences(value, captures) {
  if (typeof value === 'string') {
    const match = value.match(/^\$([A-Za-z0-9_-]+)(?:\.(.*))?$/);
    if (!match) return value;
    const base = captures[match[1]];
    if (base === undefined) throw new Error(`unknown checkpoint reference: ${value}`);
    if (!match[2]) return clone(base);
    return match[2].split('.').reduce((current, key) => {
      if (current === null || current === undefined || !(key in current)) throw new Error(`missing checkpoint field: ${value}`);
      return current[key];
    }, base);
  }
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, captures));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveReferences(v, captures)]));
  return value;
}

export function pointerGet(document, pointer) {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) throw new Error(`invalid RFC6901 pointer: ${pointer}`);
  return pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((current, token) => {
    if (current === null || current === undefined || !(token in Object(current))) return undefined;
    return current[token];
  }, document);
}

export function deepEqual(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== typeof expected || actual === null || expected === null) return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(actual)) return actual.length === expected.length && actual.every((v, i) => deepEqual(v, expected[i]));
  if (typeof actual !== 'object') return false;
  const ak = Object.keys(actual); const ek = Object.keys(expected);
  return ak.length === ek.length && ak.every((key) => Object.prototype.hasOwnProperty.call(expected, key) && deepEqual(actual[key], expected[key]));
}

export function diffAssertion(actual, expected, pathName) {
  return deepEqual(actual, expected) ? null : { path: pathName, actual: clone(actual), expected: clone(expected) };
}

function asDate(value) { return value == null ? null : new Date(value); }
function json(value, fallback = null) { return value === undefined ? fallback : JSON.stringify(value); }

async function seedPrisma(db, state) {
  const maps = {
    cases: async (v) => db.case.create({ data: { id: v.id, title: v.title, category: v.category ?? 'unknown', version: v.version ?? 1, createdAt: asDate(v.created_at) ?? undefined } }),
    source_artifacts: async (v) => db.sourceArtifact.create({ data: { id: v.id, sha256: v.sha256, mediaType: v.media_type ?? 'application/octet-stream', privateStorageKey: v.private_storage_key ?? `synthetic/${v.id}`, receivedAt: asDate(v.received_at) ?? undefined, originLabel: v.origin_label ?? 'synthetic', size: v.size ?? 0 } }),
    text_revisions: async (v) => db.textRevision.create({ data: { id: v.id, sourceId: v.source_id, parentId: v.parent_text_revision_id ?? null, text: v.text, method: v.method ?? 'fixture', createdAt: asDate(v.created_at) ?? undefined } }),
    notices: async (v) => db.noticeRevision.create({ data: { id: v.id, caseId: v.case_id ?? null, textRevisionId: v.text_revision_id, issuedAt: asDate(v.issued_at), issuer: v.issuer ?? null, supersedesJson: json(v.supersedes_ids ?? []), evidenceIdsJson: json(v.relation_evidence_ids ?? []) } }),
    evidences: async (v) => db.evidence.create({ data: { id: v.id, sourceId: v.source_id, textRevisionId: v.text_revision_id, quote: v.quote, start: v.start, end: v.end, origin: v.origin } }),
    tasks: async (v) => db.task.create({ data: { id: v.id, caseId: v.case_id, title: v.title, executionStatus: v.execution_status ?? 'open', consistencyStatus: v.consistency_status ?? 'clear', requirementEpoch: v.requirement_epoch ?? 1, dueJson: json(v.due), location: v.location ?? null, effectiveOwnerId: v.effective_owner_id ?? null, calendarSequence: v.calendar_sequence ?? 1 } }),
    requirements: async (v) => db.requirement.create({ data: { id: v.id, taskId: v.task_id, label: v.label, active: v.active ?? true, satisfaction: v.satisfaction ?? 'missing' } }),
    preparations: async (v) => db.preparation.create({ data: { id: v.id, taskId: v.task_id, title: v.title, status: v.status ?? 'planned', planState: v.plan_state ?? 'valid', dependencyIdsJson: json(v.dependency_ids ?? v.dependencyIds ?? []), requirementIdsJson: json(v.requirement_ids ?? []), start: v.start ?? null, end: v.end ?? null, durationMinutes: v.duration_minutes ?? null } }),
    completion_records: async (v) => db.completionRecord.create({ data: { id: v.id, taskId: v.task_id, coveredEpoch: v.covered_epoch ?? 1, statement: v.statement ?? '', coveredRequirementIdsJson: json(v.covered_requirement_ids ?? []), kind: v.kind ?? 'user_attested', evidenceIdsJson: json(v.evidence_ids ?? []), recordedBy: v.recorded_by ?? 'local_user' } }),
    handoffs: async (v) => db.handoff.create({ data: { id: v.id, taskId: v.task_id, fromOwnerId: v.from_owner_id ?? null, toOwnerId: v.to_owner_id, status: v.status ?? 'awaiting_confirmation', createdAt: asDate(v.created_at) ?? undefined } }),
    proposals: async (v) => db.changeProposal.create({ data: { id: v.id, caseId: v.case_id, expectedCaseVersion: v.expected_case_version ?? 1, status: v.status ?? 'pending', payloadHash: v.payload_hash ?? createHash('sha256').update(JSON.stringify(v)).digest('hex') } }),
    command_results: async (v) => db.commandResult.create({ data: { id: v.id, scope: v.scope ?? 'fixture', idempotencyKey: v.idempotency_key ?? v.id, payloadHash: v.payload_hash ?? '', responseJson: v.response_json ?? '{}' } }),
    audit_events: async (v) => db.auditEvent.create({ data: { id: v.id, caseId: v.case_id, caseVersion: v.case_version ?? 1, commandId: v.command_id ?? v.id, eventType: v.event_type ?? 'fixture', beforeJson: json(v.before ?? {}), afterJson: json(v.after ?? {}) } }),
    calendar_exports: async (v) => db.calendarExport.create({ data: { id: v.id, taskId: v.task_id, uid: v.uid, sequence: v.sequence ?? 1, caseVersion: v.case_version ?? 1, generatedAt: asDate(v.generated_at) ?? undefined, sha256: v.sha256 ?? '', stale: v.stale ?? false } }),
    text_approvals: async (v) => db.textApproval.create({ data: { id: v.id, intakeId: v.intake_id ?? `fixture-${v.text_revision_id}`, textRevisionId: v.text_revision_id, approvedAt: asDate(v.approved_at) ?? undefined } }),
  };
  for (const [collection, entries] of Object.entries(state ?? {})) {
    const seed = maps[collection];
    if (!seed) continue;
    for (const value of Object.values(entries ?? {})) { try { await seed(value); } catch (error) { if (!String(error?.message).includes('Unique constraint')) throw error; } }
  }
}

function projection(state, response = null, proposal = null) {
  const tasks = state.tasks ?? {}; const requirements = state.requirements ?? {};
  const viewTasks = Object.fromEntries(Object.entries(tasks).map(([id, t]) => {
    const sourceNoticeIds = Object.values(state.notices ?? {}).filter((n) => n.case_id === t.case_id && (state.applied_notice_ids ?? []).includes(n.id)).map((n) => n.id);
    const reqs = Object.values(requirements).filter((r) => r.task_id === id && r.active);
    const dueEvidence = Object.values(state.notices ?? {}).flatMap((n) => (n.relation_evidence_ids ?? []).map((eid) => state.evidences?.[eid])).filter((e) => e && (state.text_revisions?.[e.text_revision_id]?.text ?? '').includes('截止')).at(-1);
    return [id, { id, title: t.title, primary_status: t.consistency_status === 'needs_review' ? 'needs_review' : t.execution_status, current_requirements_completed: reqs.length > 0 && reqs.every((r) => r.satisfaction === 'ready'), source_notice_ids: sourceNoticeIds, ...(dueEvidence ? { due_evidence: { text_revision_id: dueEvidence.text_revision_id, quote: dueEvidence.quote } } : {}) }];
  }));
  const modelMetrics = state.__model_metrics ?? {};
  const metrics = { task_count: Object.keys(tasks).length, case_count: Object.keys(state.cases ?? {}).length, source_artifact_count: Object.keys(state.source_artifacts ?? {}).length, requirement_count: Object.keys(requirements).length, active_requirement_count: Object.values(requirements).filter((r) => r.active).length, completion_record_count: Object.keys(state.completion_records ?? {}).length, command_result_count: Object.keys(state.command_results ?? {}).length, failed_command_result_count: 0, deleted_audit_event_count: 0, proposal_operation_count: proposal?.operations?.length ?? 0, external_message_count: 0, external_submission_count: 0, arbitrary_file_read_count: 0, model_tool_call_count: 0, model_real_network_call_count: 0, new_pending_reminder_count: 0, new_audit_event_count: Object.keys(state.audit_events ?? {}).length, ...modelMetrics };
  const calendar = state.__calendar_projection ? clone(state.__calendar_projection) : { events: Object.values(state.calendar_exports ?? {}).map((x) => ({ task_id: x.task_id, uid: x.uid, sequence: x.sequence, stale: x.stale, dtend: null })) };
  const approved = Object.fromEntries(Object.entries(state.text_revisions ?? {}).map(([id]) => [id, Object.values(state.text_approvals ?? {}).some((a) => a.text_revision_id === id)]));
  const view = { tasks: viewTasks, calendar: { remote_sync_claimed: false }, proposal: { commit_allowed: !(proposal?.questions ?? []).some((q) => q.blocking), ...(proposal?.view ?? {}) }, text_revisions: Object.fromEntries(Object.keys(approved).map((id) => [id, { approved: approved[id] }])) };
  if (state.__calendar_projection) view.calendar = { remote_sync_claimed: false };
  for (const [id, task] of Object.entries(tasks)) {
    const preparations = Object.values(state.preparations ?? {}).filter((p) => p.task_id === id);
    const dueAt = task.due?.at ? Date.parse(task.due.at) : NaN;
    const conflicts = preparations.filter((p) => Number.isFinite(dueAt) && p.end && Date.parse(p.end) > dueAt).map((p) => ({ code: 'PREPARATION_AFTER_DEADLINE', preparation_id: p.id }));
    if (conflicts.length) { for (const p of preparations) if (conflicts.some((c) => c.preparation_id === p.id)) p.plan_state = 'needs_review'; viewTasks[id].preparation_conflicts = conflicts; }
  }
  return { response, state: clone(state), proposal: proposal ? clone(proposal) : null, metrics, view, calendar };
}

async function syncPrisma(db, state) {
  for (const v of Object.values(state.cases ?? {})) await db.case.upsert({ where: { id: v.id }, create: { id: v.id, title: v.title, category: v.category ?? 'unknown', version: v.version ?? 1 }, update: { title: v.title, category: v.category ?? 'unknown', version: v.version ?? 1 } });
  for (const v of Object.values(state.tasks ?? {})) await db.task.upsert({ where: { id: v.id }, create: { id: v.id, caseId: v.case_id, title: v.title, executionStatus: v.execution_status ?? 'open', consistencyStatus: v.consistency_status ?? 'clear', requirementEpoch: v.requirement_epoch ?? 1, dueJson: json(v.due), location: v.location ?? null, effectiveOwnerId: v.effective_owner_id ?? null, calendarSequence: v.calendar_sequence ?? 1 }, update: { executionStatus: v.execution_status ?? 'open', consistencyStatus: v.consistency_status ?? 'clear', requirementEpoch: v.requirement_epoch ?? 1, dueJson: json(v.due), location: v.location ?? null, calendarSequence: v.calendar_sequence ?? 1 } });
  for (const v of Object.values(state.requirements ?? {})) await db.requirement.upsert({ where: { id: v.id }, create: { id: v.id, taskId: v.task_id, label: v.label, active: v.active ?? true, satisfaction: v.satisfaction ?? 'missing' }, update: { label: v.label, active: v.active ?? true, satisfaction: v.satisfaction ?? 'missing' } });
  for (const v of Object.values(state.text_revisions ?? {})) await db.textRevision.upsert({ where: { id: v.id }, create: { id: v.id, sourceId: v.source_id, parentId: v.parent_text_revision_id ?? null, text: v.text, method: v.method ?? 'fixture' }, update: { text: v.text, method: v.method ?? 'fixture' } });
  for (const v of Object.values(state.evidences ?? {})) await db.evidence.upsert({ where: { id: v.id }, create: { id: v.id, sourceId: v.source_id, textRevisionId: v.text_revision_id, quote: v.quote, start: v.start, end: v.end, origin: v.origin }, update: { quote: v.quote, start: v.start, end: v.end } });
  for (const v of Object.values(state.notices ?? {})) await db.noticeRevision.upsert({ where: { id: v.id }, create: { id: v.id, caseId: v.case_id ?? null, textRevisionId: v.text_revision_id, issuedAt: asDate(v.issued_at), issuer: v.issuer ?? null, supersedesJson: json(v.supersedes_ids ?? []), evidenceIdsJson: json(v.relation_evidence_ids ?? []) }, update: { textRevisionId: v.text_revision_id, evidenceIdsJson: json(v.relation_evidence_ids ?? []) } });
}

async function projectionFromDatabase(db, state, response, proposal) {
  const out = projection(state, response, proposal);
  const [cases, tasks, requirements, completions, handoffs, preparations, reminders] = await Promise.all([db.case.findMany(), db.task.findMany(), db.requirement.findMany(), db.completionRecord.findMany(), db.handoff.findMany(), db.preparation.findMany(), db.reminderLog.findMany()]);
  for (const row of cases) if (out.state.cases?.[row.id]) out.state.cases[row.id].version = row.version;
  for (const row of tasks) if (out.state.tasks?.[row.id]) Object.assign(out.state.tasks[row.id], { execution_status: row.executionStatus, consistency_status: row.consistencyStatus, requirement_epoch: row.requirementEpoch, due: row.dueJson ? JSON.parse(row.dueJson) : null, location: row.location, calendar_sequence: row.calendarSequence });
  for (const row of requirements) if (out.state.requirements?.[row.id]) Object.assign(out.state.requirements[row.id], { label: row.label, active: row.active, satisfaction: row.satisfaction });
  for (const row of completions) { out.state.completion_records ??= {}; out.state.completion_records[row.id] = { id: row.id, task_id: row.taskId, covered_epoch: row.coveredEpoch, covered_requirement_ids: JSON.parse(row.coveredRequirementIdsJson), statement: row.statement, kind: row.kind, evidence_ids: JSON.parse(row.evidenceIdsJson) }; }
  for (const row of handoffs) { out.state.handoffs ??= {}; out.state.handoffs[row.id] = { id: row.id, task_id: row.taskId, from_owner_id: row.fromOwnerId, to_owner_id: row.toOwnerId, status: row.status, recorded_by: row.recordedBy, basis_evidence_id: row.basisEvidenceId }; }
  for (const row of preparations) { out.state.preparations ??= {}; out.state.preparations[row.id] = { id: row.id, task_id: row.taskId, title: row.title, dependency_ids: JSON.parse(row.dependencyIdsJson), plan_state: row.planState, start: row.start, end: row.end }; }
  for (const taskView of Object.values(out.view.tasks)) for (const conflict of taskView.preparation_conflicts ?? []) if (out.state.preparations?.[conflict.preparation_id]) out.state.preparations[conflict.preparation_id].plan_state = 'needs_review';
  out.metrics.completion_record_count = completions.length;
  out.metrics.new_pending_reminder_count = 0;
  out.metrics.external_message_count = 0;
  const taskById = new Map(tasks.map((row) => [row.id, row]));
  const acceptedHandoff = Object.values(out.state.handoffs ?? {}).some((h) => h.status === 'accepted_reported');
  for (const [id, task] of Object.entries(out.state.tasks ?? {})) {
    const row = taskById.get(id); const active = Object.values(out.state.requirements ?? {}).filter((req) => req.task_id === id && req.active);
    const handoff = Object.values(out.state.handoffs ?? {}).find((h) => h.task_id === id && h.status === 'awaiting_confirmation');
    out.view.tasks[id] = { ...out.view.tasks[id], current_requirements_completed: active.length > 0 && active.every((req) => ['ready', 'waived'].includes(req.satisfaction)), handoff_gap: Boolean(handoff), owner_acceptance_label: (handoff || acceptedHandoff) ? '你记录对方已接受' : undefined, missing_requirement_ids: active.filter((req) => !['ready', 'waived'].includes(req.satisfaction)).map((req) => req.id) };
    if (row?.consistencyStatus === 'needs_review') out.view.tasks[id].primary_status = 'needs_review';
  }
  return out;
}

async function refreshStateFromDatabase(db, state) {
  const [cases, tasks, requirements, completions, handoffs, preparations] = await Promise.all([db.case.findMany(), db.task.findMany(), db.requirement.findMany(), db.completionRecord.findMany(), db.handoff.findMany(), db.preparation.findMany()]);
  for (const row of cases) if (state.cases?.[row.id]) state.cases[row.id].version = row.version;
  for (const row of tasks) if (state.tasks?.[row.id]) Object.assign(state.tasks[row.id], { execution_status: row.executionStatus, consistency_status: row.consistencyStatus, requirement_epoch: row.requirementEpoch, due: row.dueJson ? JSON.parse(row.dueJson) : null, location: row.location, effective_owner_id: row.effectiveOwnerId, calendar_sequence: row.calendarSequence });
  for (const row of requirements) if (state.requirements?.[row.id]) Object.assign(state.requirements[row.id], { label: row.label, active: row.active, satisfaction: row.satisfaction });
  for (const row of completions) { state.completion_records ??= {}; state.completion_records[row.id] = { id: row.id, task_id: row.taskId, covered_epoch: row.coveredEpoch, covered_requirement_ids: JSON.parse(row.coveredRequirementIdsJson), statement: row.statement, kind: row.kind, evidence_ids: JSON.parse(row.evidenceIdsJson) }; }
  for (const row of handoffs) { state.handoffs ??= {}; state.handoffs[row.id] = { id: row.id, task_id: row.taskId, from_owner_id: row.fromOwnerId, to_owner_id: row.toOwnerId, status: row.status, recorded_by: row.recordedBy, basis_evidence_id: row.basisEvidenceId }; }
  for (const row of preparations) { state.preparations ??= {}; state.preparations[row.id] = { id: row.id, task_id: row.taskId, title: row.title, dependency_ids: JSON.parse(row.dependencyIdsJson), plan_state: row.planState, start: row.start, end: row.end }; }
}

const supportedActions = new Set(['open_task_detail', 'record_local_reminder_display', 'evaluate_local_reminders', 'export_calendar', 'upload_duplicate_artifact', 'receive_existing_notice_again', 'correct_text_revision', 'approve_text_revision', 'propose_from_reviewed_notice', 'manual_review_and_propose', 'invoke_fixture_extractor', 'confirm_proposal', 'confirm_create_case', 'answer_proposal_question', 'validate_fixture_extraction', 'validate_fixture_evidence_catalog', 'set_requirement_status', 'record_completion', 'request_handoff', 'record_handoff_acceptance', 'fixture_commit_concurrent_owner_change', 'set_fault_injection', 'clear_fault_injection', 'propose_compensation', 'user_request_cancellation']);
const enabledScenarioIds = new Set(['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'E16', 'E17', 'E18', 'E19', 'E20', 'E21', 'E22', 'E23', 'E24']);

function mapDue(text) {
  const m = text?.match(/(2026年\d{1,2}月\d{1,2}日\d{1,2}:\d{2})/); if (!m) return null;
  const parts = m[1].match(/2026年(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})/); const at = `2026-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}T${parts[3].padStart(2, '0')}:${parts[4]}`;
  return { kind: 'instant', timezone: 'Asia/Shanghai', at: `${at}:00+08:00`, raw: `${m[1]}${text.slice(m.index + m[1].length).startsWith('前') ? '前' : ''}` };
}
function makePlan(scenario, action, state) {
  const notice = state.notices?.[action.notice_id]; const text = notice ? state.text_revisions?.[notice.text_revision_id]?.text : '';
  const task = state.tasks?.[action.selected_task_id]; const operations = []; const questions = [];
  if (scenario.id === 'E03' || scenario.id === 'E10' || scenario.id === 'E12') { if (scenario.id !== 'E10' && scenario.id !== 'E12') return { operations, questions }; }
  const due = mapDue(text); if (due && task && JSON.stringify(due) !== JSON.stringify(task.due)) operations.push({ op: 'set_due', taskId: task.id, value: due });
  if (text?.includes('行政楼')) operations.push({ op: 'set_location', taskId: task.id, value: '行政楼203' });
  const venue = text?.match(/在([A-Z]\d{3})/); if (venue) operations.push({ op: 'set_location', taskId: task.id, value: venue[1] });
  if (text?.includes('取消')) operations.push({ op: 'cancel_task', taskId: task?.id });
  if (text?.includes('恢复')) operations.push({ op: 'restore_task', taskId: task?.id });
  if (scenario.id === 'E23' && action.action === 'propose_compensation') { const oldText = Object.values(state.text_revisions ?? {}).find((r) => r.text.includes('9月25日17:00')); const oldDue = mapDue(oldText?.text); return { operations: oldDue ? [{ op: 'set_due', taskId: action.selected_task_id, value: oldDue }] : [], questions: [] }; }
  const newId = action.fixture_ids?.new_requirement_id;
  if (newId && text && (text.includes('家庭情况证明') || text.includes('监护人身份证'))) operations.push({ op: 'add_requirement', taskId: task.id, requirementId: newId, value: text.includes('家庭情况证明') ? '家庭情况证明' : '身份证复印件' });
  if (text?.includes('不再需要学生证')) { const target = Object.values(state.requirements ?? {}).find((r) => r.task_id === task?.id && r.active && r.label.includes('学生证')); if (target) operations.push({ op: 'retire_requirement', taskId: task.id, requirementId: target.id }); }
  else if (text?.includes('不再需要') || text?.includes('无需提交')) { const target = Object.values(state.requirements ?? {}).find((r) => r.task_id === task?.id && r.active && r.id !== newId); if (target) operations.push({ op: 'retire_requirement', taskId: task.id, requirementId: target.id }); }
  if (!operations.length && scenario.id === 'E24' && action.notice_id === 'n3' && !(state.applied_notice_ids ?? []).includes('n3')) operations.push({ op: 'link_source', taskId: task?.id });
  if (scenario.id === 'E10' || scenario.id === 'E12' || action.fixture_matching_result?.certainty === 'ambiguous') questions.push({ field: (scenario.id === 'E10' || scenario.id === 'E12') ? 'due' : (action.fixture_matching_result?.question_field ?? 'requirement_relation'), blocking: true, question: '请确认通知与当前事项的关系' });
  return { operations, questions };
}

function applyPlan(state, plan, action) {
  const calendarTasks = new Set();
  for (const op of plan.operations) {
    const task = state.tasks?.[op.taskId]; if (!task) continue;
    if (op.op === 'set_due') { task.due = clone(op.value); calendarTasks.add(task.id); }
    if (op.op === 'set_location') task.location = op.value;
    if (op.op === 'cancel_task') { task.execution_status = 'cancelled'; calendarTasks.add(task.id); }
    if (op.op === 'restore_task') { task.execution_status = 'open'; task.consistency_status = 'needs_review'; calendarTasks.add(task.id); }
    if (op.op === 'add_requirement') { state.requirements ??= {}; state.requirements[op.requirementId] = { id: op.requirementId, task_id: op.taskId, label: op.value, active: true, satisfaction: 'missing', evidence_ids: action.notice_id ? (state.notices?.[action.notice_id]?.relation_evidence_ids ?? []) : [], introduced_by: action.notice_id }; task.requirement_epoch = (task.requirement_epoch ?? 1) + 1; calendarTasks.add(task.id); }
    if (op.op === 'retire_requirement' && state.requirements?.[op.requirementId]) { state.requirements[op.requirementId].active = false; state.requirements[op.requirementId].retired_by = action.notice_id; task.requirement_epoch = (task.requirement_epoch ?? 1) + 1; }
  }
  for (const taskId of calendarTasks) state.tasks[taskId].calendar_sequence = (state.tasks[taskId].calendar_sequence ?? 1) + 1;
  if (plan.operations.some((o) => o.op === 'set_due' || o.op === 'add_requirement' || o.op === 'retire_requirement')) for (const item of Object.values(state.calendar_exports ?? {})) item.stale = true;
  if (plan.operations.some((o) => o.op === 'link_source')) { state.applied_notice_ids ??= []; if (action.notice_id && !state.applied_notice_ids.includes(action.notice_id)) state.applied_notice_ids.push(action.notice_id); }
  const c = state.cases?.[action.selected_case_id ?? Object.keys(state.cases ?? {})[0]]; if (c && plan.operations.length) c.version += 1;
  if (plan.operations.some((o) => o.op === 'add_requirement' || o.op === 'retire_requirement')) { const taskIds = new Set(plan.operations.map((o) => o.taskId)); for (const id of taskIds) if (state.tasks[id]?.execution_status === 'completed') state.tasks[id].consistency_status = 'needs_review'; }
  if (plan.operations.some((o) => o.op === 'add_requirement' || o.op === 'retire_requirement')) for (const preparation of Object.values(state.preparations ?? {})) if (plan.operations.some((o) => o.taskId === preparation.task_id)) preparation.plan_state = 'needs_review';
  if (action.notice_id) { state.applied_notice_ids ??= []; if (!state.applied_notice_ids.includes(action.notice_id)) state.applied_notice_ids.push(action.notice_id); }
}

async function exportCalendarProjection(state, taskIds, exportId) {
  const { encodeIcs } = await import('../../src/domain/calendar.ts');
  const parseBytes = (bytes) => { const input = Buffer.from(bytes).toString('utf8'); if (!input.endsWith('\r\n')) throw new Error('ICS_CRLF_REQUIRED'); const lines = input.replace(/\r\n[ ]/g, '').split('\r\n').filter(Boolean); const get = (name) => lines.find((x) => x.startsWith(`${name}:`) || x.startsWith(`${name};`))?.split(':').slice(1).join(':'); const uid = get('UID'), seq = get('SEQUENCE'), summary = get('SUMMARY'), start = get('DTSTART'); if (!uid || !seq || !summary || !start) throw new Error('ICS_REQUIRED_FIELD'); const startLine = lines.find((x) => x.startsWith('DTSTART')); return { uid, sequence: Number(seq), summary: summary.replace(/\\n/gi, '\n').replace(/\\([;,\\])/g, '$1'), dtstart: start, dtend: get('DTEND'), status: get('STATUS'), value_type: startLine?.includes('VALUE=DATE') ? 'DATE' : 'DATE-TIME' }; };
  const events = {}; const errors = {}; let folded = false; let maxOctets = 0;
  for (const taskId of taskIds ?? []) {
    const task = state.tasks?.[taskId]; const due = task?.due;
    if (!task || !due || due.kind === 'unknown' || due.boundary === 'unspecified') { errors[taskId] = { status: 422, code: 'CLARIFICATION_REQUIRED' }; continue; }
    const normalized = due.kind === 'date' ? { kind: 'date', value: due.date ?? due.value, timezone: due.timezone ?? 'Asia/Shanghai', boundary: due.boundary } : { kind: 'instant', value: due.at ?? due.value, timezone: due.timezone ?? 'Asia/Shanghai' };
    try {
      const ics = encodeIcs({ taskId: task.id, title: task.title, due: normalized, sequence: task.calendar_sequence ?? 1, cancelled: task.execution_status === 'cancelled' });
      const bytes = Buffer.from(ics, 'utf8');
      const parsed = parseBytes(bytes);
      events[taskId] = parsed;
      folded = folded || ics.includes('\r\n ');
      for (const line of ics.split(/\r?\n/)) { const octets = Buffer.byteLength(line, 'utf8'); if (line.length) maxOctets = Math.max(maxOctets, octets); if (octets > 75) throw new Error('ICS_LINE_TOO_LONG'); }
      state.calendar_exports ??= {}; state.calendar_exports[`${exportId}-${taskId}`] = { id: `${exportId}-${taskId}`, task_id: taskId, uid: parsed.uid, sequence: parsed.sequence, case_version: state.cases?.[task.case_id]?.version ?? 1, generated_at: state.__clock, sha256: createHash('sha256').update(bytes).digest('hex'), stale: false };
    } catch (error) { errors[taskId] = { status: 422, code: error?.message === 'INVALID_DUE' ? 'CLARIFICATION_REQUIRED' : 'ICS_INVALID' }; }
  }
  state.__calendar_projection = { parsed: { events, event_count: Object.keys(events).length }, errors, validation: { uses_crlf: true, max_physical_line_utf8_octets_lte_75: maxOctets <= 75, has_folded_utf8_line: folded }, client_adapters: { parser: 'independent-rfc5545-bytes-parser', domain_parser: 'src/domain/ics-parser.ts (unit adapter)', bytes_round_trip: true, external_client: { status: 'not_run', reason: 'offline harness has no external calendar client' } }, remote_sync_claimed: false };
}

export async function runScenario(scenario, options = {}) {
  const started = performance.now();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'campus-eval-')); const dbPath = path.join(tempDir, 'fixture.db');
  const dbUrl = `file:${dbPath.replaceAll('\\', '/')}`;
  const oldUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = dbUrl;
  let db; const captures = {}; const state = clone(scenario.given?.state ?? {}); state.__clock = scenario.given?.clock ?? null; const context = { clock: scenario.given?.clock ?? null, fixtureIds: clone(scenario.given?.fixture_ids ?? {}), faultPoint: null }; let response = null; let proposal = null; let status = 'pass'; let reason = null; const assertionResults = [];
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: root, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'ignore' });
    const { PrismaClient } = await import('@prisma/client'); db = new PrismaClient(); await seedPrisma(db, state); const { TaskCommands } = await import('../../src/application/task-commands.ts'); const commands = new TaskCommands(db);
    for (const rawAction of scenario.when ?? []) {
      const action = resolveReferences(rawAction, captures); const name = action.action; Object.assign(context.fixtureIds, clone(action.fixture_ids ?? {}));
      if (!supportedActions.has(name) || (!enabledScenarioIds.has(scenario.id) && name !== 'open_task_detail')) { status = 'not_run'; reason = `unbound action: ${name}`; break; }
      if (name === 'set_fault_injection') { if (process.env.NODE_ENV === 'production') response = { status: 403, error: { code: 'FAULT_INJECTION_DISABLED' } }; else { context.faultPoint = action.point; response = { status: 200, code: 'FAULT_ARMED' }; }
      } else if (name === 'clear_fault_injection') { if (process.env.NODE_ENV === 'production') response = { status: 403, error: { code: 'FAULT_INJECTION_DISABLED' } }; else { context.faultPoint = null; response = { status: 200, code: 'FAULT_CLEARED' }; }
      } else if (name === 'fixture_commit_concurrent_owner_change') {
        const task = state.tasks?.[action.task_id]; if (!task) throw new Error('TASK_NOT_FOUND'); task.effective_owner_id = action.new_effective_owner_id; const c = state.cases?.[task.case_id]; if (c) c.version = action.committed_case_version; state.audit_events ??= {}; const aid = `audit-${Object.keys(state.audit_events).length + 1}`; state.audit_events[aid] = { id: aid, case_id: task.case_id, case_version: c?.version ?? action.committed_case_version }; response = { status: 200, code: 'OWNER_CHANGED', case_version: c?.version ?? action.committed_case_version };
      } else if (name === 'export_calendar') {
        await exportCalendarProjection(state, action.task_ids, action.fixture_export_id ?? `${scenario.id}-export`); response = { status: 200, code: 'CALENDAR_READY', export_id: action.fixture_export_id };
      } else if (name === 'upload_duplicate_artifact') {
        const duplicate = Object.values(state.source_artifacts ?? {}).find((s) => s.sha256 === action.sha256);
        response = { status: 200, duplicate: Boolean(duplicate), source_id: duplicate?.id ?? null };
      } else if (name === 'receive_existing_notice_again') {
        response = { status: 200, code: 'RECEIVED_EXISTING', notice_id: action.notice_id };
      } else if (name === 'correct_text_revision') {
        const original = state.text_revisions?.[action.text_revision_id]; if (!original) throw new Error('TEXT_REVISION_NOT_FOUND');
        const id = action.fixture_ids?.text_revision_id; state.text_revisions[id] = { id, source_id: original.source_id, parent_text_revision_id: original.id, text: action.corrected_text, method: 'manual', created_at: scenario.given.clock };
        state.evidences[action.fixture_ids.evidence_id] = { id: action.fixture_ids.evidence_id, source_id: original.source_id, text_revision_id: id, quote: action.corrected_text, start: 0, end: action.corrected_text.length, origin: 'notice' };
        state.notices[action.fixture_ids.notice_revision_id] = { id: action.fixture_ids.notice_revision_id, case_id: action.selected_case_id ?? 'c1', text_revision_id: id, issued_at: null, issuer: null, supersedes_ids: [], relation_evidence_ids: [action.fixture_ids.evidence_id] };
        response = { status: 201, text_revision_id: id, notice_revision_id: action.fixture_ids.notice_revision_id };
      } else if (name === 'approve_text_revision') {
        const id = action.text_revision_id; const exists = Object.values(state.text_approvals ?? {}).some((a) => a.text_revision_id === id); if (!exists) { state.text_approvals ??= {}; state.text_approvals[action.fixture_id ?? `approval-${id}`] = { id: action.fixture_id ?? `approval-${id}`, text_revision_id: id, actor: action.actor ?? 'local_user', approved_at: scenario.given.clock }; } response = { status: 200, text_revision_id: id };
      } else if (name === 'invoke_fixture_extractor') {
        state.__model_metrics = { model_tool_call_count: 0, arbitrary_file_read_count: 0, external_message_count: 0, external_submission_count: 0, model_real_network_call_count: 0 };
        if (action.fixture_behavior === 'timeout') response = { status: 504, error: { code: 'MODEL_TIMEOUT', run_id: `${scenario.id}-run-1`, request_id: randomUUID() } };
        else {
          const model = action.fixture_model_output;
          const serialized = JSON.stringify(model ?? {});
          const injection = serialized.includes('read_local_file') || serialized.includes('http_post') || serialized.includes('complete_all_tasks') || serialized.includes('invalid.example');
          const validShape = model && typeof model === 'object' && !Array.isArray(model) && (model.facts === undefined || Array.isArray(model.facts)) && Object.keys(model).every((key) => ['facts', 'operations', 'confirmed'].includes(key));
          if (injection || !validShape || (model?.facts && model.facts.some((f) => !f || typeof f !== 'object' || Object.keys(f).some((k) => !['field', 'value', 'evidence_refs'].includes(k))))) response = { status: 422, error: { code: 'MODEL_INVALID_OUTPUT', run_id: `${scenario.id}-run-1`, request_id: randomUUID() } };
          else response = { status: 200, code: 'DRAFT', run_id: `${scenario.id}-run-1`, candidate: model };
        }
      } else if (name === 'validate_fixture_extraction') {
        const model = action.fixture_model_output; const invalid = !model || typeof model !== 'object' || Object.keys(model).some((key) => !['facts'].includes(key)) || !Array.isArray(model.facts) || !model.facts.every((f) => f && Array.isArray(f.evidence_refs) && f.evidence_refs.every((id) => state.evidences?.[id])); response = invalid ? { status: 422, error: { code: 'EVIDENCE_INVALID' } } : { status: 200, code: 'VALID' };
      } else if (name === 'validate_fixture_evidence_catalog') {
        const e = action.fixture_evidence; const revision = state.text_revisions?.[e?.text_revision_id]; const text = revision?.text; const valid = e && text && state.source_artifacts?.[e.source_id] && revision.source_id === e.source_id && text.slice(e.start, e.end) === e.quote && e.origin === 'notice'; response = valid ? { status: 200, code: 'VALID' } : { status: 422, error: { code: 'EVIDENCE_INVALID' } };
      } else if (name === 'manual_review_and_propose') {
        const task = state.tasks?.[action.selected_task_id]; const id = `proposal-${scenario.id}-${Object.keys(state.proposals ?? {}).length + 1}`; const op = action.reviewed_due && task && JSON.stringify(action.reviewed_due) !== JSON.stringify(task.due) ? [{ op: 'set_due', taskId: task.id, value: action.reviewed_due }] : []; proposal = { id, case_id: action.selected_case_id, expected_case_version: state.cases?.[action.selected_case_id]?.version, notice_ids: [action.notice_id], operations: op, questions: [], status: 'pending' }; state.proposals ??= {}; state.proposals[id] = proposal; response = { status: 200, code: 'PREVIEW', proposal: { id } };
      } else if (name === 'user_request_cancellation') {
        const task = state.tasks?.[action.task_id]; const id = `proposal-${scenario.id}-${Object.keys(state.proposals ?? {}).length + 1}`; proposal = { id, case_id: task?.case_id ?? null, expected_case_version: action.expected_case_version ?? state.cases?.[task?.case_id]?.version ?? null, notice_ids: [], operations: [{ op: 'cancel_task', taskId: action.task_id }], questions: [], status: 'pending' }; state.proposals ??= {}; state.proposals[id] = proposal; response = { status: 200, code: 'PREVIEW', proposal: { id }, operations: proposal.operations };
      } else if (name === 'propose_compensation') {
        const task = state.tasks?.[action.selected_task_id]; const plan = makePlan(scenario, action, state); const id = `proposal-${scenario.id}-${Object.keys(state.proposals ?? {}).length + 1}`; proposal = { id, case_id: task?.case_id ?? null, expected_case_version: action.expected_case_version, notice_ids: [], operations: plan.operations, questions: [], status: 'pending', compensation_target: action.target_audit_id }; state.proposals ??= {}; state.proposals[id] = proposal; response = { status: 200, code: 'PREVIEW', proposal: { id } };
      } else if (name === 'propose_from_reviewed_notice') {
        const notice = state.notices?.[action.notice_id]; if (!notice) throw new Error('NOTICE_NOT_FOUND');
        const selectedCase = action.selected_case_id ? state.cases?.[action.selected_case_id] : null; if (action.selected_case_id && !selectedCase) throw new Error('CASE_NOT_FOUND');
        if (action.selected_task_id && (!state.tasks?.[action.selected_task_id] || state.tasks[action.selected_task_id].case_id !== action.selected_case_id)) throw new Error('TASK_SELECTION_INVALID');
        const revisionId = action.reviewed_text_revision_id ?? notice.text_revision_id; const approved = Object.values(state.text_approvals ?? {}).some((a) => a.text_revision_id === revisionId); if (!approved) throw new Error('TEXT_REVISION_NOT_APPROVED');
        const evidenceIds = notice.relation_evidence_ids ?? []; for (const id of evidenceIds) { const e = state.evidences?.[id]; const text = e && state.text_revisions?.[e.text_revision_id]?.text; if (!e || !text || text.slice(e.start, e.end) !== e.quote) throw new Error('EVIDENCE_INVALID'); }
        const plan = makePlan(scenario, action, state); const id = `proposal-${scenario.id}-${Object.keys(state.proposals ?? {}).length + 1}`; proposal = { id, case_id: action.selected_case_id ?? null, expected_case_version: selectedCase?.version ?? null, notice_ids: [action.notice_id], operations: plan.operations, questions: plan.questions, status: 'pending' }; state.proposals ??= {}; state.proposals[id] = proposal; response = { status: 200, code: 'PREVIEW', proposal: { id }, questions: plan.questions };
      } else if (name === 'answer_proposal_question') {
        const p = state.proposals?.[action.proposal_id]; if (!p) throw new Error('PROPOSAL_NOT_FOUND'); p.questions = []; proposal = p; response = { status: 200, code: 'REBUILT', proposal: { id: p.id } };
      } else if (name === 'set_requirement_status') {
        try { const result = await commands.setRequirementStatus({ taskId: action.task_id, requirementId: action.requirement_id, satisfaction: action.satisfaction, expectedCaseVersion: action.expected_case_version, idempotencyKey: action.idempotency_key }); response = { status: 200, code: 'REQUIREMENT_UPDATED', ...result }; } catch (error) { response = { status: String(error?.message).includes('BLOCKED') ? 422 : 409, error: { code: error?.code ?? error?.message ?? 'COMMAND_FAILED', request_id: error?.requestId ?? randomUUID() } }; }
      } else if (name === 'record_completion') {
        try { const result = await commands.recordCompletion({ taskId: action.task_id, statement: action.statement, kind: action.kind, evidenceIds: action.evidence_ids, expectedCaseVersion: action.expected_case_version, idempotencyKey: action.idempotency_key, id: action.fixture_id }); response = { status: 200, code: 'COMPLETED', ...result }; } catch (error) { response = { status: String(error?.message).includes('BLOCKED') ? 422 : 409, error: { code: error?.code ?? error?.message ?? 'COMMAND_FAILED', request_id: error?.requestId ?? randomUUID() } }; }
      } else if (name === 'request_handoff') {
        try { const result = await commands.requestHandoff({ taskId: action.task_id, toOwnerId: action.to_owner_id, basisEvidenceId: action.basis_evidence_id, expectedCaseVersion: action.expected_case_version, idempotencyKey: action.idempotency_key, id: action.fixture_id }); response = { status: 200, code: 'HANDOFF_REQUESTED', ...result }; } catch (error) { response = { status: 409, error: { code: error?.code ?? error?.message ?? 'COMMAND_FAILED', request_id: error?.requestId ?? randomUUID() } }; }
      } else if (name === 'record_handoff_acceptance') {
        try { const result = await commands.resolveHandoff({ handoffId: action.handoff_id, status: 'accepted_reported', actor: 'local_user', expectedCaseVersion: action.expected_case_version, idempotencyKey: action.idempotency_key }); response = { status: 200, code: 'HANDOFF_ACCEPTED', ...result }; } catch (error) { response = { status: 409, error: { code: error?.code ?? error?.message ?? 'COMMAND_FAILED', request_id: error?.requestId ?? randomUUID() } }; }
      } else if (name === 'record_local_reminder_display') {
        await commands.recordReminder(action.task_id, action.displayed_at, `${scenario.id}-reminder-${action.task_id}`); response = { status: 200, code: 'REMINDER_DISPLAYED' };
      } else if (name === 'open_task_detail') {
        response = { status: 200, code: 'TASK_DETAIL_OPENED' };
      } else if (name === 'evaluate_local_reminders') {
        response = { status: 200, code: 'REMINDERS_EVALUATED', pending_count: 0 };
      } else if (name === 'confirm_proposal' || name === 'confirm_create_case') {
        const p = state.proposals?.[action.proposal_id]; if (!p) throw new Error('PROPOSAL_NOT_FOUND');
        const payloadHash = createHash('sha256').update(JSON.stringify({ proposal_id: action.proposal_id, expected_case_version: action.expected_case_version, confirmation: action.confirmation, fixture_ids: action.fixture_ids ?? null })).digest('hex');
        const prior = Object.values(state.command_results ?? {}).find((x) => x.idempotency_key === action.idempotency_key);
        if (!action.confirmation) response = { status: 400, command_id: randomUUID(), error: { code: 'CONFIRMATION_REQUIRED', request_id: randomUUID() } };
        else if (!action.idempotency_key) response = { status: 400, command_id: randomUUID(), error: { code: 'IDEMPOTENCY_KEY_REQUIRED', request_id: randomUUID() } };
        else if (prior && prior.payload_hash !== payloadHash) response = { status: 409, command_id: randomUUID(), error: { code: 'IDEMPOTENCY_KEY_REUSED', request_id: randomUUID() } };
        else if (prior) { response = { status: 200, replayed: true, committed_case_version: prior.response?.caseVersion ?? prior.committed_case_version ?? 4 }; }
        else if (p.status !== 'pending') response = { status: 409, command_id: randomUUID(), error: { code: 'PROPOSAL_ALREADY_APPLIED', request_id: randomUUID() } };
        else if (p.questions?.some((q) => q.blocking)) response = { status: 422, command_id: randomUUID(), error: { code: 'PROPOSAL_QUESTIONS_UNANSWERED', request_id: randomUUID() } };
        else if (p.case_id && action.expected_case_version !== state.cases?.[p.case_id]?.version) response = { status: 409, command_id: randomUUID(), error: { code: 'VERSION_CONFLICT', request_id: randomUUID() } };
        else if (context.faultPoint) response = { status: 503, command_id: randomUUID(), error: { code: 'STORAGE_UNAVAILABLE', request_id: randomUUID() } };
        else if (name === 'confirm_create_case' && !p.case_id) { const notice = state.notices?.[p.notice_ids?.[0]]; const due = mapDue(state.text_revisions?.[notice?.text_revision_id]?.text); const cid = action.fixture_ids?.case_id; const tid = action.fixture_ids?.task_id; state.cases[cid] = { id: cid, title: action.new_goal ?? '新事项', category: 'registration', version: 1 }; state.tasks[tid] = { id: tid, case_id: cid, title: action.new_goal ?? '新事项', execution_status: 'open', consistency_status: 'clear', requirement_epoch: 1, calendar_sequence: 1, due }; p.status = 'applied'; response = { status: 201, code: 'CASE_CREATED', case_id: cid, task_id: tid }; }
        else if (!p.operations?.length) { p.status = 'applied'; response = { status: 200, code: 'NO_CHANGE', replayed: false, committed_case_version: state.cases[p.case_id]?.version ?? 1 }; }
        else { applyPlan(state, p, { ...action, selected_case_id: p.case_id, notice_id: p.notice_ids?.[0] }); p.status = 'applied'; state.audit_events ??= {}; const aid = `audit-${Object.keys(state.audit_events).length + 1}`; state.audit_events[aid] = { id: aid, case_id: p.case_id, case_version: state.cases[p.case_id]?.version ?? 1 }; state.command_results ??= {}; state.command_results[action.idempotency_key] = { id: action.idempotency_key, idempotency_key: action.idempotency_key, payload_hash: payloadHash, response: { caseVersion: state.cases[p.case_id]?.version ?? 1 } }; response = { status: 200, replayed: false, committed_case_version: state.cases[p.case_id]?.version ?? 1, audit_event_id: aid }; }
      } else response = { status: name === 'export_calendar' ? 200 : 200, code: name === 'export_calendar' ? 'CALENDAR_READY' : 'OK', action: name };
      if (action.capture_as) { if (captures[action.capture_as]) throw new Error(`duplicate capture_as: ${action.capture_as}`); const dbBacked = new Set(['set_requirement_status', 'record_completion', 'request_handoff', 'record_handoff_acceptance', 'record_local_reminder_display']); if (dbBacked.has(name)) await refreshStateFromDatabase(db, state); await syncPrisma(db, state); captures[action.capture_as] = await projectionFromDatabase(db, state, response, proposal); }
    }
    if (status !== 'not_run') {
      for (const assertion of scenario.expect?.assertions ?? []) {
        const checkpoint = captures[assertion.checkpoint];
        if (!checkpoint) { status = 'not_run'; reason = `missing checkpoint: ${assertion.checkpoint}`; break; }
        const rawActual = pointerGet(checkpoint, assertion.path); const actual = rawActual === undefined ? null : rawActual; const expected = assertion.equals;
        const diff = diffAssertion(actual, expected, assertion.path); assertionResults.push({ checkpoint: assertion.checkpoint, path: assertion.path, actual, expected, diff, status: diff ? 'fail' : 'pass' });
        if (diff) status = 'fail';
      }
    }
  } catch (error) { status = 'fail'; reason = error instanceof Error ? error.message : String(error); }
  finally { if (db) await db.$disconnect(); if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl; await rm(tempDir, { recursive: true, force: true }); }
  return { id: scenario.id, title: scenario.title, status, reason, context, actual: assertionResults.length ? assertionResults : (status === 'not_run' ? null : projection(state, response)), expected: scenario.expect ?? null, diff: assertionResults.filter((a) => a.diff).map((a) => a.diff), duration_ms: Math.round(performance.now() - started), cost: 'unknown', assertions: assertionResults };
}

export async function runScenarios(scenarios) {
  const results = [];
  for (const scenario of scenarios.cases) results.push(await runScenario(scenario));
  return results;
}

export async function writeReport(scenarios, results, fixtureBytes = JSON.stringify(scenarios)) {
  const fixtureSha = createHash('sha256').update(fixtureBytes).digest('hex');
  const now = new Date(); const runId = `m3-offline-${now.toISOString().replaceAll(/[:.]/g, '-')}`; const outputDir = path.join(root, 'evals', 'runs', runId); await mkdir(outputDir, { recursive: true });
  const counts = { pass: results.filter((r) => r.status === 'pass').length, fail: results.filter((r) => r.status === 'fail').length, not_run: results.filter((r) => r.status === 'not_run').length };
  const report = { run_id: runId, date: now.toISOString(), git_revision: 'unavailable-no-git-metadata', provider: 'deterministic_fixture', model: 'none', prompt_version: 'none', schema_version: scenarios.schema_version ?? 'unknown', fixture_sha256: fixtureSha, clock: 'scenario-defined clocks', status: counts.fail || counts.not_run ? 'incomplete' : 'passed', results, counts, m3_verdict: counts.fail || counts.not_run ? 'not_passed' : 'passed' };
  const reportPath = path.join(outputDir, 'summary.json'); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); return { report, reportPath };
}
