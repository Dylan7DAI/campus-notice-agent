#!/usr/bin/env node
// Static specification checks only. This does not run the product, execute
// scenario actions, evaluate models, or implement a JSON Schema validator.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const counts = { requiredFiles: 0, markdownFiles: 0, relativeLinks: 0, schemas: 0, closedObjects: 0, localRefs: 0, examples: 0, scenarios: 0, actions: 0, assertions: 0, evidenceSpans: 0, dueValues: 0, textApprovals: 0 };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const check = (condition, message) => { if (!condition) errors.push(message); return Boolean(condition); };
const relative = (file) => path.relative(root, file).split(path.sep).join('/');

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { errors.push(`${name}: cannot read JSON: ${error.message}`); return null; }
}

function keys(value, required, allowed, label) {
  if (!check(record(value), `${label}: expected an object`)) return false;
  for (const key of required) check(own(value, key), `${label}: missing ${key}`);
  for (const key of Object.keys(value)) check(allowed.includes(key), `${label}: unexpected ${key}`);
  return true;
}

const requiredFiles = [
  'README.md', 'AGENTS.md', '.env.example',
  'docs/01-product.md', 'docs/02-domain.md', 'docs/03-architecture.md',
  'docs/04-contracts.md', 'docs/05-harness.md', 'docs/06-evaluation.md',
  'docs/07-work-plan.md', 'docs/08-sources.md', 'docs/09-decisions.md',
  'docs/progress.md', 'docs/task-template.md',
  'schemas/notice-candidate.schema.json', 'schemas/change-proposal.schema.json',
  'schemas/examples/notice-candidate.json', 'schemas/examples/change-proposal.json',
  'evals/scenarios.json',
];
for (const name of requiredFiles) {
  try { if (check(fs.statSync(path.join(root, name)).isFile(), `${name}: must be a file`)) counts.requiredFiles++; }
  catch { errors.push(`${name}: required file is missing`); }
}
try { check(fs.statSync(path.join(root, 'AGENTS.md')).size < 16 * 1024, 'AGENTS.md: must be smaller than 16 KiB'); }
catch { /* Missing required file is reported above. */ }

function markdownFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.next', 'coverage', 'test-results', 'playwright-report'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) result.push(full);
  }
  return result;
}

