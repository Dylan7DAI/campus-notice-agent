import { PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertLocalOrigin, DataProtectionError } from '../../../../application/data-protection';
import { evidenceCatalog, noticeCandidateSchema, type NoticeCandidate } from '../../../../application/notice-candidate';
import { demoSamples } from '../../../../demo/samples';

const db = new PrismaClient();
const requestSchema = z.object({
  intakeId: z.string().min(1),
  sampleId: z.enum(['original', 'update', 'unknown']),
  selectedCaseId: z.string().min(1).optional(),
  selectedTaskId: z.string().min(1).optional(),
}).strict();

function failure(code: string, status = 422) {
  return NextResponse.json({ error: { code } }, { status });
}

export async function POST(request: Request) {
  if (process.env.DEMO_MODE !== '1') return failure('DEMO_DISABLED', 404);
  try {
    assertLocalOrigin(request);
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) return failure('INVALID_REQUEST', 400);
    const input = parsed.data;
    const sample = demoSamples[input.sampleId];
    const intake = await db.intake.findUnique({ where: { id: input.intakeId } });
    if (!intake?.textRevisionId || !intake.approved) return failure('TEXT_REVISION_NOT_APPROVED');
    const [revision, approval] = await Promise.all([
      db.textRevision.findUnique({ where: { id: intake.textRevisionId } }),
      db.textApproval.findFirst({ where: { intakeId: intake.id, textRevisionId: intake.textRevisionId } }),
    ]);
    if (!revision || revision.sourceId !== intake.sourceArtifactId || !approval) return failure('TEXT_REVISION_NOT_APPROVED');
    if (revision.text !== sample.text || intake.text !== sample.text) return failure('DEMO_SAMPLE_MISMATCH');
    if (intake.stage === 'applied') return failure('INTAKE_ALREADY_APPLIED', 409);

    if (input.sampleId === 'update') {
      if (!input.selectedCaseId || !input.selectedTaskId) return failure('TARGET_CASE_REQUIRED');
      const task = await db.task.findUnique({ where: { id: input.selectedTaskId } });
      const targetCase = await db.case.findUnique({ where: { id: input.selectedCaseId } });
      if (!task || task.caseId !== input.selectedCaseId || task.title !== sample.title || targetCase?.title !== sample.title || targetCase.category !== sample.category) return failure('TASK_SELECTION_INVALID');
    } else if (input.selectedCaseId || input.selectedTaskId) {
      return failure('TASK_SELECTION_INVALID');
    }

    const catalog = evidenceCatalog(revision.text);
    const reference = (phrase: string) => {
      const entry = catalog.find((segment) => segment.quote.includes(phrase));
      if (!entry) throw new Error('DEMO_EVIDENCE_INVALID');
      return [entry.id];
    };
    const candidate: NoticeCandidate = {
      schema_version: '1.0', text_revision_id: revision.id,
      relation: input.sampleId === 'update'
        ? { kind: 'update', target_case_id: input.selectedCaseId!, evidence_refs: reference('同一报名事项') }
        : { kind: 'new', target_case_id: null, evidence_refs: reference(sample.title) },
      facts: [
        { id: 'title', field: 'title', value: sample.title, evidence_refs: reference(sample.title) },
        { id: 'category', field: 'category', value: sample.category, evidence_refs: reference('报名') },
        { id: 'due', field: 'due', value: sample.date ? { kind: 'date', date: sample.date, timezone: 'Asia/Shanghai', boundary: 'inclusive', raw: `截止 ${sample.date}，含当日` } : { kind: 'unknown', raw: '报名截止日期尚未确定，另行通知' }, evidence_refs: reference(sample.date ?? '尚未确定') },
        { id: 'requirement', field: 'requirement_add', value: sample.requirement, evidence_refs: reference(sample.requirement) },
      ],
      questions: [],
    };
    noticeCandidateSchema.parse(candidate);
    const saved = await db.intake.updateMany({
      where: { id: intake.id, textRevisionId: revision.id, text: sample.text, approved: true, stage: { not: 'applied' } },
      data: { candidateJson: JSON.stringify(candidate), stage: 'proposal_ready' },
    });
    if (saved.count !== 1) return failure('TEXT_REVISION_CHANGED', 409);
    return NextResponse.json({ mode: 'mock', sampleId: input.sampleId, candidate, evidence: catalog });
  } catch (error) {
    if (error instanceof DataProtectionError) return failure(error.code, 403);
    if (error instanceof SyntaxError) return failure('INVALID_REQUEST', 400);
    return failure('DEMO_CANDIDATE_FAILED', 500);
  }
}
