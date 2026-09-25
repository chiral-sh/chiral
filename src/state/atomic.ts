import { writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Writes JSON to a unique `${filePath}.<pid>.<random>.tmp` then renames over
// `filePath`, so a crash mid-write cannot leave a truncated target file and
// concurrent writers never share (and torn-interleave) the same tmp file.
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, filePath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw new Error(`Could not write to ${filePath}`);
  }
}
