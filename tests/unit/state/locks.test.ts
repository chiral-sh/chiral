import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import {
  readLock,
  readLockWithExpiry,
  writeLock,
  releaseLock,
  listLocksByEnv,
  listAllLocks,
} from '../../../src/state/locks.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

beforeEach(() => vol.reset());

describe('readLock', () => {
  it('returns null when no lock file exists', () => {
    vol.fromJSON({ '/fd/locks/prod/': null });
    expect(readLock('/fd', 'prod', 'wf-1')).toBeNull();
  });

  it('returns lock data when lock file exists', () => {
    const lock = { version: 1, actor: 'purvesh@example.com', timestamp: '2024-01-01T12:00:00.000Z', hostname: 'mac' };
    vol.fromJSON({ '/fd/locks/prod/wf-1.lock': JSON.stringify(lock) });
    expect(readLock('/fd', 'prod', 'wf-1')).toEqual(lock);
  });

  it('throws UserError when lock file contains invalid JSON', () => {
    vol.fromJSON({ '/fd/locks/prod/wf-1.lock': 'not json' });
    expect(() => readLock('/fd', 'prod', 'wf-1')).toThrow(UserError);
    expect(() => readLock('/fd', 'prod', 'wf-1')).toThrow('corrupted');
  });

  it('throws UserError when lock file has invalid schema', () => {
    vol.fromJSON({ '/fd/locks/prod/wf-1.lock': JSON.stringify({ version: 1, actor: 'not-an-email' }) });
    expect(() => readLock('/fd', 'prod', 'wf-1')).toThrow(UserError);
    expect(() => readLock('/fd', 'prod', 'wf-1')).toThrow('invalid structure');
  });

  it('deletes and returns null for an expired lock', () => {
    const expiredLock = {
      version: 1,
      actor: 'purvesh@example.com',
      timestamp: '2024-01-01T12:00:00.000Z',
      hostname: 'mac',
      expiresAt: '2020-01-01T00:00:00.000Z',
    };
    vol.fromJSON({ '/fd/locks/prod/wf-1.lock': JSON.stringify(expiredLock) });
    expect(readLock('/fd', 'prod', 'wf-1')).toBeNull();
    // File should be deleted
    expect(vol.existsSync('/fd/locks/prod/wf-1.lock')).toBe(false);
  });

  it('returns lock data for a non-expired lock', () => {
    const futureLock = {
      version: 1,
      actor: 'purvesh@example.com',
      timestamp: '2024-01-01T12:00:00.000Z',
      hostname: 'mac',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    vol.fromJSON({ '/fd/locks/prod/wf-1.lock': JSON.stringify(futureLock) });
    const result = readLock('/fd', 'prod', 'wf-1');
    expect(result).not.toBeNull();
    expect(result!.actor).toBe('purvesh@example.com');
  });
});

describe('readLockWithExpiry', () => {
  it('returns { data: null, wasExpired: false } when no file exists', () => {
    vol.fromJSON({ '/fd/': null });
    expect(readLockWithExpiry('/fd', 'prod', 'wf-1')).toEqual({ data: null, wasExpired: false });
  });

  it('returns { data: LockFile, wasExpired: false } for a valid non-expired lock', () => {
    const lock = { version: 1, actor: 'purvesh@example.com', timestamp: '2024-01-01T12:00:00.000Z', hostname: 'mac' };
    vol.fromJSON({ '/fd/locks/prod/wf-1.lock': JSON.stringify(lock) });
    const result = readLockWithExpiry('/fd', 'prod', 'wf-1');
    expect(result.wasExpired).toBe(false);
    expect(result.data).toEqual(lock);
  });

  it('returns { data: null, wasExpired: true } and deletes file for expired lock', () => {
    const expiredLock = {
      version: 1,
      actor: 'purvesh@example.com',
      timestamp: '2024-01-01T12:00:00.000Z',
      hostname: 'mac',
      expiresAt: '2020-01-01T00:00:00.000Z',
    };
    vol.fromJSON({ '/fd/locks/prod/wf-1.lock': JSON.stringify(expiredLock) });
    const result = readLockWithExpiry('/fd', 'prod', 'wf-1');
    expect(result).toEqual({ data: null, wasExpired: true });
    expect(vol.existsSync('/fd/locks/prod/wf-1.lock')).toBe(false);
  });
});

describe('writeLock', () => {
  it('creates locks/<env>/ directory and writes lock file', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    expect(vol.existsSync('/fd/locks/prod/wf-1.lock')).toBe(true);
    const raw = vol.readFileSync('/fd/locks/prod/wf-1.lock', 'utf-8') as string;
    const lock = JSON.parse(raw);
    expect(lock.actor).toBe('purvesh@example.com');
    expect(lock.hostname).toBe('mac');
    expect(lock.version).toBe(1);
    expect(lock.timestamp).toBeDefined();
  });

  it('throws UserError when workflow is already locked', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    expect(() => writeLock('/fd', 'prod', 'wf-1', 'other@example.com', 'other')).toThrow(UserError);
    expect(() => writeLock('/fd', 'prod', 'wf-1', 'other@example.com', 'other')).toThrow(
      'locked by purvesh@example.com',
    );
  });

  it('stores a valid ISO timestamp', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    const lock = readLock('/fd', 'prod', 'wf-1');
    expect(new Date(lock!.timestamp).getTime()).not.toBeNaN();
  });

  it('allows locking different workflows independently', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    writeLock('/fd', 'prod', 'wf-2', 'purvesh@example.com', 'mac');
    expect(readLock('/fd', 'prod', 'wf-1')).not.toBeNull();
    expect(readLock('/fd', 'prod', 'wf-2')).not.toBeNull();
  });

  it('allows same workflow locked in different envs', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    writeLock('/fd', 'staging', 'wf-1', 'other@example.com', 'linux');
    expect(readLock('/fd', 'prod', 'wf-1')!.actor).toBe('purvesh@example.com');
    expect(readLock('/fd', 'staging', 'wf-1')!.actor).toBe('other@example.com');
  });

  it('round-trips reason and snapshotHash fields', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac', {
      reason: 'deploying payment feature',
      snapshotHash: 'abc123',
    });
    const lock = readLock('/fd', 'prod', 'wf-1');
    expect(lock!.reason).toBe('deploying payment feature');
    expect(lock!.snapshotHash).toBe('abc123');
  });

  it('preserves resolved: false flag', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac', { resolved: false });
    const lock = readLock('/fd', 'prod', 'wf-1');
    expect(lock!.resolved).toBe(false);
  });

  it('writes via atomic temp-file-plus-rename (no .tmp file left behind)', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    expect(vol.existsSync('/fd/locks/prod/wf-1.lock.tmp')).toBe(false);
    expect(vol.existsSync('/fd/locks/prod/wf-1.lock')).toBe(true);
  });
});

