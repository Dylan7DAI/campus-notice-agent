import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { assertLocalOrigin } from '../../../../../application/data-protection';
import { CaseDeletionError, cleanupDeletedCaseFiles, deleteCaseData } from '../../../../../application/case-deletion';

const db = new PrismaClient();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertLocalOrigin(request);
    const { id } = await params;
    const body = await request.json() as { expectedCaseVersion?: number; confirmation?: boolean; backupAcknowledged?: boolean };
    const result = await deleteCaseData(db, { caseId: id, expectedCaseVersion: body.expectedCaseVersion, confirmation: body.confirmation, backupAcknowledged: body.backupAcknowledged });
    const storageDirectory = process.env.PRIVATE_STORAGE_DIR ?? `${process.cwd()}/data/uploads`;
    await cleanupDeletedCaseFiles(result.storageKeys, storageDirectory);
    return NextResponse.json({ code: 'CASE_DELETED', caseId: result.caseId, deleted: result.deleted });
  } catch (error) {
    const code = error instanceof CaseDeletionError || error instanceof Error && 'code' in error ? (error as { code?: string }).code ?? 'DELETE_FAILED' : 'DELETE_FAILED';
    const status = code === 'CASE_NOT_FOUND' ? 404 : code === 'VERSION_CONFLICT' ? 409 : code === 'ORIGIN_FORBIDDEN' ? 403 : code === 'CONFIRMATION_REQUIRED' || code === 'BACKUP_REQUIRED' || code === 'VERSION_REQUIRED' ? 400 : 422;
    return NextResponse.json({ error: { code, message: '删除未完成，未自动删除其他事项数据' } }, { status });
  }
}

