import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

export const AuditActionSchema = z.enum([
  'push',
  'pull',
  'rollback',
  'lock',
  'unlock',
  'adopt',
  'init',
]);

export const AuditEntrySchema = z.object({
  event_id: z.string().uuid(),
  event_schema_version: z.literal(1),
  timestamp: z.string().datetime(),
  actor: z.string().email(),
  action: AuditActionSchema,
  project: z.string(),
  source_env: z.string().nullable(),
  target_env: z.string(),
  workflow_ids: z.array(z.string()),
  result: z.enum(['success', 'failure', 'aborted']),
  error: z.string().nullable(),
  flightdeck_version: z.string(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditAction = z.infer<typeof AuditActionSchema>;

export function writeAuditEntry(flightdeckDir: string, entry: AuditEntry): void {
  const auditPath = join(flightdeckDir, 'audit.jsonl');
  const line = JSON.stringify(entry) + '\n';
  try {
    appendFileSync(auditPath, line, 'utf-8');
  } catch {
    throw new UserError(`Could not write to audit log at ${auditPath}`);
  }
}

export function readAuditLog(flightdeckDir: string): AuditEntry[] {
  const auditPath = join(flightdeckDir, 'audit.jsonl');
  if (!existsSync(auditPath)) return [];

  const lines = readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '');

  return lines.map((line, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new UserError(`audit.jsonl is corrupted at line ${index + 1}`);
    }
    const result = AuditEntrySchema.safeParse(raw);
    if (!result.success) {
      throw new UserError(`audit.jsonl has invalid entry at line ${index + 1}`);
    }
    return result.data;
  });
}
