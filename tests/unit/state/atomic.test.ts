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

  it('leaves previous file contents intact when renameSync throws', () => {
    vol.fromJSON({ '/repo/data.json': JSON.stringify({ existing: true }, null, 2) + '\n' }, '/');

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => writeJsonAtomic('/repo/data.json', { existing: false })).toThrow(Error);
    expect(JSON.parse(vol.readFileSync('/repo/data.json', 'utf-8') as string)).toEqual({
      existing: true,
    });

    renameSpy.mockRestore();
  });

  it('throws plain Error (not UserError) when writeFileSync throws', () => {
    vol.mkdirSync('/repo', { recursive: true });

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    let thrown: unknown;
    try {
      writeJsonAtomic('/repo/data.json', { x: 1 });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UserError);
    writeSpy.mockRestore();
  });

  it('throws plain Error (not UserError) when renameSync throws, and cleans up tmp', () => {
    vol.mkdirSync('/repo', { recursive: true });

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    let thrown: unknown;
    try {
      writeJsonAtomic('/repo/data.json', { x: 1 });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UserError);

    const entries = vol.readdirSync('/repo') as string[];
    expect(entries.every((name) => !name.endsWith('.tmp'))).toBe(true);

    renameSpy.mockRestore();
  });

  it('uses a distinct tmp path per call (uniqueness)', () => {
    vol.mkdirSync('/repo', { recursive: true });

    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    writeJsonAtomic('/repo/a.json', { n: 1 });
    writeJsonAtomic('/repo/a.json', { n: 2 });

    const tmpPaths = writeSpy.mock.calls.map((call) => call[0] as string);
    expect(tmpPaths[0]).not.toEqual(tmpPaths[1]);
    expect(tmpPaths[0]).toMatch(/^\/repo\/a\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
    expect(tmpPaths[1]).toMatch(/^\/repo\/a\.json\.\d+\.[0-9a-f]{12}\.tmp$/);

    writeSpy.mockRestore();
  });

  // In-process tests cannot fully model two separate OS processes racing on
  // the same target. What's verified here is the guarantee that actually
  // matters: each writer's tmp path is unique (so writers never interleave
  // bytes into a shared tmp file), and `renameSync` is atomic, so the target
  // always ends up as exactly one writer's complete payload, never a torn
  // mix of both. Last-writer-wins arbitration between processes is out of
  // scope (see plan Assumptions / S5).
  it('interleaved concurrent writers never produce a torn target file', () => {
    vol.mkdirSync('/repo', { recursive: true });

    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    let firstCall = true;
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
        const result = originalWriteFileSync(...args);
        if (firstCall) {
          // Simulate a second writer completing its entire write+rename
          // while the first writer is still mid-flight (between its write
          // and its rename), using a different tmp path.
          firstCall = false;
          writeJsonAtomic('/repo/data.json', { writer: 'second' });
        }
        return result;
      });

    writeJsonAtomic('/repo/data.json', { writer: 'first' });

    writeSpy.mockRestore();

    // Whichever writer renamed last "wins", but the target must always be
    // exactly one complete payload — never a byte-level mix of both.
    const final = JSON.parse(vol.readFileSync('/repo/data.json', 'utf-8') as string);
    expect(['first', 'second']).toContain(final.writer);
    expect(vol.existsSync('/repo/data.json')).toBe(true);

    // No leftover tmp files from either writer.
    const entries = vol.readdirSync('/repo') as string[];
    expect(entries.every((name) => !name.endsWith('.tmp'))).toBe(true);
  });
});
