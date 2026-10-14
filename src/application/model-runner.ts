import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GlmClient, ModelClientError } from './glm-client';
import { buildExtractionRequestPrompt, buildCandidateRepairRequestPrompt, buildVisionPrompt, buildVisionRepairPrompt, CANDIDATE_SCHEMA_VERSION, PROMPT_VERSION } from './prompts';
import { evidenceCatalog, parseCandidate, validateCandidateEvidence, type NoticeCandidate } from './notice-candidate';
import { assertStorageKey, stableRunErrorCode } from './data-protection';

const MAX_CALLS = 3;
const MAX_RETRIES = 1;
const MAX_RUN_MS = 240_000;
const activeRuns = new Map<string, AbortController>();

export type RunnerClient = Pick<GlmClient, 'chat' | 'chatWithImage'>;
export type RunOutput = { runId: string; candidate?: NoticeCandidate; text?: string; callCount: number; retryCount: number };

export class ModelRunError extends Error {
  constructor(public readonly code: string, message = code) { super(message); }
}

export class ModelRunner {
  constructor(private readonly db: PrismaClient, private readonly client: RunnerClient, private readonly provider: string, private readonly model: string, private readonly visionClient: RunnerClient = client, private readonly visionModel: string = model) {}

  async recognizeImage(input: { intakeId: string; artifactId: string; storageKey: string; mediaType: string; bytes?: Buffer }): Promise<RunOutput> {
    const bytes = input.bytes ?? await this.readPrivateArtifact(input.storageKey);
    if (bytes.length > 15 * 1024 * 1024) throw new ModelRunError('PAYLOAD_TOO_LARGE');
    const run = await this.start('recognition', input.intakeId, bytes, this.visionModel);
    return this.execute(run, async (ctx) => {
      const dataUrl = `data:${input.mediaType};base64,${bytes.toString('base64')}`;
      const first = await ctx.call((signal) => this.visionClient.chatWithImage(buildVisionPrompt(), dataUrl, signal));
      try { return { text: parseVisionText(first.text), usage: first.usage }; }
      catch (error) {
        if (!(error instanceof ModelRunError) || error.code !== 'MODEL_INVALID_OUTPUT') throw error;
        const repaired = await ctx.call((signal) => this.client.chat(buildVisionRepairPrompt(first.text, '视觉识别没有返回 {text:string} JSON'), signal));
        return { text: parseVisionText(repaired.text), usage: repaired.usage };
      }
    });
  }

  async extract(input: { intakeId: string; textRevisionId: string; text: string; selectedCaseId?: string; selectedTaskId?: string }): Promise<RunOutput> {
    if (input.text.length > 20_000) throw new ModelRunError('PAYLOAD_TOO_LARGE');
    const catalog = evidenceCatalog(input.text);
    const run = await this.start('extraction', input.intakeId, Buffer.from(input.text, 'utf8'), this.model);
    return this.execute(run, async (ctx) => {
      const requestInput = { textRevisionId: input.textRevisionId, text: input.text, evidenceCatalog: catalog, selectedCaseId: input.selectedCaseId, selectedTaskId: input.selectedTaskId };
      const prompt = buildExtractionRequestPrompt(requestInput);
      const first = await ctx.call((signal) => this.client.chat(prompt, signal));
      try {
        const candidate = parseCandidate(first.text); validateCandidateEvidence(candidate, input.textRevisionId, catalog); return { candidate, usage: first.usage };
      } catch (error) {
        if (error instanceof Error && error.message === 'EVIDENCE_INVALID') throw error;
        const repaired = await ctx.call((signal) => this.client.chat(buildCandidateRepairRequestPrompt(first.text, '候选 JSON 结构不符合 NoticeCandidate schema', requestInput), signal));
        const candidate = parseCandidate(repaired.text); validateCandidateEvidence(candidate, input.textRevisionId, catalog); return { candidate, usage: repaired.usage };
      }
    });
  }

  async cancel(runId: string) {
    const run = await this.db.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new ModelRunError('NOT_FOUND');
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return { runId, status: run.status };
    activeRuns.get(runId)?.abort();
    await this.db.agentRun.update({ where: { id: runId }, data: { status: 'cancelled', cancelledAt: new Date(), finishedAt: new Date(), errorCode: 'MODEL_CANCELLED', safeError: '识别已取消，草稿保留' } });
    return { runId, status: 'cancelled' };
  }

  private async start(stage: string, intakeId: string, input: Buffer, model: string) {
    const id = randomUUID();
    await this.db.agentRun.create({ data: { id, intakeId, stage, status: 'running', provider: this.provider, model, promptVersion: PROMPT_VERSION, schemaVersion: CANDIDATE_SCHEMA_VERSION, inputSha256: createHash('sha256').update(input).digest('hex') } });
    return { id, calls: 0, retries: 0, usage: null as unknown };
  }