function withoutCode(markdown) {
  let fence = null;
  const lines = markdown.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.slice(marker[0].length).trim() === '') fence = null;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    if (/^(?: {4}|\t)/.test(line)) return '';
    return line;
  });
  // Preserve newline positions while ignoring inline code spans as well.
  return lines.join('\n').replace(/(`+)([\s\S]*?)\1/g, (match) => match.replace(/[^\n]/g, ' '));
}

function destination(text, start) {
  let index = start;
  while (/\s/.test(text[index] ?? '') && index < text.length) index++;
  if (text[index] === '<') {
    const end = text.indexOf('>', index + 1);
    return end === -1 ? null : text.slice(index + 1, end);
  }
  let target = '', nesting = 0;
  for (; index < text.length; index++) {
    const char = text[index];
    if (char === '\\' && index + 1 < text.length) { target += text[++index]; continue; }
    if (char === '(') nesting++;
    if (char === ')') { if (nesting === 0) break; nesting--; }
    if (/\s/.test(char) && nesting === 0) break;
    target += char;
  }
  return target;
}

function checkLink(target, file, line) {
  if (target === null) { errors.push(`${relative(file)}:${line}: malformed link destination`); return; }
  if (target === '' || target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target) || path.isAbsolute(target)) return;
  const pathPart = target.split(/[?#]/, 1)[0];
  if (pathPart === '') return;
  let decoded;
  try { decoded = decodeURIComponent(pathPart); }
  catch { errors.push(`${relative(file)}:${line}: invalid URL encoding in ${target}`); return; }
  counts.relativeLinks++;
  check(fs.existsSync(path.resolve(path.dirname(file), decoded)), `${relative(file)}:${line}: missing relative link ${target}`);
}

for (const file of markdownFiles(root)) {
  counts.markdownFiles++;
  const text = withoutCode(fs.readFileSync(file, 'utf8'));
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  const definitions = new Map();
  const normalizeLabel = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(.*)$/gm)) {
    definitions.set(normalizeLabel(match[1]), destination(match[2], 0));
    checkLink(destination(match[2], 0), file, lineAt(match.index));
  }
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(/g)) {
    checkLink(destination(text, match.index + match[0].length), file, lineAt(match.index));
  }
  for (const match of text.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const label = normalizeLabel(match[2] || match[1]);
    check(definitions.has(label), `${relative(file)}:${lineAt(match.index)}: undefined reference link ${label}`);
  }
}

const pointerPattern = /^(?:\/(?:[^~/]|~[01])*)*$/;
function resolvePointer(value, pointer) {
  if (pointer === '') return { found: true, value };
  if (!pointerPattern.test(pointer)) return { found: false };
  for (const token of pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if ((record(value) || Array.isArray(value)) && own(value, token)) value = value[token];
    else return { found: false };
  }
  return { found: true, value };
}

function inspectSchema(node, document, label) {
  if (node === null || typeof node !== 'object') return;
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
    check(node.additionalProperties === false, `${label}: explicit object must set additionalProperties=false`);
    counts.closedObjects++;
  }
  if (own(node, '$ref')) {
    counts.localRefs++;
    if (check(typeof node.$ref === 'string' && node.$ref.startsWith('#'), `${label}: only local fragment $ref is supported in this package`)) {
      try {
        const pointer = decodeURIComponent(node.$ref.slice(1));
        check(resolvePointer(document, pointer).found, `${label}: unresolved local reference ${node.$ref}`);
      } catch { errors.push(`${label}: malformed local reference ${node.$ref}`); }
    }
  }
  for (const [key, child] of Object.entries(node)) inspectSchema(child, document, `${label}/${key}`);
}

const schemas = ['notice-candidate', 'change-proposal'].map((name) => ({ name, value: readJson(`schemas/${name}.schema.json`) }));
for (const { name, value } of schemas) {
  if (!record(value)) continue;
  counts.schemas++;
  check(value.$schema === 'https://json-schema.org/draft/2020-12/schema', `${name}: expected JSON Schema Draft 2020-12`);
  inspectSchema(value, value, name);
  const example = readJson(`schemas/examples/${name}.json`);
  if (!record(example)) { check(false, `${name} example: root must be an object`); continue; }
  counts.examples++;
  if (check(record(value.properties) && Array.isArray(value.required), `${name}: root must declare properties and required`)) {
    keys(example, value.required, Object.keys(value.properties), `${name} example`);
    check(isDeepStrictEqual(Object.keys(example).sort(), Object.keys(value.properties).sort()), `${name} example: root keys must exactly match the schema's root properties`);
  }
  check(example.schema_version === '1.0', `${name} example: schema_version must be 1.0`);
}
for (const definition of ['Due', 'Question']) {
  const left = schemas[0].value?.$defs?.[definition];
  const right = schemas[1].value?.$defs?.[definition];
  check(record(left) && record(right) && isDeepStrictEqual(left, right), `${definition}: shared definitions must exist and be identical in both schemas`);
}

function fixedTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour = '0', offsetMinute = '0'] = match;
  const maximumDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= maximumDay && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59 && Number.isFinite(Date.parse(value));
}

function timezone(value, label) {
  if (!check(nonempty(value), `${label}: timezone must be nonempty`)) return;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); }
  catch { errors.push(`${label}: invalid timezone ${value}`); }
}

// Narrow fixture-domain shape checks, not a general JSON Schema validator.
// Only known-good state and expected Due values call this function. Deliberate
// malformed extractor payloads inside when are intentionally not traversed.
function dueShape(value, label) {
  counts.dueValues++;
  if (!check(record(value), `${label}: Due must be an object`)) return;
  const fields = {
    unknown: ['kind', 'raw'],
    date: ['kind', 'date', 'timezone', 'boundary', 'raw'],
    instant: ['kind', 'at', 'timezone', 'raw'],
  };
  if (!check(own(fields, value.kind), `${label}: invalid Due kind ${value.kind}`)) return;
  keys(value, fields[value.kind], fields[value.kind], label);
  check(typeof value.raw === 'string', `${label}: Due.raw must be a string`);
  if (value.kind === 'unknown') return;
  timezone(value.timezone, label);
  if (value.kind === 'instant') check(fixedTimestamp(value.at), `${label}: Due.at must be a valid timestamp with offset`);
  if (value.kind === 'date') {
    const parsed = typeof value.date === 'string' ? new Date(`${value.date}T00:00:00Z`) : new Date(NaN);
    check(typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.date, `${label}: Due.date must be a valid YYYY-MM-DD date`);
    check(['inclusive', 'exclusive', 'unspecified'].includes(value.boundary), `${label}: invalid date boundary`);
  }
}

