import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import {
  readLock,
  writeLock,
  releaseLock,
  listLocks,
} from '../../../src/state/locks.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

beforeEach(() => vol.reset());

describe('readLock', () => {
  it('returns null when no lock file exists', () => {
    vol.fromJSON({ '/fd/locks/': null });
    expect(readLock('/fd', 'wf-1')).toBeNull();
  });

  it('returns lock data when lock file exists', () => {
    const lock = { actor: 'purvesh@example.com', timestamp: '2024-01-01T12:00:00.000Z', hostname: 'mac' };
    vol.fromJSON({ '/fd/locks/wf-1.lock': JSON.stringify(lock) });
    expect(readLock('/fd', 'wf-1')).toEqual(lock);
  });

  it('throws UserError when lock file contains invalid JSON', () => {
    vol.fromJSON({ '/fd/locks/wf-1.lock': 'not json' });
    expect(() => readLock('/fd', 'wf-1')).toThrow(UserError);
    expect(() => readLock('/fd', 'wf-1')).toThrow('corrupted');
  });

  it('throws UserError when lock file has invalid schema', () => {
    vol.fromJSON({ '/fd/locks/wf-1.lock': JSON.stringify({ actor: 'not-an-email' }) });
    expect(() => readLock('/fd', 'wf-1')).toThrow(UserError);
    expect(() => readLock('/fd', 'wf-1')).toThrow('invalid structure');
  });
});

describe('writeLock', () => {
  it('creates locks directory and writes lock file', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'wf-1', 'purvesh@example.com', 'mac');
    const raw = vol.readFileSync('/fd/locks/wf-1.lock', 'utf-8') as string;
    const lock = JSON.parse(raw);
    expect(lock.actor).toBe('purvesh@example.com');
    expect(lock.hostname).toBe('mac');
    expect(lock.timestamp).toBeDefined();
  });

  it('throws UserError when workflow is already locked', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'wf-1', 'purvesh@example.com', 'mac');
    expect(() => writeLock('/fd', 'wf-1', 'other@example.com', 'other')).toThrow(UserError);
    expect(() => writeLock('/fd', 'wf-1', 'other@example.com', 'other')).toThrow(
      'locked by purvesh@example.com',
    );
  });

  it('stores a valid ISO timestamp', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'wf-1', 'purvesh@example.com', 'mac');
    const lock = readLock('/fd', 'wf-1');
    expect(new Date(lock!.timestamp).getTime()).not.toBeNaN();
  });

  it('allows locking different workflows independently', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'wf-1', 'purvesh@example.com', 'mac');
    writeLock('/fd', 'wf-2', 'purvesh@example.com', 'mac');
    expect(readLock('/fd', 'wf-1')).not.toBeNull();
    expect(readLock('/fd', 'wf-2')).not.toBeNull();
  });
});

describe('releaseLock', () => {
  it('deletes the lock file', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'wf-1', 'purvesh@example.com', 'mac');
    releaseLock('/fd', 'wf-1');
    expect(readLock('/fd', 'wf-1')).toBeNull();
  });

  it('throws UserError when workflow is not locked', () => {
    vol.fromJSON({ '/fd/locks/': null });
    expect(() => releaseLock('/fd', 'wf-1')).toThrow(UserError);
    expect(() => releaseLock('/fd', 'wf-1')).toThrow('not locked');
  });

  it('allows re-locking after release', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'wf-1', 'purvesh@example.com', 'mac');
    releaseLock('/fd', 'wf-1');
    expect(() => writeLock('/fd', 'wf-1', 'other@example.com', 'other')).not.toThrow();
  });
});

describe('listLocks', () => {
  it('returns empty array when locks directory does not exist', () => {
    vol.fromJSON({ '/fd/': null });
    expect(listLocks('/fd')).toEqual([]);
  });

  it('returns all active locks with their data', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'wf-1', 'purvesh@example.com', 'mac');
    writeLock('/fd', 'wf-2', 'other@example.com', 'linux');
    const locks = listLocks('/fd');
    expect(locks).toHaveLength(2);
    expect(locks.map((l) => l.workflowId).sort()).toEqual(['wf-1', 'wf-2']);
  });

  it('does not list released locks', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'wf-1', 'purvesh@example.com', 'mac');
    writeLock('/fd', 'wf-2', 'purvesh@example.com', 'mac');
    releaseLock('/fd', 'wf-1');
    const locks = listLocks('/fd');
    expect(locks).toHaveLength(1);
    expect(locks[0].workflowId).toBe('wf-2');
  });

  it('ignores files that do not end in .lock', () => {
    vol.fromJSON({
      '/fd/locks/wf-1.lock': JSON.stringify({
        actor: 'purvesh@example.com',
        timestamp: '2024-01-01T12:00:00.000Z',
        hostname: 'mac',
      }),
      '/fd/locks/.DS_Store': '',
      '/fd/locks/README.md': '',
    });
    expect(listLocks('/fd')).toHaveLength(1);
  });
});
