import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { getConfig } from '../../../../../config';
import { GlmClient } from '../../../../../application/glm-client';
import { ModelRunner } from '../../../../../application/model-runner';
import { assertLocalOrigin, DataProtectionError } from '../../../../../application/data-protection';

const db = new PrismaClient();
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { assertLocalOrigin(req); } catch (error) { return NextResponse.json({ error: { code: error instanceof DataProtectionError ? error.code : 'ORIGIN_FORBIDDEN' } }, { status: 403 }); }
  const { id } = await params;
  const run = await db.agentRun.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: { code: 'NOT_FOUND', message: '运行不存在' } }, { status: 404 });
  try {
    const cfg = getConfig();
    const runner = new ModelRunner(db, new GlmClient({ apiKey: cfg.MODEL_API_KEY ?? 'disabled', baseUrl: cfg.MODEL_BASE_URL, model: cfg.MODEL_NAME }), cfg.modelProvider, cfg.MODEL_NAME);
    return NextResponse.json(await runner.cancel(id));
  } catch (error) {
    return NextResponse.json({ error: { code: error instanceof Error ? error.message : 'CANCEL_FAILED', message: '无法取消运行' } }, { status: 409 });
  }
}
