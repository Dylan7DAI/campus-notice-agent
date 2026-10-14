// Read-only evaluation helpers. No provider, database or environment access.
export const EVALUATOR_VERSION = 'm4-sequence.4';
const factFields = ['title', 'category', 'due', 'requirement_add', 'location'];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalize = (value) => String(value ?? '').replaceAll('_', ' ').replaceAll(/\s+/g, ' ').trim().toUpperCase();

export function catalog(text) {
  const result = [];
  const re = /[^\n。！？!?]+(?:[。！？!?]|$)|[^\n]+/gu;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[0].trim()) result.push({ id: `seg-${result.length + 1}`, start: match.index, end: match.index + match[0].length, quote: match[0] });
  }
  return result;
}

export function planRevisions(item, repeat, mode) {
  if (item.sequence_length !== 2 || item.image_paths.length !== 2) throw new Error('UNSUPPORTED_SEQUENCE_LABELS');
  // Frozen corpus generator: v2 repeats v1's facts and appends UPDATE VERSION 2.
  // These are evaluation expectations, never a confirmed database snapshot.
  const indices = mode === 'initial_to_update' ? [0, 1] : [1];
  return indices.map((index) => ({
    revision_index: index + 1,
    image_path: item.image_paths[index],
    text_revision_id: `${item.id}-r${repeat}-v${index + 1}`,
    expected: {
      ...item.gold,
      relation: { kind: mode === 'initial_to_update' && index > 0 ? 'update' : 'new', target_case_id: mode === 'initial_to_update' && index > 0 ? `eval-${item.id}` : null },
      relation_marker: mode === 'initial_to_update' && index > 0 ? 'UPDATE VERSION 2' : null,
    },
  }));
}

export function candidateIssues(candidate, revisionId) {
  const issues = [];
  const issue = (path, code) => issues.push({ path, code });
  function shape(value, keys, at) {
    if (!object(value)) { issue(at, 'object_required'); return false; }
    for (const key of keys) if (!Object.hasOwn(value, key)) issue(`${at}/${key}`, 'required');
    // Unknown key names are model data and can contain notice text.
    for (const key of Object.keys(value)) if (!keys.includes(key)) issue(at, 'additional_property');
    return true;
  }
  function refs(value, at, minimum = 0) {
    if (!Array.isArray(value) || value.length < minimum || !value.every(nonempty)) issue(at, 'evidence_refs_required');
  }
  function due(value, at) {
    if (!object(value)) { issue(at, 'due_object_required'); return; }
    const keys = value.kind === 'date' ? ['kind', 'date', 'timezone', 'boundary', 'raw'] : value.kind === 'instant' ? ['kind', 'at', 'timezone', 'raw'] : ['kind', 'raw'];
    shape(value, keys, at);
    if (!['date', 'instant', 'unknown'].includes(value.kind)) issue(`${at}/kind`, 'due_kind_invalid');
    if (!nonempty(value.raw)) issue(`${at}/raw`, 'raw_required');
    if (value.kind === 'date') {
      const parsed = new Date(`${value.date}T00:00:00.000Z`);
      if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.date) issue(`${at}/date`, 'date_invalid');
      if (!['inclusive', 'exclusive', 'unspecified'].includes(value.boundary)) issue(`${at}/boundary`, 'boundary_invalid');
    }
    if (value.kind === 'instant' && (typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.at) || Number.isNaN(Date.parse(value.at)))) issue(`${at}/at`, 'instant_invalid');
    if (value.kind === 'date' || value.kind === 'instant') {
      if (!nonempty(value.timezone) || !['UTC', 'Etc/UTC', ...Intl.supportedValuesOf('timeZone')].includes(value.timezone)) issue(`${at}/timezone`, 'timezone_invalid');
    }
  }
  if (!shape(candidate, ['schema_version', 'text_revision_id', 'relation', 'facts', 'questions'], '')) return issues;
  if (candidate.schema_version !== '1.0') issue('/schema_version', 'schema_version_invalid');
  if (candidate.text_revision_id !== revisionId) issue('/text_revision_id', 'revision_mismatch');
  if (shape(candidate.relation, ['kind', 'target_case_id', 'evidence_refs'], '/relation')) {
    const relation = candidate.relation;
    if (!['new', 'update', 'unknown'].includes(relation.kind)) issue('/relation/kind', 'relation_kind_invalid');
    if (relation.kind === 'update' ? !nonempty(relation.target_case_id) : relation.target_case_id !== null) issue('/relation/target_case_id', 'target_invalid');
    refs(relation.evidence_refs, '/relation/evidence_refs');
  }
  const ids = new Set();
  if (!Array.isArray(candidate.facts)) issue('/facts', 'array_required');
  else {
    if (candidate.facts.length > 5) issue('/facts', 'runtime_fact_limit');
    candidate.facts.forEach((fact, index) => {
      const at = `/facts/${index}`;
      if (!shape(fact, ['id', 'field', 'value', 'evidence_refs'], at)) return;
      if (!nonempty(fact.id) || ids.has(fact.id)) issue(`${at}/id`, 'fact_id_invalid');
      ids.add(fact.id);
      refs(fact.evidence_refs, `${at}/evidence_refs`, 1);
      if (!['title', 'category', 'due', 'requirement_add', 'requirement_remove', 'location', 'cancellation', 'owner_hint'].includes(fact.field)) issue(`${at}/field`, 'field_invalid');
      else if (fact.field === 'due') due(fact.value, `${at}/value`);
      else if (fact.field === 'category' ? !['registration', 'submission', 'event_change'].includes(fact.value) : fact.field === 'cancellation' ? typeof fact.value !== 'boolean' : !nonempty(fact.value)) issue(`${at}/value`, 'value_invalid');
    });
  }
  if (!Array.isArray(candidate.questions)) issue('/questions', 'array_required');
  else candidate.questions.forEach((question, index) => {
    const at = `/questions/${index}`;
    if (!shape(question, ['id', 'field', 'prompt', 'blocking'], at)) return;
    for (const key of ['id', 'field', 'prompt']) if (!nonempty(question[key])) issue(`${at}/${key}`, 'string_required');
    if (typeof question.blocking !== 'boolean') issue(`${at}/blocking`, 'boolean_required');
  });
  return issues;
}

