import { writeFileSync, renameSync } from 'node:fs';
import { UserError } from '../lib/errors.js';

// Writes JSON to `${filePath}.tmp` then renames over `filePath`, so a crash
// mid-write cannot leave a truncated target file.
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, filePath);
  } catch {
    throw new UserError(`Could not write to ${filePath}`);
  }
}
