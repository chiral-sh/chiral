import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import * as fs from 'node:fs';
import { writeJsonAtomic } from '../../../src/state/atomic.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

beforeEach(() => {
  vol.reset();
});

describe('writeJsonAtomic', () => {
  it('writes the final file with serialized JSON and leaves no .tmp file', () => {
    vol.mkdirSync('/repo', { recursive: true });

    writeJsonAtomic('/repo/data.json', { hello: 'world' });

    expect(JSON.parse(vol.readFileSync('/repo/data.json', 'utf-8') as string)).toEqual({
      hello: 'world',
    });
    expect(vol.existsSync('/repo/data.tmp.json')).toBe(false);
    expect(vol.existsSync('/repo/data.json.tmp')).toBe(false);
  });

  it('leaves previous file contents intact when the write throws', () => {
    vol.fromJSON({ '/repo/data.json': JSON.stringify({ existing: true }, null, 2) + '\n' }, '/');

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => writeJsonAtomic('/repo/data.json', { existing: false })).toThrow(UserError);
    expect(JSON.parse(vol.readFileSync('/repo/data.json', 'utf-8') as string)).toEqual({
      existing: true,
    });

    renameSpy.mockRestore();
  });
});
