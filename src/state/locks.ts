import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  readdirSync,
  linkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

export const LockFileSchema = z.object({
  version: z.literal(1),
  actor: z.email(),
  timestamp: z.string().datetime(),
  hostname: z.string(),
  reason: z.string().optional(),
  snapshotHash: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  resolved: z.boolean().optional(),
});

export type LockFile = z.infer<typeof LockFileSchema>;

function lockPath(chiralDir: string, envId: string, workflowId: string): string {
  return join(chiralDir, 'locks', envId, `${workflowId}.lock`);
}

// Shared read/parse/expiry logic. Callers must guard with existsSync before calling.
// Returns null only when the file was expired and deleted; throws UserError for corrupt/invalid.
function readLockFile(filePath: string): LockFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    throw new UserError(`Lock file is corrupted: ${filePath}`);
  }
  const result = LockFileSchema.safeParse(raw);
  if (!result.success) {
    throw new UserError(`Lock file has invalid structure: ${filePath}`);
  }

  // Lazy expiry: if expiresAt is in the past, delete file and return null
  if (result.data.expiresAt && new Date(result.data.expiresAt).getTime() < Date.now()) {
    try { unlinkSync(filePath); } catch { /* already gone */ }
    return null;
  }

  return result.data;
}

export function readLock(chiralDir: string, envId: string, workflowId: string): LockFile | null {
  const filePath = lockPath(chiralDir, envId, workflowId);
  if (!existsSync(filePath)) return null;
  return readLockFile(filePath);
}

export function readLockWithExpiry(
  chiralDir: string,
  envId: string,
  workflowId: string,
): { data: LockFile | null; wasExpired: boolean } {
  const filePath = lockPath(chiralDir, envId, workflowId);
  if (!existsSync(filePath)) return { data: null, wasExpired: false };

  const data = readLockFile(filePath);
  // readLockFile returns null only when it deleted the file due to expiry
  if (data === null) return { data: null, wasExpired: true };
  return { data, wasExpired: false };
}

export interface WriteLockOptions {
  reason?: string;
  snapshotHash?: string;
  expiresAt?: string;
  resolved?: boolean;
}

export function writeLock(
  chiralDir: string,
  envId: string,
  workflowId: string,
  actor: string,
  hostname: string,
  options: WriteLockOptions = {},
): void {
  const existing = readLock(chiralDir, envId, workflowId);
  if (existing) {
    throw new UserError(
      `Workflow "${workflowId}" is locked by ${existing.actor} since ${existing.timestamp}`,
    );
  }

  const locksEnvDir = join(chiralDir, 'locks', envId);
  const lock: LockFile = {
    version: 1,
    actor,
    timestamp: new Date().toISOString(),
    hostname,
    ...(options.reason !== undefined && { reason: options.reason }),
    ...(options.snapshotHash !== undefined && { snapshotHash: options.snapshotHash }),
    ...(options.expiresAt !== undefined && { expiresAt: options.expiresAt }),
    ...(options.resolved !== undefined && { resolved: options.resolved }),
  };

  const finalPath = lockPath(chiralDir, envId, workflowId);
  const tmpPath = `${finalPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

  mkdirSync(locksEnvDir, { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(lock, null, 2), 'utf-8');
  try {
    linkSync(tmpPath, finalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      const holder = readLock(chiralDir, envId, workflowId);
      if (holder) {
        throw new UserError(
          `Workflow "${workflowId}" is locked by ${holder.actor} since ${holder.timestamp}`,
        );
      }
      throw new UserError(`Workflow "${workflowId}" is locked (holder information unavailable)`);
    }
    throw new Error(`Could not write lock file for workflow "${workflowId}": ${String(err)}`, { cause: err });
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
  }
}

export function releaseLock(chiralDir: string, envId: string, workflowId: string): void {
  const filePath = lockPath(chiralDir, envId, workflowId);
  if (!existsSync(filePath)) {
    throw new UserError(`Workflow "${workflowId}" is not locked`);
  }
  try {
    unlinkSync(filePath);
  } catch (err) {
    throw new Error(`Could not release lock for workflow "${workflowId}": ${String(err)}`, { cause: err });
  }
}

export function listLocksByEnv(
  chiralDir: string,
  envId: string,
): Array<{ workflowId: string; lock: LockFile }> {
  const locksEnvDir = join(chiralDir, 'locks', envId);
  if (!existsSync(locksEnvDir)) return [];

  return readdirSync(locksEnvDir)
    .filter((f) => f.endsWith('.lock'))
    .map((f) => {
      const workflowId = f.replace(/\.lock$/, '');
      try {
        const lock = readLockFile(join(locksEnvDir, f));
        return lock ? { workflowId, lock } : null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    })
    .filter((entry): entry is { workflowId: string; lock: LockFile } => entry !== null);
}

export function listAllLocks(
  chiralDir: string,
): Array<{ envId: string; workflowId: string; lock: LockFile }> {
  const locksDir = join(chiralDir, 'locks');
  if (!existsSync(locksDir)) return [];

  const results: Array<{ envId: string; workflowId: string; lock: LockFile }> = [];
  for (const entry of readdirSync(locksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const envId = entry.name;
    for (const { workflowId, lock } of listLocksByEnv(chiralDir, envId)) {
      results.push({ envId, workflowId, lock });
    }
  }
  return results;
}
