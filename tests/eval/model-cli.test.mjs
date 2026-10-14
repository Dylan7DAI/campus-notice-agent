import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '../../evals/model/manifest.json';

const execute = promisify(execFile);
const script = path.resolve('scripts/eval-model.mjs');
const fixture = manifest.cases.find((entry) => entry.id === 'C26');
// This network stub is ONLY for evaluator control-flow tests, never model quality.
async function runCli(providerCode, configured = true, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'campus-m4-eval-test-'));
  try {
    await mkdir(path.join(directory, 'evals/model/assets'), { recursive: true });
    await writeFile(path.join(directory, 'evals/model/manifest.json'), JSON.stringify({ ...manifest, cases: [fixture] }));
    for (const image of fixture.image_paths) await writeFile(path.join(directory, image), await readFile(image));
    const preload = path.join(directory, 'provider.mjs');
    await writeFile(preload, providerCode);
    const extraArgs = options.args ?? [];
    if (options.replayText) {
      const replayPath = path.join(directory, 'replay.json');
      await writeFile(replayPath, JSON.stringify({ schema_version: 'm4-ocr-replay.1', origin: 'actual_provider_ocr', run_id: 'stub-only', case_id: 'C26', revision_index: 1, text: options.replayText, text_sha256: createHash('sha256').update(options.replayText).digest('hex'), image_sha256: createHash('sha256').update(await readFile(fixture.image_paths[0])).digest('hex') }));
      extraArgs.push('--stage=extraction', '--replay=' + replayPath);
    }
    const env = { ...process.env, MODEL_PROVIDER: configured ? 'glm' : '', MODEL_API_KEY: configured ? 'TEST_ONLY' : '', MODEL_NAME: 'test-extractor', MODEL_VISION_NAME: 'test-vision', ...(options.env ?? {}) };
    let code = 0;
    try { await execute(process.execPath, ['--import', pathToFileURL(preload).href, script, '--case=C26', '--repeats=1', ...extraArgs], { cwd: directory, env }); }
    catch (error) { if (typeof error.code !== 'number') throw error; code = error.code; }
    const runs = await readdir(path.join(directory, 'evals/runs'));
    return { code, report: JSON.parse(await readFile(path.join(directory, 'evals/runs', runs[0], 'summary.json'), 'utf8')) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const stubPrefix = `
const text = 'CAMPUS NOTICE\\nITEM 26 SUBMISSION\\nDUE DATE 2026-10-27\\nTIMEZONE ASIA/SHANGHAI\\nBOUNDARY INCLUSIVE\\nMATERIAL FORM A\\nLOCATION ROOM B';
const response = (content) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });
let calls = 0;
globalThis.fetch = async (_url, request) => {
  calls++;
  const payload = JSON.parse(request.body);
  const prompt = typeof payload.messages[0].content === 'string' ? payload.messages[0].content : payload.messages[0].content[0].text;
`;

describe('M4 evaluator CLI fail-closed paths (stubbed provider, not quality)', () => {
  it('ignores application thinking environment flags in the historical English evaluator', async () => {
    const stub = stubPrefix + `
      if (Object.hasOwn(payload, 'thinking')) throw new Error('HISTORICAL_REQUEST_CHANGED');
      if (request.body !== JSON.stringify({ model: payload.model, messages: payload.messages, stream: false, max_tokens: 4000 })) throw new Error('HISTORICAL_REQUEST_BYTES_CHANGED');
      if (payload.model === 'test-vision') return response(JSON.stringify({ text }));
      return response('{}');
    };`;
    const { report } = await runCli(stub, true, { env: { MODEL_THINKING: 'enabled', MODEL_VISION_THINKING: 'disabled' } });
    expect(report.results[0].calls).toBe(3);
    expect(report.results[0].attempts.every((attempt) => attempt.status === 'received')).toBe(true);
    expect(report).not.toHaveProperty('model_parameters');
  });
  it('does not call a provider when configuration is missing and retains planned denominators', async () => {
    const { code, report } = await runCli('globalThis.fetch = () => { throw new Error("NETWORK_MUST_NOT_RUN"); };', false);
    expect(code).toBe(1);
    expect(report.status).toBe('not_run');
    expect(report.results).toHaveLength(2);
    expect(report.metrics.key_fact_correct.denominator).toBe(10);
    expect(report.metrics.false_auto_commit).toBeNull();
  });

  it('reports both failed structural attempts and blocks the dependent update after three calls', async () => {
    const stub = stubPrefix + `
      if (payload.model === 'test-vision') return response(JSON.stringify({ text }));
      return response(JSON.stringify({ schema_version: '1.0', text_revision_id: 'C26-r1-v1', relation: 'new', facts: [], questions: [], private_text: 'DO_NOT_LOG_SECRET' }));
    };`;
    const { code, report } = await runCli(stub);
    expect(code).toBe(1);
    expect(report.results.map((entry) => entry.status)).toEqual(['fail', 'not_run']);
    expect(report.results[0].diagnostics.map((entry) => entry.stage)).toEqual(['extraction', 'extraction_repair']);
    expect(report.results[0].diagnostics[0].issues).toContainEqual({ path: '/relation', code: 'object_required' });
    expect(report.results[0].calls).toBe(3);
    expect(report.results[0].repairs).toBe(1);
    expect(report.results[1].error).toBe('PRIOR_REVISION_INVALID');
    expect(report.metrics.evidence_correct).toMatchObject({ numerator: 0, denominator: 10 });
    expect(JSON.stringify(report)).not.toContain('DO_NOT_LOG_SECRET');
  });

  it('shares the single repair allowance across OCR and extraction', async () => {
    const stub = stubPrefix + `
      if (calls === 1) return response('invalid OCR JSON');
      if (calls === 2) return response(JSON.stringify({ text }));
      if (calls > 3) throw new Error('BUDGET_BROKEN');
      return response('{}');
    };`;
    const { code, report } = await runCli(stub);
    expect(code).toBe(1);
    expect(report.results[0].calls).toBe(3);
    expect(report.results[0].repairs).toBe(1);
    expect(report.results[0].failure_stage).toBe('extraction');
  });

  it('retains the observed C26 failure class: identical invalid JSON before and after repair', async () => {
    const stub = stubPrefix + `
      if (payload.model === 'test-vision') return response(JSON.stringify({ text }));
      // Synthetic grammar failure; the historical/raw C26 response is not available.
      if (calls === 3 && !prompt.includes('UTF-16 offset 35')) throw new Error('ACTIONABLE_SYNTAX_FEEDBACK_MISSING');
      return response('{"schema_version":"1.0","facts":[],}');
    };`;
    const { code, report } = await runCli(stub);
    const initial = report.results[0];
    expect(code).toBe(1);
    expect(initial.error).toBe('MODEL_INVALID_OUTPUT');
    expect(initial.failure_stage).toBe('extraction_repair');
    expect(initial.diagnostics).toEqual([
      { stage: 'extraction', issues: [{ path: '', code: 'json_invalid', kind: 'unexpected_structure', position: 35, line: 1, column: 36 }] },
      { stage: 'extraction_repair', issues: [{ path: '', code: 'json_invalid', kind: 'unexpected_structure', position: 35, line: 1, column: 36 }] },
    ]);
    expect(initial.attempts[1].output_sha256).toBe(initial.attempts[2].output_sha256);
    expect(initial.attempts[1].output_bytes).toBe(initial.attempts[2].output_bytes);
    expect(initial.calls).toBe(3);
    expect(initial.repairs).toBe(1);
    expect(report.results[1].status).toBe('not_run');
    expect(report.metrics.key_fact_correct).toMatchObject({ numerator: 0, denominator: 10 });
  });

  it('blocks the update after two extraction timeouts without waiting two real minutes', async () => {
    const fastTimers = `const originalTimer = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms >= 60_000 ? 1 : ms === 300 ? 0 : ms, ...args);\n`;
    const stub = fastTimers + stubPrefix + `
      if (payload.model === 'test-vision') return response(JSON.stringify({ text }));
      return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    };`;
    const { code, report } = await runCli(stub);
    expect(code).toBe(1);
    expect(report.results.map((entry) => entry.status)).toEqual(['fail', 'not_run']);
    expect(report.results[0]).toMatchObject({ error: 'MODEL_TIMEOUT', failure_stage: 'extraction', calls: 3, retries: 1, repairs: 0 });
    expect(report.results[0].attempts.slice(1).map((entry) => entry.error)).toEqual(['MODEL_TIMEOUT', 'MODEL_TIMEOUT']);
    expect(report.results[1]).toMatchObject({ error: 'PRIOR_REVISION_INVALID', calls: 0 });
    expect(report.metrics.key_fact_correct).toMatchObject({ numerator: 0, denominator: 10 });
  });

  it('replays only actual OCR input and never declares stage diagnostics full acceptance', async () => {
    const replayText = 'CAMPUS NOTICE\nITEM 26 SUBMISSION\nDUE DATE 2026-10-27\nTIMEZONE ASIA/SHANGHAI\nBOUNDARY INCLUSIVE\nMATERIAL FORM A\nLOCATION ROOM B';
    const stub = stubPrefix + `
      if (payload.model === 'test-vision') throw new Error('OCR_MUST_NOT_RUN');
      return response(JSON.stringify({
        schema_version: '1.0', text_revision_id: 'C26-r1-v1', relation: { kind: 'new', target_case_id: null, evidence_refs: [] },
        facts: [
          { id: 'f1', field: 'title', value: 'ITEM 26 SUBMISSION', evidence_refs: ['seg-2'] },
          { id: 'f2', field: 'category', value: 'submission', evidence_refs: ['seg-2'] },
          { id: 'f3', field: 'due', value: { kind: 'date', date: '2026-10-27', timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: 'DUE DATE 2026-10-27' }, evidence_refs: ['seg-3', 'seg-4', 'seg-5'] },
          { id: 'f4', field: 'requirement_add', value: 'FORM A', evidence_refs: ['seg-6'] },
          { id: 'f5', field: 'location', value: 'ROOM B', evidence_refs: ['seg-7'] },
        ], questions: [],
      }));
    };`;
    const { code, report } = await runCli(stub, true, { replayText });
    expect(code).toBe(0);
    expect(report.status).toBe('passed');
    expect(report.execution_mode).toBe('extraction_replay_diagnostic');
    expect(report.quality_comparison_eligible).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ calls: 1, ocr_source: 'replayed_actual_provider_output' });
    expect(report.acceptance).toEqual({ full_heldout_three_repeats: false, key_fact_target: false, evidence_target: false, clarification_target: false, auto_commit_audit: 'not_run', m4_complete: false });
    expect(report.replay_source.run_id).toBe('stub-only');
  });

  it('forwards the actual unconfirmed initial candidate to the selected update target', async () => {
    const stub = stubPrefix + `
      if (payload.model === 'test-vision') return response(JSON.stringify({ text: text + (calls > 2 ? '\\nUPDATE VERSION 2' : '') }));
      const update = prompt.includes('Selected existing target_case_id=eval-C26');
      if (update && (!prompt.includes('read-only-sentinel') || !prompt.includes('C26-r1-v1'))) throw new Error('ACTUAL_BASELINE_NOT_FORWARDED');
      const revision = prompt.match(/text_revision_id="([^"]+)" exactly/)[1];
      return response(JSON.stringify({
        schema_version: '1.0', text_revision_id: revision,
        relation: { kind: update ? 'update' : 'new', target_case_id: update ? 'eval-C26' : null, evidence_refs: update ? ['seg-8'] : [] },
        facts: [
          { id: 'f1', field: 'title', value: 'ITEM 26 SUBMISSION', evidence_refs: ['seg-2'] },
          { id: 'f2', field: 'category', value: 'submission', evidence_refs: ['seg-2'] },
          { id: 'f3', field: 'due', value: { kind: 'date', date: '2026-10-27', timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: 'DUE DATE 2026-10-27' }, evidence_refs: ['seg-3', 'seg-4', 'seg-5'] },
          { id: 'f4', field: 'requirement_add', value: 'FORM A', evidence_refs: ['seg-6'] },
          { id: 'f5', field: 'location', value: 'ROOM B', evidence_refs: ['seg-7'] },
        ], questions: [{ id: 'q-note', field: 'note', prompt: 'read-only-sentinel', blocking: false }],
      }));
    };`;
    const { code, report } = await runCli(stub);
    expect(code).toBe(0);
    expect(report.results.map((entry) => entry.status)).toEqual(['pass', 'pass']);
    expect(report.results[1].context_revision_id).toBe('C26-r1-v1');
    expect(report.metrics.relation_correct).toMatchObject({ numerator: 2, denominator: 2 });
    expect(report.commit_attempted).toBe(false);
    expect(report.auto_commit_check.status).toBe('not_run');
    expect(report.acceptance.m4_complete).toBe(false);
  });
});
