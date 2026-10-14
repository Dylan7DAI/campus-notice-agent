import { z } from 'zod';

const due = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown'), raw: z.string() }).strict(),
  z.object({ kind: z.literal('date'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timezone: z.string().min(1), boundary: z.enum(['inclusive', 'exclusive', 'unspecified']), raw: z.string() }).strict(),
  z.object({ kind: z.literal('instant'), at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/), timezone: z.string().min(1), raw: z.string() }).strict(),
]);

const common = { id: z.string().min(1), evidence_refs: z.array(z.string().min(1)).min(1) };
const fact = z.object({
  ...common,
  field: z.enum(['title', 'category', 'due', 'requirement_add', 'requirement_remove', 'location', 'cancellation', 'owner_hint']),
  value: z.unknown(),
}).strict().superRefine((value, ctx) => {
  const valid = value.field === 'title' || value.field === 'requirement_add' || value.field === 'requirement_remove' || value.field === 'location' || value.field === 'owner_hint'
    ? typeof value.value === 'string' && value.value.length > 0
    : value.field === 'category'
      ? value.value === 'registration' || value.value === 'submission' || value.value === 'event_change'
      : value.field === 'cancellation'
        ? typeof value.value === 'boolean'
        : value.field === 'due' && due.safeParse(value.value).success;
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'fact value does not match field' });
});

export const noticeCandidateSchema = z.object({
  schema_version: z.literal('1.0'),
  text_revision_id: z.string().min(1),
  relation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('new'), target_case_id: z.null(), evidence_refs: z.array(z.string().min(1)) }).strict(),
    z.object({ kind: z.literal('update'), target_case_id: z.string().min(1), evidence_refs: z.array(z.string().min(1)) }).strict(),
    z.object({ kind: z.literal('unknown'), target_case_id: z.null(), evidence_refs: z.array(z.string().min(1)) }).strict(),
  ]),
  facts: z.array(fact).max(5),
  questions: z.array(z.object({ id: z.string().min(1), field: z.string().min(1), prompt: z.string().min(1), blocking: z.boolean() }).strict()),
}).strict();

export type NoticeCandidate = z.infer<typeof noticeCandidateSchema>;

export function parseCandidate(text: string): NoticeCandidate {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error('MODEL_INVALID_OUTPUT'); }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { facts?: unknown }).facts)) {
    for (const item of (parsed as { facts: Array<{ field?: string; value?: unknown }> }).facts) {
      if (item.field === 'due' && item.value === 'unknown') item.value = { kind: 'unknown', raw: 'unknown' };
    }
  }
  const result = noticeCandidateSchema.safeParse(parsed);
  if (!result.success) throw new Error('MODEL_INVALID_OUTPUT');
  const ids = new Set<string>();
  for (const item of result.data.facts) {
    if (ids.has(item.id)) throw new Error('MODEL_INVALID_OUTPUT');
    ids.add(item.id);
  }
  return result.data;
}

export function evidenceCatalog(text: string) {
  const result: Array<{ id: string; start: number; end: number; quote: string }> = [];
  const re = /[^\n。！？!?]+(?:[。！？!?]|$)|[^\n]+/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const quote = match[0];
    if (!quote.trim()) continue;
    result.push({ id: `seg-${result.length + 1}`, start: match.index, end: match.index + quote.length, quote });
  }
  if (!result.length && text.length) result.push({ id: 'seg-1', start: 0, end: text.length, quote: text });
  return result;
}

export function validateCandidateEvidence(candidate: NoticeCandidate, revisionId: string, catalog: ReturnType<typeof evidenceCatalog>) {
  if (candidate.text_revision_id !== revisionId) throw new Error('EVIDENCE_INVALID');
  const ids = new Set(catalog.map((item) => item.id));
  for (const ref of [...candidate.relation.evidence_refs, ...candidate.facts.flatMap((item) => item.evidence_refs)]) {
    if (!ids.has(ref)) throw new Error('EVIDENCE_INVALID');
  }
}

export type DomainDue =
  | { kind: 'date'; value: string; timezone: string; boundary: 'inclusive' | 'exclusive' }
  | { kind: 'instant'; value: string; timezone: string };

function validIanaTimezone(value: string) {
  if (value === 'UTC' || value === 'Etc/UTC') return true;
  try { return Intl.supportedValuesOf('timeZone').includes(value); } catch { return false; }
}

function validCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeCandidateDue(value: unknown): { due: DomainDue | null; error?: 'CLARIFICATION_REQUIRED' | 'INVALID_DUE' } {
  if (!value || typeof value !== 'object') return { due: null };
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'unknown') return { due: null };
  if (candidate.kind === 'date') {
    if (candidate.boundary === 'unspecified') return { due: null, error: 'CLARIFICATION_REQUIRED' };
    if (typeof candidate.date !== 'string' || !validCalendarDate(candidate.date) || typeof candidate.timezone !== 'string' || !validIanaTimezone(candidate.timezone) || (candidate.boundary !== 'inclusive' && candidate.boundary !== 'exclusive')) return { due: null, error: 'INVALID_DUE' };
    return { due: { kind: 'date', value: candidate.date, timezone: candidate.timezone, boundary: candidate.boundary } };
  }
  if (candidate.kind === 'instant') {
    if (typeof candidate.at !== 'string' || Number.isNaN(Date.parse(candidate.at)) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(candidate.at) || typeof candidate.timezone !== 'string' || !validIanaTimezone(candidate.timezone)) return { due: null, error: 'INVALID_DUE' };
    return { due: { kind: 'instant', value: candidate.at, timezone: candidate.timezone } };
  }
  return { due: null, error: 'INVALID_DUE' };
}
