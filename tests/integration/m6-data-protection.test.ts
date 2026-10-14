import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertLocalOrigin, assertStorageKey, createBackup, DataProtectionError, redactTrace, recoverStaleRuns, restoreBackup, validateImageUpload } from '../../src/application/data-protection';
import { cleanupDeletedCaseFiles, deleteCaseData } from '../../src/application/case-deletion';

const db = new PrismaClient();
const ids = { caseId: 'm6-case-delete', taskId: 'm6-task-delete', artifactId: 'm6-artifact-delete', revisionId: 'm6-revision-delete', noticeId: 'm6-notice-delete', intakeId: 'm6-intake-delete', approvalId: 'm6-approval-delete', evidenceId: 'm6-evidence-delete' };

describe('M6 data protection and recovery', () => {
  it('rejects unsafe uploads and paths and redacts content-bearing trace fields', () => {
    expect(() => validateImageUpload(Buffer.from('not-an-image'), 'image/png')).toThrowError('UNSUPPORTED_MEDIA');
    expect(() => validateImageUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png', 7)).toThrowError('PAYLOAD_TOO_LARGE');
    expect(() => assertStorageKey('../outside')).toThrowError('STORAGE_KEY_INVALID');
    expect(() => assertLocalOrigin(new Request('http://127.0.0.1:3000/api/commands', { headers: { origin: 'http://evil.example' } }))).toThrowError('ORIGIN_FORBIDDEN');
    expect(() => assertLocalOrigin(new Request('http://localhost:3000/api/commands', { headers: { origin: 'http://127.0.0.1:3000' } }))).not.toThrow();
    const trace = redactTrace({ run_id: 'r1', prompt: 'private notice text', response: 'private response', content: 'private body', count: 2, nested: { quote: 'secret' } });
    expect(JSON.stringify(trace)).not.toContain('private notice text');
    expect(JSON.stringify(trace)).not.toContain('private response');
    expect(JSON.stringify(trace)).not.toContain('secret');
    expect(JSON.stringify(trace)).not.toContain('private body');
    expect((trace as { run_id: string }).run_id).toBe('r1');
  });

  it('marks stale runs interrupted without committing a task', async () => {
    await db.sourceArtifact.create({ data: { id: 'm6-artifact-recovery', sha256: 'm6-sha-recovery', mediaType: 'text/plain', privateStorageKey: 'm6-recovery.txt', originLabel: 'synthetic', size: 0 } });
    await db.intake.create({ data: { id: 'm6-intake-recovery', text: 'draft', stage: 'recognizing', sourceArtifactId: 'm6-artifact-recovery' } });
    await db.agentRun.create({ data: { id: 'm6-run-recovery', intakeId: 'm6-intake-recovery', stage: 'recognition', status: 'running', provider: 'fixture', model: 'fixture', promptVersion: 'test', schemaVersion: 'test', inputSha256: 'm6-input', startedAt: new Date(Date.now() - 10 * 60_000) } });
    const out = await recoverStaleRuns(db, new Date(), 60_000);
    expect(out.runIds).toContain('m6-run-recovery');
    expect(await db.agentRun.findUnique({ where: { id: 'm6-run-recovery' } })).toMatchObject({ status: 'interrupted', errorCode: 'RUN_INTERRUPTED' });
    expect((await db.intake.findUnique({ where: { id: 'm6-intake-recovery' } }))?.stage).toBe('failed_retryable');
  });

  it('backs up and restores a quiesced SQLite database plus attachments', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'campus-m6-backup-'));
    const storage = path.join(dir, 'uploads'); const backup = path.join(dir, 'snapshot'); const restoredStorage = path.join(dir, 'restored-uploads'); const restoredDb = path.join(dir, 'restored.db').replaceAll('\\', '/');
    await mkdir(storage, { recursive: true }); await writeFile(path.join(storage, 'm6.txt'), 'fixture attachment', 'utf8');
    await db.case.deleteMany({ where: { id: 'm6-case-backup' } });
    await db.case.create({ data: { id: 'm6-case-backup', title: 'backup fixture', category: 'registration' } });
    await expect(createBackup({ databaseUrl: process.env.DATABASE_URL ?? '', storageDirectory: storage, destination: backup })).rejects.toThrowError('BACKUP_REQUIRES_QUIESCENCE');
    const manifest = await createBackup({ databaseUrl: process.env.DATABASE_URL ?? '', storageDirectory: storage, destination: backup, quiesced: true });
    expect(manifest.database.sha256).toHaveLength(64); expect(manifest.attachments.file_count).toBe(1); expect(manifest.attachments.files[0]?.sha256).toHaveLength(64);
    await restoreBackup({ backupDirectory: backup, databaseUrl: `file:${restoredDb}`, storageDirectory: restoredStorage });
    const restored = new PrismaClient({ datasources: { db: { url: `file:${restoredDb}` } } });
    expect(await restored.case.findUnique({ where: { id: 'm6-case-backup' } })).not.toBeNull();
    await restored.$disconnect();
    expect(await readFile(path.join(restoredStorage, 'm6.txt'), 'utf8')).toBe('fixture attachment');
    await writeFile(path.join(backup, 'attachments', 'm6.txt'), 'tampered', 'utf8');
    const rejectedDb = path.join(dir, 'rejected.db').replaceAll('\\', '/');
    await expect(restoreBackup({ backupDirectory: backup, databaseUrl: `file:${rejectedDb}`, storageDirectory: path.join(dir, 'rejected-uploads') })).rejects.toThrowError('BACKUP_CHECKSUM_MISMATCH');
    await db.case.delete({ where: { id: 'm6-case-backup' } });
    await rm(dir, { recursive: true, force: true });
  });

  it('deletes one case explicitly and preserves the confirmation/backup boundary', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'campus-m6-delete-')); const storage = path.join(dir, 'uploads'); await mkdir(storage, { recursive: true }); await writeFile(path.join(storage, 'delete.txt'), 'attachment', 'utf8');
    const text = 'delete notice';
    await db.sourceArtifact.create({ data: { id: ids.artifactId, sha256: 'm6-sha-delete', mediaType: 'text/plain', privateStorageKey: 'delete.txt', originLabel: 'synthetic', size: text.length } });
    await db.textRevision.create({ data: { id: ids.revisionId, sourceId: ids.artifactId, text, method: 'manual' } });
    await db.noticeRevision.create({ data: { id: ids.noticeId, caseId: ids.caseId, textRevisionId: ids.revisionId } });
    await db.case.create({ data: { id: ids.caseId, title: 'delete fixture', category: 'registration' } });
    await db.case.create({ data: { id: 'm6-case-shared', title: 'shared fixture', category: 'registration' } });
    await db.noticeRevision.create({ data: { id: 'm6-notice-shared', caseId: 'm6-case-shared', textRevisionId: ids.revisionId } });
    await db.task.create({ data: { id: ids.taskId, caseId: ids.caseId, title: 'delete task' } });
    await db.evidence.create({ data: { id: ids.evidenceId, sourceId: ids.artifactId, textRevisionId: ids.revisionId, quote: text, start: 0, end: text.length, origin: 'notice' } });
    await db.intake.create({ data: { id: ids.intakeId, text, sourceArtifactId: ids.artifactId, textRevisionId: ids.revisionId } });
    await db.textApproval.create({ data: { id: ids.approvalId, intakeId: ids.intakeId, textRevisionId: ids.revisionId } });
    await expect(deleteCaseData(db, { caseId: ids.caseId, confirmation: true, backupAcknowledged: true })).rejects.toThrowError('VERSION_REQUIRED');
    await expect(deleteCaseData(db, { caseId: ids.caseId, expectedCaseVersion: 1, confirmation: false, backupAcknowledged: true })).rejects.toThrowError('CONFIRMATION_REQUIRED');
    const result = await deleteCaseData(db, { caseId: ids.caseId, expectedCaseVersion: 1, confirmation: true, backupAcknowledged: true });
    await cleanupDeletedCaseFiles(result.storageKeys, storage);
    expect(await db.case.findUnique({ where: { id: ids.caseId } })).toBeNull(); expect(await db.task.findUnique({ where: { id: ids.taskId } })).toBeNull(); expect(await db.sourceArtifact.findUnique({ where: { id: ids.artifactId } })).not.toBeNull(); expect(await readFile(path.join(storage, 'delete.txt'), 'utf8')).toBe('attachment');
    await db.noticeRevision.delete({ where: { id: 'm6-notice-shared' } }); await db.case.delete({ where: { id: 'm6-case-shared' } }); await db.textRevision.delete({ where: { id: ids.revisionId } }); await db.sourceArtifact.delete({ where: { id: ids.artifactId } });
    await rm(dir, { recursive: true, force: true });
  });
});

afterAll(async () => {
  await db.agentRun.deleteMany({ where: { id: { in: ['m6-run-recovery'] } } }); await db.intake.deleteMany({ where: { id: { in: ['m6-intake-recovery'] } } }); await db.sourceArtifact.deleteMany({ where: { id: { in: ['m6-artifact-recovery'] } } }); await db.$disconnect();
});

