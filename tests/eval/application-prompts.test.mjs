import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import * as production from '../../src/application/prompts.ts';
import { createApplicationPromptSelector } from '../../scripts/eval-application-prompts.mjs';
import { evidenceCatalog } from '../../src/application/notice-candidate.ts';

const root = path.resolve(import.meta.dirname, '../..');
const ocrText = 'ITEM 01 REGISTRATION\nCATEGORY registration\nDUE DATE 2026-10-02 Asia/Shanghai inclusive\nMATERIAL ID CARD\nLOCATION ROOM A';

function repairInput(prompt) {
  const match = /\n原始请求上下文[^\n]*\n([^\n]+)/u.exec(prompt);
  return match ? JSON.parse(match[1]) : null;
}

function cli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/eval-model.mjs', ...args], { cwd: root, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.on('data', (value) => { stderr += value; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('explicit application prompt evaluation', () => {
  it('does not expose a selected target without validated preceding candidate output', () => {
    const selector = createApplicationPromptSelector();
    const prompt = selector.extraction({ revisionId: 'synthetic-v1', text: ocrText, prior: null, selectedCaseId: 'should-not-be-exposed', gold: 'GOLD_SHOULD_NOT_ENTER_PROMPT' });
    expect(prompt).toBe(production.buildExtractionRequestPrompt({ textRevisionId: 'synthetic-v1', text: ocrText, evidenceCatalog: evidenceCatalog(ocrText) }));
    expect(prompt).not.toContain('should-not-be-exposed');
    expect(prompt).not.toContain('GOLD_SHOULD_NOT_ENTER_PROMPT');
    expect(() => selector.extraction({ revisionId: 'synthetic-v2', text: ocrText, prior: { facts: [] }, selectedCaseId: 'synthetic-case' })).toThrow('MODEL_INVALID_OUTPUT');
  });

  it('uses production candidate validation to reject fake evidence and exact production repair text', () => {
    const selector = createApplicationPromptSelector();
    const fake = { schema_version: '1.0', text_revision_id: 'synthetic-v1', relation: { kind: 'new', target_case_id: null, evidence_refs: [] },
      facts: [{ id: 'f1', field: 'title', value: 'Synthetic', evidence_refs: ['seg-fabricated'] }], questions: [] };
    expect(() => selector.candidate(JSON.stringify(fake), 'synthetic-v1', evidenceCatalog(ocrText))).toThrow('EVIDENCE_INVALID');
    const input = { revisionId: 'synthetic-v1', text: ocrText, prior: null };
    expect(selector.candidateRepair('{"facts":[]}', input)).toBe(production.buildCandidateRepairRequestPrompt('{"facts":[]}', '候选 JSON 结构不符合 NoticeCandidate schema', { textRevisionId: input.revisionId, text: input.text, evidenceCatalog: evidenceCatalog(input.text) }));
    expect(() => selector.candidateRepair('{"facts":[]}')).toThrow('APPLICATION_PROMPT_CONTEXT_REQUIRED');
  });

  it('uses one production evidence catalog for punctuation, multiline OCR and candidate validation', () => {
    const selector = createApplicationPromptSelector();
    const text = '通知一。请交报名表！\n附件证明？下一句。\n  ';
    const entries = selector.catalog(text);
    expect(entries).toEqual(evidenceCatalog(text));
    expect(entries.map((entry) => entry.quote)).toEqual(['通知一。', '请交报名表！', '附件证明？', '下一句。']);
    expect(selector.extraction({ revisionId: 'synthetic-punctuation', text, prior: null })).toBe(production.buildExtractionRequestPrompt({ textRevisionId: 'synthetic-punctuation', text, evidenceCatalog: entries }));
    const candidate = { schema_version: '1.0', text_revision_id: 'synthetic-punctuation', relation: { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] },
      facts: [{ id: 'f1', field: 'requirement_add', value: '附件证明', evidence_refs: ['seg-3'] }], questions: [] };
    expect(selector.candidate(JSON.stringify(candidate), 'synthetic-punctuation', entries)).toEqual(candidate);
    // Production retains a fallback segment even for nonempty whitespace text.
    expect(selector.catalog('  ')).toEqual(evidenceCatalog('  '));
  });

  it('retains the original revision, notice, evidence and validated selected target during candidate repair', () => {
    const selector = createApplicationPromptSelector();
    const text = '独立合成报名通知。\n提交报名表！';
    const prior = { schema_version: '1.0', text_revision_id: 'synthetic-prior', relation: { kind: 'new', target_case_id: null, evidence_refs: ['seg-1'] },
      facts: [{ id: 'f1', field: 'title', value: '独立合成报名通知。', evidence_refs: ['seg-1'] }], questions: [] };
    const context = { revisionId: 'synthetic-repair-v2', text, prior, selectedCaseId: 'synthetic-target', gold: 'GOLD_MUST_NOT_ENTER_REPAIR' };
    const prompt = selector.candidateRepair('{"facts":[]}', context);
    expect(prompt).toContain('text_revision_id="synthetic-repair-v2"');
    expect(repairInput(prompt)).toEqual({ textRevisionId: context.revisionId, text,
      evidenceCatalog: evidenceCatalog(text), selectedCaseId: 'synthetic-target' });
    expect(prompt).not.toContain('GOLD_MUST_NOT_ENTER_REPAIR');
    const unselected = selector.candidateRepair('{"facts":[]}', { ...context, prior: null });
    expect(repairInput(unselected)).not.toHaveProperty('selectedCaseId');
    expect(() => selector.candidateRepair('{"facts":[]}', { ...context, prior: { facts: [] } })).toThrow('MODEL_INVALID_OUTPUT');
  });

  it('runs the CLI against local synthetic HTTP with production OCR repair and candidate contracts', async () => {
    const requests = [];
    let visionCalls = 0;
    let repairedUpdate = false;
    let latestText = ocrText;
    const server = createServer(async (request, response) => {
      try {
        expect(request.headers.authorization).toBe('Bearer synthetic-eval-key');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        const content = body.messages[0].content;
        let result;
        if (Array.isArray(content)) {
          visionCalls++;
          latestText = ocrText + (visionCalls > 1 ? '\nUPDATE VERSION 2' : '');
          result = visionCalls === 1 ? { facts: [] } : { text: latestText };
        } else if (content.includes('{"text":"..."}') && !content.includes('text_revision_id=')) {
          result = { text: latestText };
        } else {
          const revisionId = /^text_revision_id=(.+)$/m.exec(content)?.[1]
            ?? /text_revision_id="([^"]+)"/.exec(content)?.[1];
          const update = revisionId?.endsWith('-v2');
          if (update) {
            const original = repairInput(content);
            if (original) expect(original).toEqual({ textRevisionId: revisionId, text: latestText, evidenceCatalog: evidenceCatalog(latestText), selectedCaseId: 'eval-C01' });
            else if (!content.includes(latestText) || !content.includes(JSON.stringify(evidenceCatalog(latestText))) || !content.includes('case_id=eval-C01')) throw new Error('REPAIR_CONTEXT_MISSING');
          }
          result = { schema_version: '1.0', text_revision_id: revisionId,
            relation: { kind: update ? 'update' : 'new', target_case_id: update ? 'eval-C01' : null, evidence_refs: [update ? 'seg-6' : 'seg-1'] },
            facts: [
              { id: 'f1', field: 'title', value: 'ITEM 01 REGISTRATION', evidence_refs: ['seg-1'] },
              { id: 'f2', field: 'category', value: 'registration', evidence_refs: ['seg-2'] },
              { id: 'f3', field: 'due', value: { kind: 'date', date: '2026-10-02', timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: 'DUE DATE 2026-10-02 Asia/Shanghai inclusive' }, evidence_refs: ['seg-3'] },
              { id: 'f4', field: 'requirement_add', value: 'ID CARD', evidence_refs: ['seg-4'] },
              { id: 'f5', field: 'location', value: 'ROOM A', evidence_refs: ['seg-5'] },
            ], questions: [] };
          if (update && !repairedUpdate) { result = { facts: [] }; repairedUpdate = true; }
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"SYNTHETIC_REQUEST_INVALID"}');
      }
    });
    let reportDirectory;
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const result = await cli(['--prompts=application', '--set=development', '--case=C01', '--repeats=1'], {
        MODEL_PROVIDER: 'glm', MODEL_API_KEY: 'synthetic-eval-key', MODEL_BASE_URL: `http://127.0.0.1:${address.port}`,
        MODEL_NAME: 'synthetic-text', MODEL_VISION_NAME: 'synthetic-vision',
        MODEL_THINKING: 'enabled', MODEL_VISION_THINKING: 'disabled',
      });
      const lastLine = result.stdout.trim().split('\n').at(-1);
      const reportPath = JSON.parse(lastLine).report;
      const directory = path.dirname(path.resolve(reportPath));
      if (path.dirname(directory) !== path.join(root, 'evals', 'runs') || !path.basename(directory).startsWith('m4-model-')) throw new Error('UNSAFE_SYNTHETIC_EVAL_CLEANUP');
      reportDirectory = directory;
      const summary = JSON.parse(await readFile(reportPath, 'utf8'));
      expect(summary.prompt_source).toBe('application');
      expect(result.code, result.stderr).toBe(0);
      expect(summary).toMatchObject({ prompt_version: production.PROMPT_VERSION, application_prompt_version: production.PROMPT_VERSION,
        budget_mode: 'eval_budget', execution_mode: 'application_prompt_provider_eval', commit_attempted: false });
      expect(summary.application_prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(summary.model_parameters).toEqual({ text: { model: 'synthetic-text', thinking: { type: 'enabled' } }, vision: { model: 'synthetic-vision', thinking: { type: 'disabled' } } });
      expect(summary.results).toHaveLength(2);
      expect(summary.results.every((entry) => entry.status === 'pass')).toBe(true);
      expect(summary.results.map((entry) => entry.calls)).toEqual([3, 3]);
      expect(requests).toHaveLength(6);
      expect(requests.map((body) => body.thinking)).toEqual([{ type: 'disabled' }, { type: 'enabled' }, { type: 'enabled' }, { type: 'disabled' }, { type: 'enabled' }, { type: 'enabled' }]);
      expect(summary.results.flatMap((entry) => entry.attempts).map((attempt) => attempt.thinking)).toEqual(['disabled', 'enabled', 'enabled', 'disabled', 'enabled', 'enabled']);
      expect(requests[0].messages[0].content[0].text).toBe(production.buildVisionPrompt());
      expect(requests[1].messages[0].content).toBe(production.buildVisionRepairPrompt('{"facts":[]}', '视觉识别没有返回 {text:string} JSON'));
      expect(requests[2].messages[0].content).toContain('text_revision_id=C01-r1-v1');
      expect(requests[4].messages[0].content).toContain('case_id=eval-C01');
      expect(requests[5].messages[0].content).toBe(production.buildCandidateRepairRequestPrompt('{"facts":[]}', '候选 JSON 结构不符合 NoticeCandidate schema', { textRevisionId: 'C01-r1-v2', text: latestText, evidenceCatalog: evidenceCatalog(latestText), selectedCaseId: 'eval-C01' }));
      expect(requests.every((body) => body.max_tokens === 4000)).toBe(true);
      expect(result.stdout + result.stderr).not.toContain('synthetic-eval-key');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (reportDirectory) await rm(reportDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
