import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  readdirSync,
  renameSync,
} from 'node:fs';
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

export function readLock(chiralDir: string, envId: string, workflowId: string): LockFile | null {
  const filePath = lockPath(chiralDir, envId, workflowId);
  if (!existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
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

export function readLockWithExpiry(
  chiralDir: string,
  envId: string,
  workflowId: string,
): { data: LockFile | null; wasExpired: boolean } {
  const filePath = lockPath(chiralDir, envId, workflowId);
  if (!existsSync(filePath)) return { data: null, wasExpired: false };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    throw new UserError(`Lock file is corrupted: ${filePath}`);
  }
  const result = LockFileSchema.safeParse(raw);
  if (!result.success) {
    throw new UserError(`Lock file has invalid structure: ${filePath}`);
  }

  if (result.data.expiresAt && new Date(result.data.expiresAt).getTime() < Date.now()) {
    try { unlinkSync(filePath); } catch { /* already gone */ }
    return { data: null, wasExpired: true };
  }

  return { data: result.data, wasExpired: false };
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
  const tmpPath = `${finalPath}.tmp`;

  try {
    mkdirSync(locksEnvDir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(lock, null, 2), 'utf-8');
    renameSync(tmpPath, finalPath);
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`Could not write lock file for workflow "${workflowId}"`);
  }
}

export function releaseLock(chiralDir: string, envId: string, workflowId: string): void {
  const filePath = lockPath(chiralDir, envId, workflowId);
  if (!existsSync(filePath)) {
    throw new UserError(`Workflow "${workflowId}" is not locked`);
  }
  try {
    unlinkSync(filePath);
  } catch {
    throw new UserError(`Could not release lock for workflow "${workflowId}"`);
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
      const lock = readLock(chiralDir, envId, workflowId);
      return lock ? { workflowId, lock } : null;
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
