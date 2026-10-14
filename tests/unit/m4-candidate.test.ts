import { describe, expect, it } from 'vitest';
import { normalizeCandidateDue, parseCandidate } from '../../src/application/notice-candidate';

const base = (overrides: Record<string, unknown> = {}) => ({
  schema_version: '1.0',
  text_revision_id: 'r1',
  relation: { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] },
  facts: [{ id: 'f1', field: 'title', value: 'Item', evidence_refs: ['seg-1'] }],
  questions: [],
  ...overrides,
});

describe('M4 candidate contract', () => {
  it('rejects duplicate fact IDs and update relations without a target', () => {
    expect(() => parseCandidate(JSON.stringify(base({ facts: [base().facts[0], { ...base().facts[0] }] })))).toThrow('MODEL_INVALID_OUTPUT');
    expect(() => parseCandidate(JSON.stringify(base({ relation: { kind: 'update', target_case_id: null, evidence_refs: ['seg-1'] } })))).toThrow('MODEL_INVALID_OUTPUT');
  });

  it('rejects impossible or unbounded due values before task/calendar write', () => {
    expect(normalizeCandidateDue({ kind: 'date', date: '2026-02-30', timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: '2026-02-30' }).error).toBe('INVALID_DUE');
    expect(normalizeCandidateDue({ kind: 'date', date: '2026-09-30', timezone: 'Asia/Shanghai', boundary: 'unspecified', raw: 'before 2026-09-30' }).error).toBe('CLARIFICATION_REQUIRED');
    expect(normalizeCandidateDue({ kind: 'date', date: '2026-09-30', timezone: 'No/Such_Zone', boundary: 'inclusive', raw: '2026-09-30' }).error).toBe('INVALID_DUE');
    expect(normalizeCandidateDue({ kind: 'date', date: '2026-09-30', timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: '2026-09-30' }).due).toEqual({ kind: 'date', value: '2026-09-30', timezone: 'Asia/Shanghai', boundary: 'inclusive' });
  });
});