  private async execute(run: { id: string; calls: number; retries: number; usage: unknown }, work: (ctx: { call: <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T> }) => Promise<{ text?: string; candidate?: NoticeCandidate; usage?: unknown }>): Promise<RunOutput> {
    const controller = new AbortController(); activeRuns.set(run.id, controller); const deadline = setTimeout(() => controller.abort(), MAX_RUN_MS);
    const ctx = { call: async <T>(fn: (signal: AbortSignal) => Promise<T>) => {
      if (controller.signal.aborted) throw new ModelRunError('MODEL_CANCELLED');
      if (run.calls >= MAX_CALLS) throw new ModelRunError('MODEL_BUDGET_EXCEEDED');
      run.calls += 1; await this.db.agentRun.update({ where: { id: run.id }, data: { callCount: run.calls } });
      try { return await fn(controller.signal); }
      catch (error) {
        if (!controller.signal.aborted && error instanceof ModelClientError && error.retryable && run.retries < MAX_RETRIES && run.calls < MAX_CALLS) {
          run.retries += 1; await this.db.agentRun.update({ where: { id: run.id }, data: { retryCount: run.retries } });
          await waitBeforeRetry(error.retryAfterMs, controller.signal);
          run.calls += 1; await this.db.agentRun.update({ where: { id: run.id }, data: { callCount: run.calls } });
          try { return await fn(controller.signal); } catch (retryError) { if (retryError instanceof ModelClientError) throw new ModelRunError(retryError.code); throw retryError; }
        }
        if (error instanceof ModelClientError) throw new ModelRunError(error.code);
        throw error;
      }
    } };
    try {
      const result = await work(ctx);
      const output = result.text ?? JSON.stringify(result.candidate);
      if (controller.signal.aborted) throw new ModelRunError('MODEL_CANCELLED');
      const completed = await this.db.agentRun.updateMany({ where: { id: run.id, status: 'running' }, data: { status: 'succeeded', finishedAt: new Date(), outputSha256: createHash('sha256').update(output).digest('hex'), callCount: run.calls, retryCount: run.retries, tokenUsageJson: result.usage ? JSON.stringify(result.usage) : null } });
      if (completed.count !== 1) throw new ModelRunError('MODEL_CANCELLED');
      return { runId: run.id, ...result, callCount: run.calls, retryCount: run.retries };
    } catch (error) {
      const code = controller.signal.aborted ? 'MODEL_CANCELLED' : error instanceof ModelRunError ? error.code : knownRunErrorCode(error);
      const status = code === 'MODEL_CANCELLED' || controller.signal.aborted ? 'cancelled' : 'failed';
      await this.db.agentRun.updateMany({ where: { id: run.id, status: 'running' }, data: { status, finishedAt: new Date(), errorCode: code, safeError: safeError(code), callCount: run.calls, retryCount: run.retries, cancelledAt: status === 'cancelled' ? new Date() : null } });
      throw new ModelRunError(code);
    } finally { clearTimeout(deadline); activeRuns.delete(run.id); }
  }

  private async readPrivateArtifact(storageKey: string) {
    const root = process.env.PRIVATE_STORAGE_DIR ?? path.resolve(process.cwd(), 'data', 'uploads');
    try {
      const target = assertStorageKey(storageKey, root);
      return await readFile(target);
    } catch {
      // Filesystem errors contain private absolute paths; callers receive only
      // the stable storage failure code, before any image leaves this process.
      throw new ModelRunError('STORAGE_UNAVAILABLE');
    }
  }
}

function knownRunErrorCode(error: unknown): string {
  if (error instanceof Error && ['MODEL_INVALID_OUTPUT', 'EVIDENCE_INVALID', 'PAYLOAD_TOO_LARGE'].includes(error.message)) return error.message;
  return stableRunErrorCode(error);
}

async function waitBeforeRetry(retryAfterMs: number | undefined, signal: AbortSignal) {
  const delay = Math.max(0, Math.min(retryAfterMs ?? 300, MAX_RUN_MS));
  if (!delay) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    const abort = () => { clearTimeout(timer); reject(new ModelRunError('MODEL_CANCELLED')); };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    setTimeout(() => signal.removeEventListener('abort', abort), delay + 1);
  });
}

function parseVisionText(raw: string) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { const value = JSON.parse(cleaned) as { text?: unknown }; if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20_000) throw new Error(); return value.text; } catch {
    try { const normalized = cleaned.replace(/[\u0000-\u001f]/g, (char) => char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : ''); const value = JSON.parse(normalized) as { text?: unknown }; if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20_000) throw new Error(); return value.text; } catch { throw new ModelRunError('MODEL_INVALID_OUTPUT'); }
  }
}

function safeError(code: string) {
  if (code === 'MODEL_TIMEOUT') return '模型请求超时，草稿已保留';
  if (code === 'MODEL_INVALID_OUTPUT') return '模型输出无法可靠校验，请校正文本';
  if (code === 'MODEL_CANCELLED') return '识别已取消，草稿已保留';
  if (code === 'MODEL_BUDGET_EXCEEDED') return '识别预算已用尽，草稿已保留';
  return '模型暂时不可用，草稿已保留';
}
