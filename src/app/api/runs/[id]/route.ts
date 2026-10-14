import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { recoverStaleRuns } from '../../../../application/data-protection';
import { assertLocalOrigin, DataProtectionError } from '../../../../application/data-protection';

const db = new PrismaClient();
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { assertLocalOrigin(req); } catch (error) { return NextResponse.json({ error: { code: error instanceof DataProtectionError ? error.code : 'ORIGIN_FORBIDDEN' } }, { status: 403 }); }
  const { id } = await params;
  await recoverStaleRuns(db);
  const run = await db.agentRun.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: { code: 'NOT_FOUND', message: '运行不存在' } }, { status: 404 });
  return NextResponse.json({ ...run, tokenUsageJson: run.tokenUsageJson ? JSON.parse(run.tokenUsageJson) : null, costJson: run.costJson ? JSON.parse(run.costJson) : null });
}