export function evaluateCandidate(candidate, catalogItems, expected) {
  const fact = (field) => candidate.facts.filter((entry) => entry.field === field);
  const value = (field) => fact(field).length === 1 ? fact(field)[0].value : null;
  const due = value('due');
  const actual = {
    title: value('title'), category: value('category'),
    due_date: due?.kind === 'date' ? due.date : due?.kind === 'instant' ? String(due.at).slice(0, 10) : null,
    due_status: due?.kind ?? 'missing', due_timezone: due?.timezone ?? null, due_boundary: due?.boundary ?? null,
    requirement: value('requirement_add'), location: value('location'),
    needs_clarification: candidate.questions.some((question) => question.blocking),
    relation: { kind: candidate.relation.kind, target_case_id: candidate.relation.target_case_id },
    model_fact_fields: candidate.facts.map((entry) => entry.field),
  };
  const checks = {
    title: actual.title === expected.title, category: actual.category === expected.category,
    due_date: expected.due_date === null ? actual.due_status === 'unknown' : actual.due_status === 'date' && actual.due_date === expected.due_date && actual.due_timezone === 'Asia/Shanghai' && actual.due_boundary === 'inclusive',
    requirement: actual.requirement === expected.requirement, location: actual.location === expected.location,
  };
  const quotes = (refs) => refs.every((ref) => catalogItems.some((entry) => entry.id === ref)) ? refs.map((ref) => catalogItems.find((entry) => entry.id === ref).quote).join(' ') : '';
  const evidence = factFields.map((field) => {
    if (fact(field).length !== 1) return false;
    const entry = fact(field)[0];
    const quote = normalize(quotes(entry.evidence_refs));
    if (field !== 'due') return quote.includes(normalize(entry.value)) && normalize(entry.value).length > 0;
    return nonempty(due?.raw) && quote.includes(normalize(due.raw)) && (due.kind === 'unknown'
      ? quote.includes('TBD')
      : due.kind === 'date' && quote.includes(due.date) && quote.includes(normalize(due.timezone)) && quote.includes(normalize(due.boundary)));
  });
  const relationQuote = normalize(quotes(candidate.relation.evidence_refs));
  const relationRefsKnown = candidate.relation.evidence_refs.every((ref) => catalogItems.some((entry) => entry.id === ref));
  const relationEvidenceCorrect = relationRefsKnown && (!expected.relation_marker || relationQuote.includes(normalize(expected.relation_marker)));
  const relationCorrect = expected.relation ? actual.relation.kind === expected.relation.kind && actual.relation.target_case_id === expected.relation.target_case_id && relationEvidenceCorrect : true;
  const clarificationCorrect = actual.needs_clarification === expected.needs_clarification;
  const diff = Object.keys(checks).filter((field) => !checks[field]).map((field) => ({ path: field, actual: actual[field], expected: expected[field] }));
  evidence.forEach((correct, index) => { if (!correct) diff.push({ path: `evidence/${factFields[index]}`, actual: false, expected: true }); });
  if (!relationCorrect) diff.push({ path: 'relation', actual: { ...actual.relation, evidence_valid: relationEvidenceCorrect }, expected: expected.relation });
  if (!clarificationCorrect) diff.push({ path: 'needs_clarification', actual: actual.needs_clarification, expected: expected.needs_clarification });
  if (candidate.facts.some((entry) => !factFields.includes(entry.field) || fact(entry.field).length !== 1)) diff.push({ path: 'model_fact_fields', actual: actual.model_fact_fields, expected: factFields });
  return { actual, diff, key_fact_correct: Object.values(checks).filter(Boolean).length, evidence_correct: evidence.filter(Boolean).length, relation_correct: relationCorrect, clarification_correct: clarificationCorrect, status: diff.length ? 'fail' : 'pass' };
}

