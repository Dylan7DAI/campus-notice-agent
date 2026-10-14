#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ROOT = process.cwd();
const SCHEMA_VERSION = 'm7-pilot.1';
const CONDITIONS = ['A', 'B', 'C'];
const FAILURE_CATEGORIES = new Set(['omission', 'wrong_update', 'proposal_error', 'timeout', 'ux', 'other']);
const DECISIONS = new Set(['continue', 'shrink_scope', 'pause']);

function fail(message) {
  const error = new Error(message);
  error.code = 'M7_INPUT_INVALID';
  throw error;
}

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const separator = item.indexOf('=');
    if (separator < 0) args[item.slice(2)] = true;
    else args[item.slice(2, separator)] = item.slice(separator + 1);
  }
  return args;
}

function outputPath(value, fallback) {
  const path = resolve(ROOT, value ?? fallback);
 if (path !== ROOT && !path.startsWith(ROOT + String.fromCharCode(92)) && !path.startsWith(`${ROOT}/`)) fail('path must stay inside the project directory');
  return path;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
}

function assertId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail(`${label} must be an anonymous ID`);
  if (/^\d{7,15}$/.test(value)) fail(`${label} must not look like a phone number`);
  return value;
}

function assertParticipantId(value, label) {
  const id = assertId(value, label);
  if (!/^p\d{2,3}$/.test(id) && !/^anon-[A-Za-z0-9_-]{2,60}$/.test(id)) fail(`${label} must use an anonymous participant ID format`);
  return id;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean`);
  return value;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function validateInput(input) {
  const root = assertPlainObject(input, 'input');
  assertKeys(root, new Set(['schema_version', 'protocol_version', 'participants', 'sessions', 'observations', 'decision', 'review']), 'input');
  if (root.schema_version !== SCHEMA_VERSION) fail(`input.schema_version must be ${SCHEMA_VERSION}`);
  if (typeof root.protocol_version !== 'string' || root.protocol_version.length === 0 || root.protocol_version.length > 64) fail('input.protocol_version is required');
  if (!Array.isArray(root.participants) || !Array.isArray(root.sessions) || !Array.isArray(root.observations)) fail('participants, sessions and observations must be arrays');

  const participants = new Set();
  for (const [index, participant] of root.participants.entries()) {
    const value = assertPlainObject(participant, `participants[${index}]`);
    assertKeys(value, new Set(['id']), `participants[${index}]`);
    const id = assertParticipantId(value.id, `participants[${index}].id`);
    if (participants.has(id)) fail(`duplicate participant id: ${id}`);
    participants.add(id);
  }

  const sessions = [];
  const sessionIds = new Set();
  const pairConditions = new Map();
  const pairDifficulties = new Map();
  for (const [index, raw] of root.sessions.entries()) {
    const value = assertPlainObject(raw, `sessions[${index}]`);
    assertKeys(value, new Set(['id', 'participant_id', 'pair_id', 'condition', 'case_id', 'difficulty', 'required_items', 'omitted_items', 'wrong_update_count', 'proposal_error_count', 'correction_seconds', 'severe_misunderstanding', 'failure_category', 'completed']), `sessions[${index}]`);
    const id = assertId(value.id, `sessions[${index}].id`);
    if (sessionIds.has(id)) fail(`duplicate session id: ${id}`);
    sessionIds.add(id);
    const participantId = assertParticipantId(value.participant_id, `sessions[${index}].participant_id`);
    if (!participants.has(participantId)) fail(`sessions[${index}] references unknown participant`);
    const pairId = assertId(value.pair_id, `sessions[${index}].pair_id`);
    if (!CONDITIONS.includes(value.condition)) fail(`sessions[${index}].condition must be A, B or C`);
    if (!['easy', 'hard'].includes(value.difficulty)) fail(`sessions[${index}].difficulty must be easy or hard`);
    const caseId = assertId(value.case_id, `sessions[${index}].case_id`);
    const required = assertNonNegativeInteger(value.required_items, `sessions[${index}].required_items`);
    const omitted = assertNonNegativeInteger(value.omitted_items, `sessions[${index}].omitted_items`);
    if (omitted > required) fail(`sessions[${index}].omitted_items cannot exceed required_items`);
    const wrongUpdate = assertNonNegativeInteger(value.wrong_update_count, `sessions[${index}].wrong_update_count`);
    const proposalError = assertNonNegativeInteger(value.proposal_error_count, `sessions[${index}].proposal_error_count`);
    const correctionSeconds = assertNonNegativeInteger(value.correction_seconds, `sessions[${index}].correction_seconds`);
    const severe = assertBoolean(value.severe_misunderstanding, `sessions[${index}].severe_misunderstanding`);
    const completed = assertBoolean(value.completed, `sessions[${index}].completed`);
    if (value.failure_category !== null && !FAILURE_CATEGORIES.has(value.failure_category)) fail(`sessions[${index}].failure_category is invalid`);
    const key = `${participantId}/${pairId}`;
    const conditions = pairConditions.get(key) ?? new Set();
    if (conditions.has(value.condition)) fail(`duplicate condition in pair ${key}`);
    conditions.add(value.condition);
    pairConditions.set(key, conditions);
    const difficulty = pairDifficulties.get(key);
    if (difficulty && difficulty !== value.difficulty) fail(`pair ${key} must use one difficulty across A, B and C`);
    pairDifficulties.set(key, value.difficulty);
    sessions.push({ id, participantId, pairId, condition: value.condition, caseId, difficulty: value.difficulty, required, omitted, wrongUpdate, proposalError, correctionSeconds, severe, completed, failureCategory: value.failure_category });
  }

  for (const [key, conditions] of pairConditions) if (conditions.size !== CONDITIONS.length) fail(`pair ${key} must contain exactly one A, B and C session`);

  const observations = [];
  const observationCodes = new Set();
  for (const [index, raw] of root.observations.entries()) {
    const value = assertPlainObject(raw, `observations[${index}]`);
    assertKeys(value, new Set(['issue_code', 'count']), `observations[${index}]`);
    const issueCode = assertId(value.issue_code, `observations[${index}].issue_code`);
    const count = assertNonNegativeInteger(value.count, `observations[${index}].count`);
    if (count === 0) fail(`observations[${index}].count must be positive`);
    if (observationCodes.has(issueCode)) fail(`duplicate observation issue_code: ${issueCode}`);
    observationCodes.add(issueCode);
    observations.push({ issueCode, count });
  }

  let decision = null;
  if (root.decision !== null) {
    const value = assertPlainObject(root.decision, 'decision');
    assertKeys(value, new Set(['outcome']), 'decision');
    if (!DECISIONS.has(value.outcome)) fail('decision.outcome is invalid');
    decision = value.outcome;
  }
  let timeReview = null;
  if (root.review !== null) {
    const value = assertPlainObject(root.review, 'review');
    assertKeys(value, new Set(['correction_time_acceptable']), 'review');
    timeReview = assertBoolean(value.correction_time_acceptable, 'review.correction_time_acceptable');
  }
  return { participants: [...participants], sessions, observations, decision, timeReview };
}

function groupMetrics(sessions) {
  const requiredItems = sessions.reduce((sum, value) => sum + value.required, 0);
  const omittedItems = sessions.reduce((sum, value) => sum + value.omitted, 0);
  const wrongUpdateSessions = sessions.filter((value) => value.wrongUpdate > 0).length;
  const proposalErrorSessions = sessions.filter((value) => value.proposalError > 0).length;
  return {
    session_count: sessions.length,
    completed_count: sessions.filter((value) => value.completed).length,
    required_item_count: requiredItems,
    omitted_item_count: omittedItems,
    omission_rate: ratio(omittedItems, requiredItems),
    wrong_update_session_count: wrongUpdateSessions,
    wrong_update_rate: ratio(wrongUpdateSessions, sessions.length),
    wrong_update_count: sessions.reduce((sum, value) => sum + value.wrongUpdate, 0),
    proposal_error_session_count: proposalErrorSessions,
    proposal_error_rate: ratio(proposalErrorSessions, sessions.length),
    correction_seconds_median: median(sessions.map((value) => value.correctionSeconds)),
    severe_misunderstanding_count: sessions.filter((value) => value.severe).length,
    failure_categories: Object.fromEntries([...FAILURE_CATEGORIES].map((category) => [category, sessions.filter((value) => value.failureCategory === category).length])),
  };
}

function pairedMetrics(sessions) {
  const pairs = new Map();
  for (const session of sessions) {
    const key = `${session.participantId}/${session.pairId}`;
    const item = pairs.get(key) ?? {};
    item[session.condition] = session;
    pairs.set(key, item);
  }
  const complete = [...pairs.values()].filter((value) => CONDITIONS.every((condition) => value[condition]));
  const deltas = (metric) => complete.map((pair) => metric(pair.C) - metric(pair.B));
  const omissionRate = (value) => value.required === 0 ? 0 : value.omitted / value.required;
  return {
    pair_count: complete.length,
    c_minus_b: {
      omission_rate_mean_delta: mean(deltas((value) => omissionRate(value))),
      wrong_update_count_mean_delta: mean(deltas((value) => value.wrongUpdate)),
      wrong_update_incidence_mean_delta: mean(deltas((value) => value.wrongUpdate > 0 ? 1 : 0)),
      proposal_error_count_mean_delta: mean(deltas((value) => value.proposalError)),
      correction_seconds_mean_delta: mean(deltas((value) => value.correctionSeconds)),
    },
  };
}

function buildReport(input, validated) {
  const byCondition = Object.fromEntries(CONDITIONS.map((condition) => [condition, groupMetrics(validated.sessions.filter((value) => value.condition === condition))]));
  const paired = pairedMetrics(validated.sessions);
  const participantsReady = validated.participants.length >= 8 && validated.participants.length <= 12;
  const completeSessionDesign = validated.participants.every((participantId) => {
    const rows = validated.sessions.filter((value) => value.participantId === participantId);
    return rows.length === 6 && new Set(rows.map((value) => value.pairId)).size === 2;
  });
  const severeZero = validated.sessions.every((value) => !value.severe);
  const omissionDelta = paired.c_minus_b.omission_rate_mean_delta;
  const wrongUpdateDelta = paired.c_minus_b.wrong_update_incidence_mean_delta;
  const atLeastOneErrorImproved = (omissionDelta ?? 0) < 0 || (wrongUpdateDelta ?? 0) < 0;
  const noWorseErrors = (omissionDelta ?? Number.POSITIVE_INFINITY) <= 0 && (wrongUpdateDelta ?? Number.POSITIVE_INFINITY) <= 0;
  const dataComplete = participantsReady && completeSessionDesign && paired.pair_count === validated.participants.length * 2 && validated.observations.length >= 3 && validated.decision !== null && validated.timeReview !== null;
  const gates = {
    participants_8_to_12: participantsReady,
    six_sessions_per_participant: completeSessionDesign,
    complete_abc_pairs: paired.pair_count === validated.participants.length * 2,
    at_least_three_observed_design_issues: validated.observations.length >= 3,
    severe_misunderstanding_zero: severeZero,
    c_not_worse_than_b_on_omissions_and_wrong_updates: noWorseErrors,
    c_improves_at_least_one_error_metric: atLeastOneErrorImproved,
    correction_time_review_recorded: validated.timeReview !== null,
    decision_recorded: validated.decision !== null,
  };
  const status = validated.sessions.length === 0 ? 'not_run' : !dataComplete ? 'incomplete' : Object.values(gates).every(Boolean) && validated.timeReview === true ? 'passed' : 'failed';
  return {
    report_schema_version: 'm7-report.1',
    protocol_version: input.protocol_version,
    status,
    m7_complete: status === 'passed',
    decision: validated.decision,
    gates,
    participants: { count: validated.participants.length, ids_recorded: false },
    sessions: { count: validated.sessions.length, by_condition: byCondition },
    paired_comparison: paired,
    observed_design_issues: validated.observations,
    limitations: [
      '结果只代表本次小规模试点，不能推断普遍优越性。',
      '报告不保存姓名、联系方式、原始通知、自由文本访谈或模型原文。',
      'C 相对 B 的比较依赖固定配对；缺失或重复配对会使报告无效。',
      'M7 通过不替代 M4 模型质量、M5 外部日历客户端或 M6 备份恢复验收。',
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(ROOT, args.input ?? 'evals/m7/pilot.template.json');
  const reportPath = outputPath(args.out, `evals/runs/m7-pilot-${new Date().toISOString().replaceAll(':', '-')}/summary.json`);
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const validated = validateInput(input);
  const report = buildReport(input, validated);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: report.status, output: reportPath, participants: report.participants.count, sessions: report.sessions.count }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  const code = error.code ?? (error instanceof SyntaxError ? 'M7_INPUT_INVALID' : 'M7_REPORT_FAILED');
  console.error(JSON.stringify({ status: 'invalid', code, message: error.message }, null, 2));
  process.exitCode = code === 'M7_INPUT_INVALID' ? 2 : 1;
});
