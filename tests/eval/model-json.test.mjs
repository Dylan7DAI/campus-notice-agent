import { describe, expect, it } from 'vitest';
import { parseModelJson, repairFeedback } from '../../scripts/eval-model-json.mjs';

describe('safe model JSON diagnostics (no response text)', () => {
  it('keeps valid JSON and existing OCR newline normalization behavior', () => {
    expect(parseModelJson('```json\n{"facts":[]}\n```')).toEqual({ facts: [] });
    expect(parseModelJson('{"text":"first\nsecond"}', true)).toEqual({ text: 'first\nsecond' });
    expect(() => parseModelJson('{"text":"first\nsecond"}')).toThrow('MODEL_INVALID_OUTPUT');
  });

  it('reports the malformed position without leaking a provider snippet', () => {
    const text = '{"private":"DO_NOT_LOG_SECRET","facts":[],}';
    let error;
    try { parseModelJson(text); } catch (caught) { error = caught; }
    expect(error.message).toBe('MODEL_INVALID_OUTPUT');
    expect(error.issue).toMatchObject({ path: '', code: 'json_invalid', kind: 'unexpected_structure', position: 42, line: 1, column: 43 });
    expect(JSON.stringify(error)).not.toContain('DO_NOT_LOG_SECRET');
    expect(repairFeedback([error.issue])).toContain('UTF-16 offset 42');
    expect(repairFeedback([error.issue])).not.toContain('DO_NOT_LOG_SECRET');
  });

  it('does not accept an unterminated string or trailing non-JSON prose', () => {
    for (const text of ['{"private":"DO_NOT_LOG_SECRET', '{"facts":[]} extra']) {
      let error;
      try { parseModelJson(text); } catch (caught) { error = caught; }
      expect(error.issue.code).toBe('json_invalid');
      expect(['unterminated_string', 'trailing_content']).toContain(error.issue.kind);
      expect(JSON.stringify(error)).not.toContain('DO_NOT_LOG_SECRET');
    }
  });

  it('does not interpret echoed input as a native parser offset', () => {
    let error;
    try { parseModelJson('position 123'); } catch (caught) { error = caught; }
    expect(error.issue).toMatchObject({ position: null, line: null, column: null });
    expect(repairFeedback([error.issue])).toContain('offset unavailable');
  });
});