const suite = readJson('evals/scenarios.json');
const scenarioKeys = ['id', 'title', 'tags', 'invariants', 'given', 'when', 'expect', 'severity'];
const givenKeys = ['clock', 'timezone', 'model_adapter', 'state', 'fixture_language', 'assertion_projection'];
const stateKeys = ['cases', 'source_artifacts', 'text_revisions', 'text_approvals', 'notices', 'evidences', 'tasks', 'requirements', 'preparations', 'completion_records', 'handoffs', 'owners', 'proposals', 'audit_events', 'command_results', 'calendar_exports', 'reminder_logs', 'conflicts'];
const expectedIds = new Set(Array.from({ length: 24 }, (_, index) => `E${String(index + 1).padStart(2, '0')}`));
const validInvariants = new Set(Array.from({ length: 12 }, (_, index) => `INV-${String(index + 1).padStart(2, '0')}`));
const seenIds = new Set();
const coveredInvariants = new Set();
if (keys(suite, ['schema_version', 'purpose', 'cases'], ['schema_version', 'purpose', 'cases'], 'scenarios')) {
  check(suite.schema_version === '1.0', 'scenarios: schema_version must be 1.0');
  check(nonempty(suite.purpose), 'scenarios: purpose must be a nonempty string');
  check(Array.isArray(suite.cases) && suite.cases.length === 24, 'scenarios: exactly 24 cases are required');
  for (const [index, scenario] of (Array.isArray(suite.cases) ? suite.cases : []).entries()) {
    counts.scenarios++;
    const label = `scenarios[${index}] (${scenario?.id ?? 'missing id'})`;
    if (!keys(scenario, scenarioKeys, scenarioKeys, label)) continue;
    check(expectedIds.has(scenario.id), `${label}: expected ID E01 through E24`);
    check(!seenIds.has(scenario.id), `${label}: duplicate scenario ID`);
    seenIds.add(scenario.id);
    check(nonempty(scenario.title), `${label}: title must be nonempty`);
    check(['critical', 'major'].includes(scenario.severity), `${label}: severity must be critical or major`);
    check(Array.isArray(scenario.tags) && scenario.tags.length > 0 && scenario.tags.every(nonempty), `${label}: tags must be a nonempty string array`);
    check(Array.isArray(scenario.invariants) && scenario.invariants.length > 0, `${label}: invariants must be a nonempty array`);
    const localInvariants = new Set();
    for (const invariant of Array.isArray(scenario.invariants) ? scenario.invariants : []) {
      check(validInvariants.has(invariant), `${label}: unknown invariant ${invariant}`);
      check(!localInvariants.has(invariant), `${label}: duplicate invariant ${invariant}`);
      localInvariants.add(invariant);
      coveredInvariants.add(invariant);
    }

    if (keys(scenario.given, givenKeys, [...givenKeys, 'input_image_visible_text', 'required_test_adapters'], `${label}.given`)) {
      check(fixedTimestamp(scenario.given.clock), `${label}: given.clock must be a fixed valid ISO timestamp with offset`);
      timezone(scenario.given.timezone, `${label}.given`);
      check(scenario.given.model_adapter === 'deterministic_fixture', `${label}: model_adapter must be deterministic_fixture`);
      check(scenario.given.fixture_language === 'scenario-dsl-v1; application-command adapters, not raw HTTP', `${label}: unsupported fixture_language`);
      if (keys(scenario.given.assertion_projection, ['path_format', 'checkpoint_source', 'derived_roots'], ['path_format', 'checkpoint_source', 'derived_roots'], `${label}.given.assertion_projection`)) {
        check(scenario.given.assertion_projection.path_format === 'RFC6901', `${label}: projection must use RFC6901 paths`);
        check(scenario.given.assertion_projection.checkpoint_source === 'when.capture_as', `${label}: checkpoints must come from when.capture_as`);
        check(isDeepStrictEqual(scenario.given.assertion_projection.derived_roots, ['view', 'metrics', 'calendar']), `${label}: unexpected projection derived_roots`);
      }
      if (own(scenario.given, 'input_image_visible_text')) check(nonempty(scenario.given.input_image_visible_text), `${label}: input_image_visible_text must be a nonempty string`);
      if (scenario.id === 'E21') check(own(scenario.given, 'required_test_adapters'), `${label}: E21 must specify real calendar test adapters`);
      if (own(scenario.given, 'required_test_adapters')) {
        check(isDeepStrictEqual(scenario.given.required_test_adapters, {
          ics_encoder: 'real product implementation; no success mock',
          calendar_endpoint: 'real application route with isolated temporary database',
          ics_parser: 'independent RFC5545 parser',
        }), `${label}: required_test_adapters must specify the real encoder/route and independent parser`);
      }
      if (keys(scenario.given.state, stateKeys, [...stateKeys, 'applied_notice_ids'], `${label}.given.state`)) {
        for (const name of stateKeys) check(record(scenario.given.state[name]), `${label}: state.${name} must be an ID-keyed object`);
        const state = scenario.given.state;
        for (const [id, approval] of Object.entries(record(state.text_approvals) ? state.text_approvals : {})) {
          const approvalLabel = `${label}.given.state.text_approvals.${id}`;
          const approvalFields = ['id', 'text_revision_id', 'actor', 'approved_at'];
          if (!keys(approval, approvalFields, approvalFields, approvalLabel)) continue;
          counts.textApprovals++;
          check(nonempty(approval.id) && approval.id === id, `${approvalLabel}: key must match approval.id`);
          check(nonempty(approval.text_revision_id) && record(state.text_revisions) && own(state.text_revisions, approval.text_revision_id), `${approvalLabel}: approved text revision must exist`);
          check(approval.actor === 'local_user', `${approvalLabel}: actor must be local_user`);
          check(fixedTimestamp(approval.approved_at), `${approvalLabel}: approved_at must be a valid fixed timestamp with offset`);
        }
        if (own(state, 'applied_notice_ids')) {
          check(Array.isArray(state.applied_notice_ids) && state.applied_notice_ids.every(nonempty), `${label}: applied_notice_ids must be a string array`);
          for (const id of Array.isArray(state.applied_notice_ids) ? state.applied_notice_ids : []) check(record(state.notices) && own(state.notices, id), `${label}: applied notice ${id} must exist`);
        }
        for (const [id, entry] of Object.entries(record(state.cases) ? state.cases : {})) {
          check(record(entry) && ['registration', 'submission', 'event_change'].includes(entry.category), `${label}: case ${id} has invalid category`);
        }
        for (const [id, task] of Object.entries(record(state.tasks) ? state.tasks : {})) {
          if (!check(record(task), `${label}: task ${id} must be an object`)) continue;
          // Task inherits Case.category in the current entity model. If a
          // projection includes category, it must still use the same enum.
          if (own(task, 'category')) check(['registration', 'submission', 'event_change'].includes(task.category), `${label}: task ${id} has invalid category`);
          dueShape(task.due, `${label}.given.state.tasks.${id}.due`);
        }
        for (const [id, evidence] of Object.entries(record(state.evidences) ? state.evidences : {})) {
          const evidenceLabel = `${label}.given.state.evidences.${id}`;
          if (!keys(evidence, ['id', 'source_id', 'text_revision_id', 'quote', 'start', 'end', 'origin'], ['id', 'source_id', 'text_revision_id', 'quote', 'start', 'end', 'origin', 'bbox'], evidenceLabel)) continue;
          check(evidence.id === id, `${evidenceLabel}: key must match evidence.id`);
          check(['notice', 'user_decision'].includes(evidence.origin), `${evidenceLabel}: invalid origin`);
          const textRevision = record(state.text_revisions) ? state.text_revisions[evidence.text_revision_id] : undefined;
          if (!check(record(textRevision) && typeof textRevision.text === 'string', `${evidenceLabel}: source text revision must exist`)) continue;
          check(record(state.source_artifacts) && own(state.source_artifacts, evidence.source_id), `${evidenceLabel}: source artifact must exist`);
          check(textRevision.source_id === evidence.source_id, `${evidenceLabel}: source_id does not match the text revision`);
          const validSpan = Number.isInteger(evidence.start) && Number.isInteger(evidence.end) && evidence.start >= 0 && evidence.end >= evidence.start && evidence.end <= textRevision.text.length;
          if (check(validSpan, `${evidenceLabel}: span must be a valid UTF-16 half-open interval`)) {
            counts.evidenceSpans++;
            check(typeof evidence.quote === 'string' && evidence.quote === textRevision.text.slice(evidence.start, evidence.end), `${evidenceLabel}: quote does not equal text.slice(start, end)`);
          }
        }
      }
    }

    check(Array.isArray(scenario.when) && scenario.when.length > 0, `${label}: when must contain actions`);
    const captures = new Set();
    for (const [stepIndex, step] of (Array.isArray(scenario.when) ? scenario.when : []).entries()) {
      counts.actions++;
      if (!check(record(step) && nonempty(step.action), `${label}.when[${stepIndex}]: action is required`)) continue;
      if (step.action === 'approve_text_revision') {
        check(nonempty(step.text_revision_id), `${label}.when[${stepIndex}]: approval requires text_revision_id`);
        check(step.actor === 'local_user' && step.confirmation === true, `${label}.when[${stepIndex}]: approval requires an explicit local user confirmation`);
        // The target can be created by a prior correction action, so do not
        // require it to be present in the initial given.state text revisions.
      }
      if (own(step, 'capture_as')) {
        check(nonempty(step.capture_as) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(step.capture_as), `${label}.when[${stepIndex}]: capture_as must be an identifier`);
        check(!captures.has(step.capture_as), `${label}: duplicate capture_as ${step.capture_as}`);
        captures.add(step.capture_as);
      }
    }
    if (keys(scenario.expect, ['assertions'], ['assertions'], `${label}.expect`)) {
      check(Array.isArray(scenario.expect.assertions) && scenario.expect.assertions.length > 0, `${label}: expect.assertions must be nonempty`);
      for (const [assertionIndex, assertion] of (Array.isArray(scenario.expect.assertions) ? scenario.expect.assertions : []).entries()) {
        counts.assertions++;
        const assertionLabel = `${label}.expect.assertions[${assertionIndex}]`;
        if (!keys(assertion, ['checkpoint', 'path', 'equals'], ['checkpoint', 'path', 'equals'], assertionLabel)) continue;
        // Every checkpoint, including one literally named state, must be
        // explicitly captured. No implicit final snapshot is invented here.
        check(captures.has(assertion.checkpoint), `${assertionLabel}: checkpoint ${assertion.checkpoint} has no capture_as`);
        check(typeof assertion.path === 'string' && pointerPattern.test(assertion.path), `${assertionLabel}: path must be an RFC 6901 JSON Pointer`);
        if (typeof assertion.path === 'string' && /^\/state\/tasks\/[^/]+\/due$/.test(assertion.path)) dueShape(assertion.equals, `${assertionLabel}.equals`);
        if (typeof assertion.path === 'string' && /^\/state\/(?:cases|tasks)\/[^/]+\/category$/.test(assertion.path)) check(['registration', 'submission', 'event_change'].includes(assertion.equals), `${assertionLabel}: invalid expected category`);
        // Do not resolve expected paths against given.state: the actions may
        // create records. Running those actions belongs to the product runner.
      }
    }
  }
}
for (const id of expectedIds) check(seenIds.has(id), `scenarios: missing ${id}`);
for (const invariant of validInvariants) check(coveredInvariants.has(invariant), `scenarios: no case covers ${invariant}`);

console.log('SPEC STATIC CHECK ONLY: no application, OCR/model, browser, or scenario execution was performed.');
console.log(JSON.stringify(counts, null, 2));
if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  console.error(`FAILED: ${errors.length} specification error(s).`);
  process.exitCode = 1;
} else {
  console.log('PASS: static specification structure and references only. Full JSON Schema validation and product tests are separate checks.');
}
