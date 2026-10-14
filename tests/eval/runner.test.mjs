import { describe, expect, it } from 'vitest';
import { deepEqual, diffAssertion, pointerGet, resolveReferences, runScenario } from '../../scripts/eval-runner/index.mjs';
import scenarios from '../../evals/scenarios.json';

describe('offline eval runner primitives', () => {
  it('resolves checkpoint references and RFC6901 pointers strictly', () => {
    const captures = { draft: { proposal: { id: 'p/1' } } };
    expect(resolveReferences('$draft.proposal.id', captures)).toBe('p/1');
    expect(pointerGet({ a: { 'b/c': 3 } }, '/a/b~1c')).toBe(3);
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(diffAssertion(1, 2, '/value')).toEqual({ path: '/value', actual: 1, expected: 2 });
  });

  it('marks an unbound action not_run and never pass', async () => {
    const result = await runScenario({ id: 'TEST', title: 'unbound', given: { state: {} }, when: [{ action: 'unknown_action', capture_as: 'x' }], expect: { assertions: [] } });
    expect(result.status).toBe('not_run');
    expect(result.actual).toBeNull();
  });

  it('reports a deliberately wrong assertion as fail', async () => {
    const result = await runScenario({ id: 'TEST-FAIL', title: 'wrong assertion', given: { state: { tasks: { t1: { id: 't1', case_id: 'c1', title: 'task', execution_status: 'open' } } } }, when: [{ action: 'open_task_detail', capture_as: 'final' }], expect: { assertions: [{ checkpoint: 'final', path: '/state/tasks/t1/execution_status', equals: 'completed' }] } });
    expect(result.status).toBe('fail');
    expect(result.assertions[0].actual).toBe('open');
    expect(result.assertions[0].expected).toBe('completed');
    expect(result.assertions[0].diff).toBeTruthy();
  });

  it('closes confirmation, idempotency, rollback, cancellation and compensation scenarios', async () => {
    for (const id of ['E14', 'E15', 'E16', 'E17', 'E23']) {
      const result = await runScenario(scenarios.cases.find((scenario) => scenario.id === id));
      expect(result.status, id).toBe('pass');
    }
  }, 30000);

  it('loads the task command dependency used by preparation scenarios', async () => {
    const result = await runScenario(scenarios.cases.find((scenario) => scenario.id === 'E01'));
    expect(result.reason ?? '').not.toContain('Cannot find module');
  }, 30000);
});