describe('releaseLock', () => {
  it('deletes the lock file', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    releaseLock('/fd', 'prod', 'wf-1');
    expect(readLock('/fd', 'prod', 'wf-1')).toBeNull();
  });

  it('throws UserError when workflow is not locked', () => {
    vol.fromJSON({ '/fd/locks/prod/': null });
    expect(() => releaseLock('/fd', 'prod', 'wf-1')).toThrow(UserError);
    expect(() => releaseLock('/fd', 'prod', 'wf-1')).toThrow('not locked');
  });

  it('allows re-locking after release', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    releaseLock('/fd', 'prod', 'wf-1');
    expect(() => writeLock('/fd', 'prod', 'wf-1', 'other@example.com', 'other')).not.toThrow();
  });
});

describe('listLocksByEnv', () => {
  it('returns empty array when env locks directory does not exist', () => {
    vol.fromJSON({ '/fd/': null });
    expect(listLocksByEnv('/fd', 'prod')).toEqual([]);
  });

  it('returns all active locks for the given env', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    writeLock('/fd', 'prod', 'wf-2', 'other@example.com', 'linux');
    const locks = listLocksByEnv('/fd', 'prod');
    expect(locks).toHaveLength(2);
    expect(locks.map((l) => l.workflowId).sort()).toEqual(['wf-1', 'wf-2']);
  });

  it('does not return locks from other envs', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    writeLock('/fd', 'staging', 'wf-2', 'other@example.com', 'linux');
    expect(listLocksByEnv('/fd', 'prod')).toHaveLength(1);
    expect(listLocksByEnv('/fd', 'staging')).toHaveLength(1);
  });

  it('ignores files that do not end in .lock', () => {
    vol.fromJSON({
      '/fd/locks/prod/wf-1.lock': JSON.stringify({
        version: 1,
        actor: 'purvesh@example.com',
        timestamp: '2024-01-01T12:00:00.000Z',
        hostname: 'mac',
      }),
      '/fd/locks/prod/.DS_Store': '',
      '/fd/locks/prod/README.md': '',
    });
    expect(listLocksByEnv('/fd', 'prod')).toHaveLength(1);
  });
});

describe('listAllLocks', () => {
  it('returns empty array when locks directory does not exist', () => {
    vol.fromJSON({ '/fd/': null });
    expect(listAllLocks('/fd')).toEqual([]);
  });

  it('returns all locks across multiple envs', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    writeLock('/fd', 'staging', 'wf-2', 'other@example.com', 'linux');
    writeLock('/fd', 'prod', 'wf-3', 'third@example.com', 'win');
    const locks = listAllLocks('/fd');
    expect(locks).toHaveLength(3);
    const prodLocks = locks.filter(l => l.env === 'prod');
    const stagingLocks = locks.filter(l => l.env === 'staging');
    expect(prodLocks).toHaveLength(2);
    expect(stagingLocks).toHaveLength(1);
  });

  it('does not list released locks', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    writeLock('/fd', 'prod', 'wf-2', 'purvesh@example.com', 'mac');
    releaseLock('/fd', 'prod', 'wf-1');
    expect(listAllLocks('/fd')).toHaveLength(1);
  });

  it('includes env field in each entry', () => {
    vol.fromJSON({ '/fd/': null });
    writeLock('/fd', 'prod', 'wf-1', 'purvesh@example.com', 'mac');
    const locks = listAllLocks('/fd');
    expect(locks[0].env).toBe('prod');
    expect(locks[0].workflowId).toBe('wf-1');
  });
});
