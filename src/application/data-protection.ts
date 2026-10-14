import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_UPLOAD_ROOT = path.resolve(process.cwd(), 'data', 'uploads');
const SAFE_STRING_KEY = /^(run_id|request_id|status|stage|code|error_code|provider|model|kind|failure_stage)$/i;

export class DataProtectionError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Reject cross-origin writes while allowing same-origin requests and local CLI calls. */
export function assertLocalOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  let originUrl: URL;
  let requestUrl: URL;
  try {
    originUrl = new URL(origin);
    requestUrl = new URL(request.url);
  } catch {
    throw new DataProtectionError('ORIGIN_FORBIDDEN');
  }
  if (originUrl.origin === requestUrl.origin) return;
  const loopback = new Set(['localhost', '127.0.0.1', '::1']);
  const normalizeHost = (host: string) => host.replace(/^\[|\]$/g, '').toLowerCase();
  if (loopback.has(normalizeHost(originUrl.hostname)) && loopback.has(normalizeHost(requestUrl.hostname)) && originUrl.port === requestUrl.port) return;
  throw new DataProtectionError('ORIGIN_FORBIDDEN');
}

export function assertStorageKey(storageKey: string, root = DEFAULT_UPLOAD_ROOT): string {
  if (!storageKey || storageKey.includes('\0') || path.isAbsolute(storageKey)) throw new DataProtectionError('STORAGE_KEY_INVALID');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, storageKey);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new DataProtectionError('STORAGE_KEY_INVALID');
  return target;
}

export function validateImageUpload(bytes: Uint8Array, mediaType: string, maxBytes = 10 * 1024 * 1024): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes.byteLength > maxBytes) throw new DataProtectionError('PAYLOAD_TOO_LARGE');
  const isPng = mediaType === 'image/png' && bytes.byteLength >= PNG_SIGNATURE.length && Buffer.from(bytes.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE);
  const isJpeg = mediaType === 'image/jpeg' && bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) throw new DataProtectionError('UNSUPPORTED_MEDIA');
}

/** Keep IDs, counts and stable codes; never carry arbitrary text into traces. */
export function redactTrace(value: unknown, depth = 0, key = ''): unknown {
  if (depth > 4) return '[redacted-depth]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return SAFE_STRING_KEY.test(key) ? value : `[redacted:${value.length}]`;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => redactTrace(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, item] of Object.entries(value)) out[childKey] = redactTrace(item, depth + 1, childKey);
    return out;
  }
  return '[redacted]';
}

export function stableRunErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'MODEL_UNAVAILABLE';
}

export async function recoverStaleRuns(db: PrismaClient, now = new Date(), leaseMs = 5 * 60_000): Promise<{ runIds: string[]; count: number }> {
  if (!Number.isFinite(leaseMs) || leaseMs < 1_000) throw new DataProtectionError('INVALID_RUN_LEASE');
  const cutoff = new Date(now.getTime() - leaseMs);
  const stale = await db.agentRun.findMany({ where: { status: 'running', startedAt: { lt: cutoff } }, select: { id: true, intakeId: true } });
  if (!stale.length) return { runIds: [], count: 0 };
  const result = await db.$transaction(async (tx) => {
    const updated = await tx.agentRun.updateMany({
      where: { id: { in: stale.map((run) => run.id) }, status: 'running' },
      data: { status: 'interrupted', finishedAt: now, errorCode: 'RUN_INTERRUPTED', safeError: '进程中断，草稿已保留，可手动重试' },
    });
    const intakeIds = [...new Set(stale.map((run) => run.intakeId).filter((id): id is string => Boolean(id)))];
    if (intakeIds.length) await tx.intake.updateMany({ where: { id: { in: intakeIds }, stage: { in: ['recognizing', 'extracting'] } }, data: { stage: 'failed_retryable' } });
    return updated.count;
  });
  return { runIds: stale.map((run) => run.id), count: result };
}

function sqlitePath(databaseUrl: string, cwd = process.cwd()): string {
  if (!databaseUrl.startsWith('file:')) throw new DataProtectionError('DATABASE_URL_UNSUPPORTED');
  const raw = databaseUrl.slice(5).split('?')[0];
  if (!raw || raw === ':memory:') throw new DataProtectionError('DATABASE_URL_UNSUPPORTED');
  const decoded = decodeURIComponent(raw);
  // Prisma resolves relative SQLite URLs against the schema directory, not process.cwd().
  return path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(cwd, 'prisma', decoded);
}

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export type BackupManifest = {
  schema_version: 'm6-backup.2';
  created_at: string;
  quiescence: 'caller_stopped_writes';
  database: { file: string; bytes: number; sha256: string };
  attachments: { file_count: number; files: Array<{ key: string; bytes: number; sha256: string }> };
};

type FileEntry = { key: string; path: string; bytes: number; sha256: string };

async function listFiles(root: string, current = root): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) entries.push(...await listFiles(root, fullPath));
    else if (entry.isFile()) {
      const key = path.relative(root, fullPath).split(path.sep).join('/');
      const file = await stat(fullPath);
      entries.push({ key, path: fullPath, bytes: file.size, sha256: await sha256File(fullPath) });
    }
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

