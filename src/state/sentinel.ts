import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function writeStatusSentinel(chiralDir: string): void {
  const stateFile = join(chiralDir, 'state.json');
  const tmpFile = stateFile + '.tmp';
  const content = JSON.stringify({ last_status_at: new Date().toISOString() });
  writeFileSync(tmpFile, content, 'utf-8');
  renameSync(tmpFile, stateFile);
}

export function readStatusSentinel(chiralDir: string): { last_status_at: string } | null {
  const stateFile = join(chiralDir, 'state.json');
  if (!existsSync(stateFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
    return typeof raw['last_status_at'] === 'string' ? { last_status_at: raw['last_status_at'] } : null;
  } catch {
    return null;
  }
}
