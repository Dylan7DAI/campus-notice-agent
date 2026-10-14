import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { cwd } from 'node:process';
import { describe, expect, it } from 'vitest';

const root = cwd();
const script = join(root, 'scripts', 'report-m7.mjs');

function runReport(inputPath, outputPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, `--input=${inputPath}`, `--out=${outputPath}`], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function completeInput() {
  const participants = Array.from({ length: 8 }, (_, index) => `p${String(index + 1).padStart(2, '0')}`);
  const sessions = [];
  for (const [participantIndex, participantId] of participants.entries()) {
    for (let pairIndex = 1; pairIndex <= 2; pairIndex += 1) {
      for (const condition of ['A', 'B', 'C']) {
        const isB = condition === 'B';
        sessions.push({
          id: `${participantId}-${pairIndex}-${condition}`,
          participant_id: participantId,
          pair_id: `pair${pairIndex}`,
          condition,
          case_id: `case${(participantIndex + pairIndex) % 4}`,
          difficulty: pairIndex === 1 ? 'easy' : 'hard',
          required_items: 2,
          omitted_items: isB ? 1 : 0,
          wrong_update_count: isB ? 1 : 0,
          proposal_error_count: 0,
          correction_seconds: condition === 'C' ? 12 : 10,
          severe_misunderstanding: false,
          failure_category: isB ? 'omission' : null,
          completed: true,
        });
      }
    }
  }
  return {
    schema_version: 'm7-pilot.1',
    protocol_version: 'm7-pilot-protocol.1',
    participants: participants.map((id) => ({ id })),
    sessions,
    observations: [{ issue_code: 'missing_diff', count: 3 }, { issue_code: 'unclear_due', count: 2 }, { issue_code: 'handoff_label', count: 1 }],
    decision: { outcome: 'continue' },
    review: { correction_time_acceptable: true },
  };
}

describe('M7 pilot report', () => {
  it('keeps an empty pilot fail-closed as not_run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'campus-m7-'));
    const input = join(directory, 'input.json');
    const output = join(root, 'evals', 'm7', `.tmp-empty-${Date.now()}.json`);
    await writeFile(input, JSON.stringify({ schema_version: 'm7-pilot.1', protocol_version: 'm7-pilot-protocol.1', participants: [], sessions: [], observations: [], decision: null, review: null }));
    const result = await runReport(input, output);
    expect(result.code).toBe(1);
    expect(JSON.parse(await readFile(output, 'utf8')).status).toBe('not_run');
    await rm(directory, { recursive: true, force: true });
    await rm(output, { force: true });
  });

  it('rejects unapproved input fields with a distinct validation exit code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'campus-m7-'));
    const input = join(directory, 'input.json');
    const output = join(root, 'evals', 'm7', `.tmp-invalid-${Date.now()}.json`);
    await writeFile(input, JSON.stringify({ schema_version: 'm7-pilot.1', protocol_version: 'm7-pilot-protocol.1', participants: [], sessions: [], observations: [], decision: null, review: null, raw_notes: 'must not be accepted' }));
    const result = await runReport(input, output);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('M7_INPUT_INVALID');
    await rm(directory, { recursive: true, force: true });
    await rm(output, { force: true });
  });

  it('rejects participant identifiers that could contain personal data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'campus-m7-'));
    const input = join(directory, 'input.json');
    const output = join(root, 'evals', 'm7', `.tmp-pii-${Date.now()}.json`);
    await writeFile(input, JSON.stringify({
      schema_version: 'm7-pilot.1',
      protocol_version: 'm7-pilot-protocol.1',
      participants: [{ id: '12345678901' }],
      sessions: [],
      observations: [],
      decision: null,
      review: null,
    }));
    const result = await runReport(input, output);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('M7_INPUT_INVALID');
    await rm(directory, { recursive: true, force: true });
    await rm(output, { force: true });
  });

  it('rejects a pair that is missing one of A, B or C', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'campus-m7-'));
    const input = join(directory, 'input.json');
    const output = join(root, 'evals', 'm7', `.tmp-missing-pair-${Date.now()}.json`);
    const incomplete = completeInput();
    incomplete.sessions.pop();
    await writeFile(input, JSON.stringify(incomplete));
    const result = await runReport(input, output);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('M7_INPUT_INVALID');
    await rm(directory, { recursive: true, force: true });
    await rm(output, { force: true });
  });

  it('reports a complete paired pilot without exposing participant IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'campus-m7-'));
    const input = join(directory, 'input.json');
    const output = join(root, 'evals', 'm7', `.tmp-complete-${Date.now()}.json`);
    await writeFile(input, JSON.stringify(completeInput()));
    const result = await runReport(input, output);
    expect(result.code).toBe(0);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report.status).toBe('passed');
    expect(report.m7_complete).toBe(true);
    expect(report.participants.ids_recorded).toBe(false);
    expect(report.paired_comparison.pair_count).toBe(16);
    expect(report.sessions.by_condition.B.omission_rate).toBe(0.5);
    expect(report.sessions.by_condition.C.omission_rate).toBe(0);
    await rm(directory, { recursive: true, force: true });
    await rm(output, { force: true });
  });
});