/** Create a self-contained snapshot directory. The caller must stop writes first. */
export async function createBackup(options: { databaseUrl: string; storageDirectory: string; destination: string; quiesced?: boolean }): Promise<BackupManifest> {
  if (options.quiesced !== true) throw new DataProtectionError('BACKUP_REQUIRES_QUIESCENCE');
  const dbPath = sqlitePath(options.databaseUrl);
  const storage = path.resolve(options.storageDirectory);
  const destination = path.resolve(options.destination);
  if (destination === storage || destination.startsWith(`${storage}${path.sep}`)) throw new DataProtectionError('BACKUP_DESTINATION_INVALID');
  await stat(dbPath);
  const checkpointDb = new PrismaClient({ datasources: { db: { url: options.databaseUrl } } });
  try { await checkpointDb.$queryRawUnsafe('PRAGMA wal_checkpoint(FULL)'); } finally { await checkpointDb.$disconnect(); }
  await mkdir(destination, { recursive: false });
  await copyFile(dbPath, path.join(destination, 'database.sqlite'));
  const attachmentTarget = path.join(destination, 'attachments');
  await mkdir(attachmentTarget, { recursive: true });
  let files: FileEntry[] = [];
  try {
    files = await listFiles(storage);
    for (const file of files) {
      assertStorageKey(file.key, storage);
      const destination = path.join(attachmentTarget, file.key);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file.path, destination);
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  const dbStat = await stat(path.join(destination, 'database.sqlite'));
  const manifest: BackupManifest = { schema_version: 'm6-backup.2', created_at: new Date().toISOString(), quiescence: 'caller_stopped_writes', database: { file: 'database.sqlite', bytes: dbStat.size, sha256: await sha256File(path.join(destination, 'database.sqlite')) }, attachments: { file_count: files.length, files: files.map(({ key, bytes, sha256 }) => ({ key, bytes, sha256 })) } };
  await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Restore a snapshot into an empty/explicitly replaceable local data directory. */
export async function restoreBackup(options: { backupDirectory: string; databaseUrl: string; storageDirectory: string; replace?: boolean }): Promise<BackupManifest> {
  const source = path.resolve(options.backupDirectory);
  let manifest: BackupManifest;
  try { manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8')) as BackupManifest; } catch { throw new DataProtectionError('BACKUP_INVALID'); }
  if (manifest.schema_version !== 'm6-backup.2' || manifest.quiescence !== 'caller_stopped_writes' || manifest.database.file !== 'database.sqlite' || !Array.isArray(manifest.attachments?.files) || manifest.attachments.file_count !== manifest.attachments.files.length) throw new DataProtectionError('BACKUP_INVALID');
  const sourceDb = path.join(source, 'database.sqlite');
  const sourceAttachmentRoot = path.join(source, 'attachments');
  if (manifest.database.bytes !== (await stat(sourceDb)).size || manifest.database.sha256 !== await sha256File(sourceDb)) throw new DataProtectionError('BACKUP_CHECKSUM_MISMATCH');
  const expectedKeys = new Set<string>();
  for (const file of manifest.attachments.files) {
    if (!file || typeof file.key !== 'string' || expectedKeys.has(file.key) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new DataProtectionError('BACKUP_INVALID');
    expectedKeys.add(file.key);
    const filePath = assertStorageKey(file.key, sourceAttachmentRoot);
    let sourceStat;
    try { sourceStat = await stat(filePath); } catch { throw new DataProtectionError('BACKUP_ATTACHMENT_MISSING'); }
    if (!sourceStat.isFile() || sourceStat.size !== file.bytes || file.sha256 !== await sha256File(filePath)) throw new DataProtectionError('BACKUP_CHECKSUM_MISMATCH');
  }
  let actualFiles: FileEntry[];
  try { actualFiles = await listFiles(sourceAttachmentRoot); } catch { throw new DataProtectionError('BACKUP_INVALID'); }
  if (actualFiles.length !== expectedKeys.size || actualFiles.some((file) => !expectedKeys.has(file.key))) throw new DataProtectionError('BACKUP_INVALID');
  const targetDb = sqlitePath(options.databaseUrl);
  const storage = path.resolve(options.storageDirectory);
  await mkdir(path.dirname(targetDb), { recursive: true });
  await mkdir(storage, { recursive: true });
  if (!options.replace) {
    try { await stat(targetDb); throw new DataProtectionError('RESTORE_TARGET_EXISTS'); } catch (error) { if (!(error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT')) throw error; }
  }
  const tempRoot = await mkdtemp(path.join(path.dirname(targetDb), '.m6-restore-'));
  const tempDb = path.join(tempRoot, 'database.sqlite');
  const tempStorage = path.join(tempRoot, 'attachments');
  try {
    await copyFile(sourceDb, tempDb);
    await mkdir(tempStorage, { recursive: true });
    for (const file of manifest.attachments.files) {
      const target = assertStorageKey(file.key, tempStorage);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(sourceAttachmentRoot, file.key), target);
    }
    if (!options.replace) {
      const existingFiles = await listFiles(storage);
      if (existingFiles.length) throw new DataProtectionError('RESTORE_TARGET_EXISTS');
    } else {
      await rm(storage, { recursive: true, force: true });
      await rm(targetDb, { force: true });
    }
    await rename(tempDb, targetDb);
    await rm(storage, { recursive: true, force: true });
    await rename(tempStorage, storage);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  return manifest;
}

export async function removeStorageKey(storageKey: string, storageDirectory = DEFAULT_UPLOAD_ROOT): Promise<void> {
  await rm(assertStorageKey(storageKey, storageDirectory), { force: true });
}