function wilson95(numerator, denominator) {
  if (!denominator) return { low: null, high: null };
  const z = 1.96, p = numerator / denominator, correction = 1 + z * z / denominator;
  const centre = (p + z * z / (2 * denominator)) / correction;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * denominator)) / denominator) / correction;
  return { low: Number(Math.max(0, centre - margin).toFixed(4)), high: Number(Math.min(1, centre + margin).toFixed(4)) };
}

export function summarize(results, cases, repeats) {
  const metric = (numerator, denominator) => ({ numerator, denominator, confidence_interval_95: wilson95(numerator, denominator) });
  const sum = (entries, field) => entries.reduce((count, entry) => count + Number(entry[field] ?? 0), 0);
  const scores = (entries) => ({
    key_fact_correct: metric(sum(entries, 'key_fact_correct'), entries.length * 5),
    evidence_correct: metric(sum(entries, 'evidence_correct'), entries.length * 5),
    relation_correct: metric(sum(entries, 'relation_correct'), entries.length),
    clarification_recall: metric(sum(entries.filter((entry) => entry.expected.needs_clarification), 'clarification_correct'), entries.filter((entry) => entry.expected.needs_clarification).length),
    unnecessary_clarification: metric(entries.filter((entry) => !entry.expected.needs_clarification && entry.actual?.needs_clarification).length, entries.filter((entry) => !entry.expected.needs_clarification).length),
  });
  const allCorrect = cases.filter((item) => {
    const entries = results.filter((entry) => entry.case_id === item.id);
    const required = entries[0]?.sequence_mode === 'latest_revision_only' ? 1 : item.sequence_length;
    return entries.length === repeats * required && entries.every((entry) => entry.status === 'pass');
  }).length;
  const complete = results.length > 0 && results.length === cases.length * repeats * (results[0]?.sequence_mode === 'latest_revision_only' ? 1 : 2);
  const metrics = { ...scores(results), all_repeats_correct_cases: metric(allCorrect, cases.length), false_auto_commit: null };
  return {
    status: complete && results.every((entry) => entry.status === 'pass') ? 'passed' : 'failed', metrics,
    per_repeat: Array.from({ length: repeats }, (_, index) => {
      const entries = results.filter((entry) => entry.repeat === index + 1);
      return { repeat: index + 1, pass: entries.filter((entry) => entry.status === 'pass').length, fail: entries.filter((entry) => entry.status === 'fail').length, not_run: entries.filter((entry) => entry.status === 'not_run').length, metrics: scores(entries) };
    }),
  };
}
