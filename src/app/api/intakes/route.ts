import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { getConfig } from '../../../config';
import { GlmClient } from '../../../application/glm-client';
import { ModelRunError, ModelRunner } from '../../../application/model-runner';
import { IntakeService } from '../../../application/intake-service';
import { CommandError } from '../../../application/task-commands';
import { assertLocalOrigin, assertStorageKey, DataProtectionError, validateImageUpload } from '../../../application/data-protection';
const db = new PrismaClient();
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  const intake = await db.intake.findUnique({ where: { id } });
  if (!intake) return NextResponse.json({ error: '未找到草稿' }, { status: 404 });
  const [runs, source] = await Promise.all([
    db.agentRun.findMany({ where: { intakeId: id }, orderBy: { startedAt: 'desc' } }),
    intake.sourceArtifactId ? db.sourceArtifact.findUnique({ where: { id: intake.sourceArtifactId }, select: { mediaType: true } }) : Promise.resolve(null),
  ]);
  return NextResponse.json({ ...intake, sourceMediaType: source?.mediaType ?? null, runs: runs.map((run) => ({ ...run, tokenUsageJson: undefined, costJson: undefined })) });
}
export async function POST(req: Request) {
  try { assertLocalOrigin(req); } catch (error) { const code = error instanceof DataProtectionError ? error.code : 'ORIGIN_FORBIDDEN'; return NextResponse.json({ error: { code } }, { status: 403 }); }
  const type=req.headers.get('content-type')??''; let body:{action?:string;intakeId?:string;text?:string;textRevisionId?:string|null;selectedCaseId?:string;selectedTaskId?:string;idempotencyKey?:string;previewHash?:string;candidate?:unknown};
  if (type.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File) || !['image/png', 'image/jpeg'].includes(file.type)) return NextResponse.json({ error: '仅支持 PNG/JPEG 图片' }, { status: 415 });
    if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: '图片不得超过10MB' }, { status: 413 });
    const bytes = Buffer.from(await file.arrayBuffer());
    try { validateImageUpload(bytes, file.type); }
    catch (error) { const code = error instanceof DataProtectionError ? error.code : 'UNSUPPORTED_MEDIA'; return NextResponse.json({ error: code }, { status: code === 'PAYLOAD_TOO_LARGE' ? 413 : 415 }); }
    const storageRoot = process.env.PRIVATE_STORAGE_DIR ?? './data/uploads';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let createdFile: string | null = null;
    try {
      await mkdir(storageRoot, { recursive: true });
      const saved = await db.$transaction(async (tx) => {
        let artifact = await tx.sourceArtifact.findUnique({ where: { sha256 } });
        if (artifact && artifact.mediaType !== file.type) throw new CommandError('SOURCE_MEDIA_CONFLICT');
        if (artifact) {
          const existing = await tx.intake.findFirst({ where: { sourceArtifactId: artifact.id }, orderBy: { createdAt: 'desc' } });
          if (existing) return { intakeId: existing.id, stage: existing.stage, sourceArtifactId: artifact.id, sourceMediaType: artifact.mediaType, textRevisionId: existing.textRevisionId, approved: existing.approved, candidateJson: existing.candidateJson, replayed: true };
        } else {
          const key = `${randomUUID()}${file.type === 'image/png' ? '.png' : '.jpg'}`;
          const target = assertStorageKey(key, storageRoot);
          await writeFile(target, bytes, { flag: 'wx' });
          createdFile = target;
          artifact = await tx.sourceArtifact.create({ data: { id: randomUUID(), sha256, mediaType: file.type, privateStorageKey: key, originLabel: '本地用户', size: file.size } });
        }
        const created = await tx.intake.create({ data: { id: randomUUID(), text: '[图片尚未识别，请识别文字或填写人工校正稿]', stage: 'text_review', sourceArtifactId: artifact.id } });
        return { intakeId: created.id, stage: created.stage, sourceArtifactId: artifact.id, sourceMediaType: artifact.mediaType, textRevisionId: null, approved: false, candidateJson: null, replayed: false };
      });
      return NextResponse.json(saved);
    } catch (error) {
      if (createdFile) await rm(createdFile, { force: true });
      if (error instanceof CommandError) return intakeFailure(error);
      return NextResponse.json({ error: { code: 'STORAGE_UNAVAILABLE', message: '图片保存未完成，请重试' } }, { status: 503 });
    }
  }
  body=await req.json();
  if (body.action === 'create') {
    if (!body.text?.trim() || body.text.length > 20000) return NextResponse.json({ error: '文本不能为空且不得超过20000字' }, { status: 400 });
    const text = body.text;
    const sha256 = createHash('sha256').update(text).digest('hex');
    const saved = await db.$transaction(async (tx) => {
      const existingArtifact = await tx.sourceArtifact.findUnique({ where: { sha256 } });
      if (existingArtifact && existingArtifact.mediaType !== 'text/plain') return null;
      const existing = existingArtifact ? await tx.intake.findFirst({ where: { sourceArtifactId: existingArtifact.id, text }, orderBy: { createdAt: 'desc' } }) : null;
      if (existing) return { intakeId: existing.id, textRevisionId: existing.textRevisionId, stage: existing.stage, approved: existing.approved, candidateJson: existing.candidateJson, replayed: true };
      const sourceId = randomUUID();
      const artifact = existingArtifact ?? await tx.sourceArtifact.create({ data: { id: sourceId, sha256, mediaType: 'text/plain', privateStorageKey: `text/${sourceId}`, originLabel: '本地用户', size: Buffer.byteLength(text) } });
      const revision = await tx.textRevision.create({ data: { id: randomUUID(), sourceId: artifact.id, text, method: 'manual' } });
      const created = await tx.intake.create({ data: { id: randomUUID(), text, stage: 'text_review', sourceArtifactId: artifact.id, textRevisionId: revision.id } });
      return { intakeId: created.id, stage: created.stage, textRevisionId: revision.id, approved: false, candidateJson: null, replayed: false };
    });
    if (!saved) return NextResponse.json({ error: { code: 'SOURCE_MEDIA_CONFLICT' } }, { status: 409 });
    return NextResponse.json(saved);
  }
  if(!body.intakeId)return NextResponse.json({error:'缺少 intakeId'},{status:400}); const intake=await db.intake.findUnique({where:{id:body.intakeId}});if(!intake)return NextResponse.json({error:'未找到草稿'},{status:404});
  if (intake.stage === 'applied' && ['recognize', 'extract', 'approve', 'candidate'].includes(body.action ?? '')) return intakeFailure(new CommandError('INTAKE_ALREADY_APPLIED'));
  if (body.action === 'revise') {
    if (!body.text?.trim() || body.text.length > 20000) return NextResponse.json({ error: '文本不能为空且不得超过20000字' }, { status: 400 });
    if (!intake.sourceArtifactId) return NextResponse.json({ error: { code: 'SOURCE_NOT_FOUND' } }, { status: 422 });
    if (intake.stage === 'applied') return NextResponse.json({ error: { code: 'INTAKE_ALREADY_APPLIED' } }, { status: 409 });
    const expectedRevisionId = body.textRevisionId;
    if (expectedRevisionId === undefined || expectedRevisionId !== intake.textRevisionId) return intakeFailure(new CommandError('TEXT_REVISION_STALE'));
    const text = body.text;
    try {
      const saved = await db.$transaction(async (tx) => {
        const current = await tx.intake.findUniqueOrThrow({ where: { id: intake.id } });
        if (current.stage === 'applied') throw new CommandError('INTAKE_ALREADY_APPLIED');
        if (current.textRevisionId !== expectedRevisionId) throw new CommandError('TEXT_REVISION_STALE');
        if (current.text === text && current.textRevisionId) return { intakeId: current.id, textRevisionId: current.textRevisionId, stage: current.stage, approved: current.approved, candidateJson: current.candidateJson, replayed: true };
        const revision = await tx.textRevision.create({ data: { id: randomUUID(), sourceId: current.sourceArtifactId!, parentId: current.textRevisionId, text, method: 'manual' } });
        const changed = await tx.intake.updateMany({ where: { id: current.id, textRevisionId: expectedRevisionId, stage: { not: 'applied' } }, data: { text, textRevisionId: revision.id, approved: false, candidateJson: null, stage: 'text_review' } });
        if (changed.count !== 1) throw new CommandError('TEXT_REVISION_STALE');
        return { intakeId: current.id, textRevisionId: revision.id, stage: 'text_review', approved: false, candidateJson: null, replayed: false };
      });
      return NextResponse.json(saved);
    } catch (error) { return intakeFailure(error); }
  }
  const intakeService = new IntakeService(db);
  if (body.action === 'preview' && intake.candidateJson && (() => { try { return JSON.parse(intake.candidateJson).schema_version === '1.0'; } catch { return false; } })()) {
    try {
      const preview = await intakeService.preview(intake.id, body.selectedCaseId, body.selectedTaskId);
      const previewHash = createHash('sha256').update(JSON.stringify({ intakeId: intake.id, preview, selectedCaseId: body.selectedCaseId ?? null, selectedTaskId: body.selectedTaskId ?? null })).digest('hex');
      return NextResponse.json({ code: 'PREVIEW', preview, previewHash });
    } catch (error) {
      return intakeFailure(error);
    }
  }
  if(body.action==='recognize') {
    if(!intake.sourceArtifactId)return NextResponse.json({error:{code:'SOURCE_NOT_FOUND',message:'没有可识别的图片'}},{status:422});
    const artifact=await db.sourceArtifact.findUnique({where:{id:intake.sourceArtifactId}}); if(!artifact||!['image/png','image/jpeg'].includes(artifact.mediaType))return NextResponse.json({error:{code:'UNSUPPORTED_MEDIA',message:'只支持 PNG/JPEG 图片'}},{status:415});
    try {
      const cfg = getConfig();
      if (cfg.modelProvider === 'mock') return NextResponse.json({ error: { code: 'MODEL_UNAVAILABLE', message: '当前为 mock 模式，请配置真实 provider' } }, { status: 503 });
      const textClient = new GlmClient({ apiKey: cfg.MODEL_API_KEY!, baseUrl: cfg.MODEL_BASE_URL, model: cfg.MODEL_NAME, thinking: cfg.MODEL_THINKING });
      const visionClient = new GlmClient({ apiKey: cfg.MODEL_API_KEY!, baseUrl: cfg.MODEL_BASE_URL, model: cfg.MODEL_VISION_NAME, thinking: cfg.MODEL_VISION_THINKING });
      const runner = new ModelRunner(db, textClient, cfg.modelProvider, cfg.MODEL_NAME, visionClient, cfg.MODEL_VISION_NAME);
      const out = await runner.recognizeImage({ intakeId: intake.id, artifactId: artifact.id, storageKey: artifact.privateStorageKey, mediaType: artifact.mediaType });
      const recognizedText = out.text;
      if (typeof recognizedText !== 'string') throw new ModelRunError('MODEL_INVALID_OUTPUT');
      const revisionId = await db.$transaction(async (tx) => {
        const current = await tx.intake.findUniqueOrThrow({ where: { id: intake.id } });
        if (current.stage === 'applied') throw new CommandError('INTAKE_ALREADY_APPLIED');
        if (current.textRevisionId !== intake.textRevisionId || current.text !== intake.text || current.sourceArtifactId !== artifact.id || current.approved !== intake.approved || current.stage !== intake.stage) throw new CommandError('TEXT_REVISION_STALE');
        const revision = await tx.textRevision.create({ data: { id: randomUUID(), sourceId: artifact.id, parentId: current.textRevisionId, text: recognizedText, method: 'ocr' } });
        const saved = await tx.intake.updateMany({ where: { id: intake.id, textRevisionId: intake.textRevisionId, text: intake.text, approved: intake.approved, stage: intake.stage }, data: { text: recognizedText, textRevisionId: revision.id, approved: false, candidateJson: null, stage: 'text_review' } });
        if (saved.count !== 1) throw new CommandError('TEXT_REVISION_STALE');
        return revision.id;
      });
      return NextResponse.json({ runId: out.runId, status: 'succeeded', textRevisionId: revisionId, stage: 'text_review' });
    } catch (error) {
      if (error instanceof CommandError) return intakeFailure(error);
      const run = await db.agentRun.findFirst({ where: { intakeId: intake.id }, orderBy: { startedAt: 'desc' } });
      const code = error instanceof ModelRunError ? error.code : 'MODEL_UNAVAILABLE';
      const status = code === 'MODEL_INVALID_OUTPUT' ? 422 : code === 'MODEL_TIMEOUT' ? 504 : 503;
      return NextResponse.json({ error: { code, message: '识别未完成，草稿已保留', request_id: randomUUID() }, runId: run?.id ?? null }, { status });
    }
  }
  if (body.action === 'approve') {
    const revisionId = body.textRevisionId ?? intake.textRevisionId;
    if (!revisionId) return NextResponse.json({ error: { code: 'TEXT_REVISION_NOT_FOUND' } }, { status: 404 });
    if (revisionId !== intake.textRevisionId) return intakeFailure(new CommandError('TEXT_REVISION_STALE'));
    try {
      await db.$transaction(async (tx) => {
        const current = await tx.intake.findUniqueOrThrow({ where: { id: intake.id } });
        if (current.stage === 'applied') throw new CommandError('INTAKE_ALREADY_APPLIED');
        const revision = await tx.textRevision.findUnique({ where: { id: revisionId } });
        if (!revision || revision.sourceId !== current.sourceArtifactId) throw new CommandError('TEXT_REVISION_NOT_FOUND');
        if (current.textRevisionId !== revisionId || current.text !== revision.text) throw new CommandError('TEXT_REVISION_STALE');
        const existing = await tx.textApproval.findFirst({ where: { intakeId: intake.id, textRevisionId: revisionId } });
        if (!existing) await tx.textApproval.create({ data: { id: randomUUID(), intakeId: intake.id, textRevisionId: revisionId } });
        const saved = await tx.intake.updateMany({ where: { id: intake.id, textRevisionId: revisionId, text: revision.text, stage: { not: 'applied' } }, data: { approved: true, stage: 'proposal_ready' } });
        if (saved.count !== 1) throw new CommandError('TEXT_REVISION_STALE');
      });
      return NextResponse.json({ stage: 'proposal_ready', approved: true, textRevisionId: revisionId });
    } catch (error) { return intakeFailure(error); }
  }
  if(body.action==='extract') {
    const revisionId = body.textRevisionId ?? intake.textRevisionId;
    if (revisionId !== intake.textRevisionId) return intakeFailure(new CommandError('TEXT_REVISION_STALE'));
    if (!intake.approved || !revisionId) return NextResponse.json({ error: { code: 'TEXT_REVISION_NOT_APPROVED', message: '请先审核确切文本版本' } }, { status: 422 });
    const revision = await db.textRevision.findUnique({ where: { id: revisionId } });
    const approval = await db.textApproval.findFirst({ where: { intakeId: intake.id, textRevisionId: revisionId } });
    if (!revision || revision.sourceId !== intake.sourceArtifactId) return NextResponse.json({ error: { code: 'TEXT_REVISION_NOT_FOUND' } }, { status: 404 });
    if (revision.text !== intake.text) return intakeFailure(new CommandError('TEXT_REVISION_STALE'));
    if (!approval) return NextResponse.json({ error: { code: 'TEXT_REVISION_NOT_APPROVED', message: '该文本版本尚未审核' } }, { status: 422 });
    try {
      const cfg = getConfig();
      if (cfg.modelProvider === 'mock') return NextResponse.json({ error: { code: 'MODEL_UNAVAILABLE', message: '当前为 mock 模式，请配置真实 provider' } }, { status: 503 });
      const runner = new ModelRunner(db, new GlmClient({ apiKey: cfg.MODEL_API_KEY!, baseUrl: cfg.MODEL_BASE_URL, model: cfg.MODEL_NAME, thinking: cfg.MODEL_THINKING }), cfg.modelProvider, cfg.MODEL_NAME);
      const out = await runner.extract({ intakeId: intake.id, textRevisionId: revision.id, text: revision.text, selectedCaseId: body.selectedCaseId, selectedTaskId: body.selectedTaskId });
      await db.$transaction(async (tx) => {
        const current = await tx.intake.findUniqueOrThrow({ where: { id: intake.id } });
        if (current.stage === 'applied') throw new CommandError('INTAKE_ALREADY_APPLIED');
        if (current.textRevisionId !== revisionId || current.text !== revision.text || !current.approved || current.stage !== intake.stage) throw new CommandError('TEXT_REVISION_STALE');
        const saved = await tx.intake.updateMany({ where: { id: intake.id, textRevisionId: revisionId, text: revision.text, approved: true, stage: intake.stage }, data: { candidateJson: JSON.stringify(out.candidate), stage: 'proposal_ready' } });
        if (saved.count !== 1) throw new CommandError('TEXT_REVISION_STALE');
      });
      return NextResponse.json({ runId: out.runId, status: 'succeeded', mode: 'real', candidate: out.candidate });
    } catch (error) {
      if (error instanceof CommandError) return intakeFailure(error);
      const run = await db.agentRun.findFirst({ where: { intakeId: intake.id }, orderBy: { startedAt: 'desc' } });
      const code = error instanceof ModelRunError ? error.code : error instanceof Error && error.message === 'EVIDENCE_INVALID' ? 'EVIDENCE_INVALID' : 'MODEL_INVALID_OUTPUT';
      const status = code === 'EVIDENCE_INVALID' || code === 'MODEL_INVALID_OUTPUT' ? 422 : code === 'MODEL_TIMEOUT' ? 504 : 503;
      return NextResponse.json({ error: { code, message: '候选未通过结构或证据校验，草稿已保留', request_id: randomUUID() }, runId: run?.id ?? null }, { status });
    }
  }
  if (body.action === 'candidate') {
    return intakeFailure(new CommandError('LEGACY_CANDIDATE_UNSUPPORTED'));
  }
  if (body.action === 'confirm') {
    if (!intake.approved || !intake.candidateJson) return NextResponse.json({ error: '请先审核文本并生成带证据的候选' }, { status: 422 });
    let raw: { schema_version?: unknown; relation?: { kind?: unknown } } | null;
    try { raw = JSON.parse(intake.candidateJson) as typeof raw; }
    catch { return intakeFailure(new CommandError('LEGACY_CANDIDATE_UNSUPPORTED')); }
    if (!raw || typeof raw !== 'object' || raw.schema_version !== '1.0') return intakeFailure(new CommandError('LEGACY_CANDIDATE_UNSUPPORTED'));
    if (body.candidate && JSON.stringify(body.candidate) !== JSON.stringify(raw)) return NextResponse.json({ error: { code: 'CANDIDATE_CHANGED', message: '确认内容必须来自服务器保存的提案' } }, { status: 409 });
    if (!body.idempotencyKey) return NextResponse.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } }, { status: 400 });
    try {
      if (!body.previewHash) return NextResponse.json({ error: { code: 'PREVIEW_REQUIRED', message: '请先预览候选提案' } }, { status: 422 });
      if (raw.relation?.kind === 'update') {
        const previous = await db.commandResult.findUnique({ where: { scope_idempotencyKey: { scope: 'proposal', idempotencyKey: body.idempotencyKey } } });
        if (previous) {
          const saved = JSON.parse(previous.responseJson) as { proposalId?: string };
          const proposal = saved.proposalId ? await db.changeProposal.findUnique({ where: { id: saved.proposalId } }) : null;
          if (!proposal) throw new CommandError('IDEMPOTENCY_KEY_REUSED');
          const result = await intakeService.apply(intake.id, body.idempotencyKey, body.selectedCaseId, body.selectedTaskId, proposal.expectedCaseVersion, body.previewHash);
          return NextResponse.json({ ...result, stage: 'applied' });
        }
      }
      const preview = await intakeService.preview(intake.id, body.selectedCaseId, body.selectedTaskId);
      const expectedPreviewHash = createHash('sha256').update(JSON.stringify({ intakeId: intake.id, preview, selectedCaseId: body.selectedCaseId ?? null, selectedTaskId: body.selectedTaskId ?? null })).digest('hex');
      if (body.previewHash !== expectedPreviewHash) return NextResponse.json({ error: { code: 'PREVIEW_STALE', message: '提案预览已过期，请重新预览' } }, { status: 409 });
      const result = await intakeService.apply(intake.id, body.idempotencyKey, body.selectedCaseId, body.selectedTaskId, preview.caseVersion, body.previewHash);
      return NextResponse.json({ ...result, stage: 'applied' });
    } catch (error) {
      return intakeFailure(error);
    }
  }
  return NextResponse.json({error:'未知 action'},{status:400});
}

function intakeFailure(error: unknown) {
  const code = error instanceof CommandError ? error.code : 'INTAKE_APPLY_FAILED';
  const status = code === 'VERSION_CONFLICT' ? 409 : code === 'LEGACY_CANDIDATE_UNSUPPORTED' || code === 'CANDIDATE_NOT_FOUND' || code === 'TEXT_REVISION_NOT_APPROVED' || code === 'TARGET_CASE_REQUIRED' || code === 'TASK_SELECTION_INVALID' || code === 'TASK_NOT_FOUND' || code === 'PROPOSAL_QUESTIONS_UNANSWERED' || code === 'CLARIFICATION_REQUIRED' || code === 'CANDIDATE_TITLE_REQUIRED' || code === 'CANDIDATE_CATEGORY_REQUIRED' || code === 'INVALID_DUE' || code === 'UNSUPPORTED_UPDATE_FIELD' ? 422 : code === 'IDEMPOTENCY_KEY_REQUIRED' ? 400 : 409;
  return NextResponse.json({ error: { code, message: '候选未通过确认前校验', request_id: error instanceof CommandError ? error.requestId : randomUUID() } }, { status });
}

