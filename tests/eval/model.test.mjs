import { describe, expect, it } from 'vitest';
import { candidateIssues, catalog, evaluateCandidate, planRevisions, summarize } from '../../scripts/eval-model-core.mjs';
import manifest from '../../evals/model/manifest.json';

const item = manifest.cases.find((entry) => entry.id === 'C26');
const text = 'CAMPUS NOTICE\nITEM 26 SUBMISSION\nDUE DATE 2026-10-27\nTIMEZONE ASIA/SHANGHAI\nBOUNDARY INCLUSIVE\nMATERIAL FORM A\nLOCATION ROOM B';
function candidate(revisionId, update = false) {
  return {
    schema_version: '1.0', text_revision_id: revisionId,
    relation: { kind: update ? 'update' : 'new', target_case_id: update ? 'eval-C26' : null, evidence_refs: [update ? 'seg-8' : 'seg-2'] },
    facts: [
      { id: 'f1', field: 'title', value: item.gold.title, evidence_refs: ['seg-2'] },
      { id: 'f2', field: 'category', value: 'submission', evidence_refs: ['seg-2'] },
      { id: 'f3', field: 'due', value: { kind: 'date', date: '2026-10-27', timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: 'DUE DATE 2026-10-27' }, evidence_refs: ['seg-3', 'seg-4', 'seg-5'] },
      { id: 'f4', field: 'requirement_add', value: 'FORM A', evidence_refs: ['seg-6'] },
      { id: 'f5', field: 'location', value: 'ROOM B', evidence_refs: ['seg-7'] },
    ], questions: [],
  };
}

describe('M4 sequence evaluator boundaries', () => {
  it('plans both frozen revisions in order with new then the same selected update target', () => {
    const steps = planRevisions(item, 2, 'initial_to_update');
    expect(steps.map((step) => step.image_path)).toEqual(item.image_paths);
    expect(steps.map((step) => step.text_revision_id)).toEqual(['C26-r2-v1', 'C26-r2-v2']);
    expect(steps.map((step) => step.expected.relation)).toEqual([{ kind: 'new', target_case_id: null }, { kind: 'update', target_case_id: 'eval-C26' }]);
    expect(planRevisions(item, 2, 'latest_revision_only')).toHaveLength(1);
  });

  it('rejects wrong update targets and marker-free relation evidence despite correct facts', () => {
    const step = planRevisions(item, 1, 'initial_to_update')[1];
    const value = candidate(step.text_revision_id, true);
    const evidence = catalog(`${text}\nUPDATE VERSION 2`);
    expect(evaluateCandidate(value, evidence, step.expected).status).toBe('pass');
    value.relation.target_case_id = 'eval-C25';
    expect(evaluateCandidate(value, evidence, step.expected).diff.some((diff) => diff.path === 'relation')).toBe(true);
    value.relation.target_case_id = 'eval-C26';
    value.relation.evidence_refs = ['seg-2'];
    expect(evaluateCandidate(value, evidence, step.expected).status).toBe('fail');
  });

  it('accepts an initial new relation with empty evidence refs as allowed by the contract', () => {
    const step = planRevisions(item, 1, 'initial_to_update')[0];
    const value = candidate(step.text_revision_id);
    value.relation.evidence_refs = [];
    expect(evaluateCandidate(value, catalog(text), step.expected).status).toBe('pass');
  });

  it('fails closed on extra commands, missing due fields, foreign revisions and duplicate facts', () => {
    const value = candidate('C26-r1-v1');
    expect(candidateIssues(value, 'C26-r1-v1')).toEqual([]);
    value.execution_status = 'completed';
    expect(candidateIssues(value, 'C26-r1-v1')).toContainEqual({ path: '', code: 'additional_property' });
    delete value.execution_status;
    delete value.facts[2].value.boundary;
    expect(candidateIssues(value, 'C26-r1-v1')).toContainEqual({ path: '/facts/2/value/boundary', code: 'required' });
    expect(candidateIssues(value, 'C26-r1-v2')).toContainEqual({ path: '/text_revision_id', code: 'revision_mismatch' });
    value.facts[2].value.boundary = 'inclusive';
    value.facts.push({ ...value.facts[3], id: 'f6' });
    expect(evaluateCandidate(value, catalog(text), item.gold).status).toBe('fail');
  });

  it('does not count a wrong-field or invented citation as correct evidence', () => {
    const value = candidate('C26-r1-v1');
    value.facts[3].evidence_refs = ['seg-7'];
    let result = evaluateCandidate(value, catalog(text), item.gold);
    expect(result.status).toBe('fail');
    expect(result.evidence_correct).toBe(4);
    value.facts[3].evidence_refs = ['seg-999'];
    result = evaluateCandidate(value, catalog(text), item.gold);
    expect(result.evidence_correct).toBe(4);
  });

  it('does not log model-generated unknown property names', () => {
    const value = candidate('C26-r1-v1');
    value.DO_NOT_LOG_SECRET = true;
    const issues = candidateIssues(value, 'C26-r1-v1');
    expect(issues).toContainEqual({ path: '', code: 'additional_property' });
    expect(JSON.stringify(issues)).not.toContain('DO_NOT_LOG_SECRET');
  });

  it('keeps failed and blocked revisions in every denominator and reports each repeat', () => {
    const steps = planRevisions(item, 1, 'initial_to_update');
    const results = steps.map((step, index) => ({ case_id: item.id, repeat: 1, expected: step.expected, status: index ? 'not_run' : 'fail', key_fact_correct: 0, evidence_correct: 0, relation_correct: false, clarification_correct: false }));
    const report = summarize(results, [item], 1);
    expect(report.status).toBe('failed');
    expect(report.metrics.key_fact_correct).toMatchObject({ numerator: 0, denominator: 10 });
    expect(report.metrics.evidence_correct.denominator).toBe(10);
    expect(report.metrics.relation_correct.denominator).toBe(2);
    expect(report.metrics.all_repeats_correct_cases.numerator).toBe(0);
    expect(report.per_repeat[0].not_run).toBe(1);
    expect(summarize([], [], 3).status).toBe('failed');
  });
});
