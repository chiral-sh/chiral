import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

export const LockFileSchema = z.object({
  actor: z.email(),
  timestamp: z.string().datetime(),
  hostname: z.string(),
});

export type LockFile = z.infer<typeof LockFileSchema>;

function lockPath(chiralDir: string, workflowId: string): string {
  return join(chiralDir, 'locks', `${workflowId}.lock`);
}

export function readLock(chiralDir: string, workflowId: string): LockFile | null {
  const filePath = lockPath(chiralDir, workflowId);
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
  return result.data;
}

export function writeLock(
  chiralDir: string,
  workflowId: string,
  actor: string,
  hostname: string,
): void {
  const existing = readLock(chiralDir, workflowId);
  if (existing) {
    throw new UserError(
      `Workflow "${workflowId}" is locked by ${existing.actor} since ${existing.timestamp}`,
    );
  }

  const locksDir = join(chiralDir, 'locks');
  const lock: LockFile = { actor, timestamp: new Date().toISOString(), hostname };

  try {
    mkdirSync(locksDir, { recursive: true });
    writeFileSync(lockPath(chiralDir, workflowId), JSON.stringify(lock, null, 2), 'utf-8');
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`Could not write lock file for workflow "${workflowId}"`);
  }
}

export function releaseLock(chiralDir: string, workflowId: string): void {
  const filePath = lockPath(chiralDir, workflowId);
  if (!existsSync(filePath)) {
    throw new UserError(`Workflow "${workflowId}" is not locked`);
  }
  try {
    unlinkSync(filePath);
  } catch {
    throw new UserError(`Could not release lock for workflow "${workflowId}"`);
  }
}

export function listLocks(chiralDir: string): Array<{ workflowId: string; lock: LockFile }> {
  const locksDir = join(chiralDir, 'locks');
  if (!existsSync(locksDir)) return [];

  return readdirSync(locksDir)
    .filter((f) => f.endsWith('.lock'))
    .map((f) => {
      const workflowId = f.replace(/\.lock$/, '');
      const lock = readLock(chiralDir, workflowId);
      return lock ? { workflowId, lock } : null;
    })
    .filter((entry): entry is { workflowId: string; lock: LockFile } => entry !== null);
}
