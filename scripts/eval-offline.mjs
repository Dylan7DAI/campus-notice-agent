import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runScenarios, writeReport } from './eval-runner/index.mjs';

const root = process.cwd();
const fixturePath = path.join(root, 'evals', 'scenarios.json');
const fixtureBytes = await readFile(fixturePath);
const scenarios = JSON.parse(fixtureBytes.toString('utf8'));
const expectedIds = Array.from({ length: 24 }, (_, i) => `E${String(i + 1).padStart(2, '0')}`);
if (!Array.isArray(scenarios.cases) || scenarios.cases.length !== 24 || scenarios.cases.some((s, i) => s.id !== expectedIds[i])) throw new Error('offline fixture contract requires ordered E01-E24 scenarios');
const results = await runScenarios(scenarios);
const { report, reportPath } = await writeReport(scenarios, results, fixtureBytes);
console.error(`Offline evaluation: ${report.counts.pass} pass, ${report.counts.fail} fail, ${report.counts.not_run} not_run.`);
console.error(`Report: ${path.relative(root, reportPath)}`);
process.exitCode = report.counts.fail || report.counts.not_run ? 1 : 0;
