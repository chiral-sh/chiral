import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

export const AuditActionSchema = z.enum([
  'push',
  'pull',
  'diff',
  'rollback',
  'lock',
  'unlock',
  'adopt',
  'init',
  'map',
  'unmap',
]);

export const AuditEntrySchema = z.object({
  event_id: z.guid(),
  event_schema_version: z.literal(1),
  timestamp: z.string().datetime(),
  actor: z.email(),
  action: AuditActionSchema,
  project: z.string(),
  source_env: z.string().nullable(),
  target_env: z.string(),
  workflow_ids: z.array(z.string()),
  result: z.enum(['success', 'failure', 'aborted', 'partial']),
  error: z.string().nullable(),
  chiral_version: z.string(),
  match_method: z.enum(['manual', 'auto', 'exact', 'fuzzy']).nullable().optional(),
  match_score: z.number().min(0).max(1).nullable().optional(),
  resource: z.enum(['workflow', 'credential', 'table']).optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditAction = z.infer<typeof AuditActionSchema>;

// Appends are atomic under POSIX O_APPEND only for writes <= PIPE_BUF (4096
// bytes on Linux). A serialized entry with a large `workflow_ids` array can
// exceed this, so concurrent multi-process appends are not guaranteed
// non-interleaving for large entries. No advisory lock is taken (deferred).
export function writeAuditEntry(chiralDir: string, entry: AuditEntry): void {
  const auditPath = join(chiralDir, 'audit.jsonl');
  const line = JSON.stringify(entry) + '\n';
  try {
    appendFileSync(auditPath, line, 'utf-8');
  } catch {
    throw new UserError(`Could not write to audit log at ${auditPath}`);
  }
}

// Tracks audit log paths that have already produced a skip-count warning in
// this process, so repeated reads (status/log/push) don't re-warn for the
// same malformed line(s).
const warnedSkipPaths = new Set<string>();

export function readAuditLog(chiralDir: string): AuditEntry[] {
  const auditPath = join(chiralDir, 'audit.jsonl');
  if (!existsSync(auditPath)) return [];

  const lines = readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '');

  const entries: AuditEntry[] = [];
  let skipped = 0;

  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const result = AuditEntrySchema.safeParse(raw);
    if (!result.success) {
      skipped++;
      continue;
    }
    entries.push(result.data);
  }

  if (skipped > 0 && !warnedSkipPaths.has(auditPath)) {
    warnedSkipPaths.add(auditPath);
    console.error(`Warning: skipped ${skipped} malformed line(s) in audit.jsonl`);
  }

  return entries;
}

export function readInitEvent(chiralDir: string): { actor: string; timestamp: string } | null {
  const auditPath = join(chiralDir, 'audit.jsonl');
  if (!existsSync(auditPath)) return null;

  let content: string;
  try {
    content = readFileSync(auditPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n').filter((line) => line.trim() !== '');
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // silently skip malformed JSON lines
      continue;
    }
    if (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as Record<string, unknown>)['action'] === 'init' &&
      typeof (raw as Record<string, unknown>)['actor'] === 'string' &&
      typeof (raw as Record<string, unknown>)['timestamp'] === 'string'
    ) {
      return {
        actor: (raw as Record<string, unknown>)['actor'] as string,
        timestamp: (raw as Record<string, unknown>)['timestamp'] as string,
      };
    }
  }
  return null;
}
