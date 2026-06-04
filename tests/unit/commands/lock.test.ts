import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { UserError, ControlledExit } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  hostname: vi.fn().mockReturnValue('test-host'),
}));

vi.mock('../../../src/lib/git-sync.js', () => ({
  syncToRemote: vi.fn().mockResolvedValue({ skipped: true }),
  formatSyncSuccess: vi.fn().mockReturnValue(''),
  formatSyncFailure: vi.fn().mockReturnValue([]),
}));

import { execSync } from 'node:child_process';
import { runLockClaim, runLockList, runUnlock } from '../../../src/commands/lock.js';

const mockExecSync = vi.mocked(execSync);
const { syncToRemote } = await import('../../../src/lib/git-sync.js');
const mockSyncToRemote = vi.mocked(syncToRemote);

const GLOBAL_DIR = '/mock-global';
const PROJECT_DIR = '/project';

const INDEX = JSON.stringify({
  version: 1,
  projects: { 'test-project': { path: PROJECT_DIR, createdAt: '2024-01-01T00:00:00.000Z' } },
});

const VALID_CONFIG = JSON.stringify({
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'key-dev' },
    prod: { url: 'https://prod.n8n.example.com', apiKey: 'key-prod' },
  },
});

const WORKFLOWS_WITH_ID = JSON.stringify({
  version: 1,
  workflows: {
    'order-processor': {
      dev: { name: 'Order Processor', id: 'wf-abc123' },
      prod: { name: 'Order Processor', id: 'wf-abc123' },
    },
  },
});

const EMPTY_WORKFLOWS = JSON.stringify({ version: 1, workflows: {} });

const DEV_ENV_ID = 'dev00001';
const PROD_ENV_ID = 'prd00001';

const VALID_ENVS = JSON.stringify({ version: 1, envs: { dev: DEV_ENV_ID, prod: PROD_ENV_ID } });

function setupBase(workflowsContent = EMPTY_WORKFLOWS) {
  vol.fromJSON({
    [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
    [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
    [`${PROJECT_DIR}/.chiral/workflows.json`]: workflowsContent,
    [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
    [`${PROJECT_DIR}/.chiral/envs.json`]: VALID_ENVS,
  });
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('actor@example.com\n' as never);
  mockSyncToRemote.mockResolvedValue({ skipped: true } as never);
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'test-project';
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
});

// ── runLockClaim ──────────────────────────────────────────────────────────────

describe('runLockClaim', () => {
  it('throws UserError when --env and --all-envs are both set', async () => {
    setupBase();
    await expect(
      runLockClaim('order-processor', { env: 'prod', allEnvs: true }),
    ).rejects.toThrow(UserError);
  });

  it('throws UserError when neither --env nor --all-envs is set', async () => {
    setupBase();
    await expect(runLockClaim('order-processor', {})).rejects.toThrow(UserError);
  });

  it('throws UserError for unknown --env value', async () => {
    setupBase();
    await expect(
      runLockClaim('order-processor', { env: 'staging' }),
    ).rejects.toThrow(UserError);
  });

  it('writes lock file under locks/<env>/<id>.lock for resolved workflow', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    await runLockClaim('order-processor', { env: 'prod' });

    const lockPath = `${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`;
    const files = vol.toJSON();
    expect(files[lockPath]).toBeDefined();
    const lock = JSON.parse(files[lockPath]!);
    expect(lock.actor).toBe('actor@example.com');
    expect(lock.version).toBe(1);
    expect(lock.hostname).toBe('test-host');
    expect(lock.resolved).toBe(true);
  });

  it('writes lock file with logical-<name> key when workflow not in workflows.json', async () => {
    setupBase();
    await runLockClaim('unknown-wf', { env: 'prod' });

    const lockPath = `${PROJECT_DIR}/.chiral/locks/prd00001/logical-unknown-wf.lock`;
    const files = vol.toJSON();
    expect(files[lockPath]).toBeDefined();
    const lock = JSON.parse(files[lockPath]!);
    expect(lock.resolved).toBe(false);
  });

  it('stores reason in lock file when --reason is provided', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    await runLockClaim('order-processor', { env: 'prod', reason: 'deploying billing fix' });

    const lockPath = `${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`;
    const lock = JSON.parse(vol.toJSON()[lockPath]!);
    expect(lock.reason).toBe('deploying billing fix');
  });

  it('exits with code 6 when workflow is already locked by another actor', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    // Write an existing lock
    const existingLock = JSON.stringify({
      version: 1,
      actor: 'bob@example.com',
      timestamp: new Date().toISOString(),
      hostname: 'other-host',
    });
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: existingLock,
    });

    try {
      await runLockClaim('order-processor', { env: 'prod' });
      expect.fail('should have thrown ControlledExit');
    } catch (err) {
      expect(err).toBeInstanceOf(ControlledExit);
      expect((err as ControlledExit).code).toBe(6);
    }
  });

  it('exits with code 6 when already locked by self', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    const existingLock = JSON.stringify({
      version: 1,
      actor: 'actor@example.com',
      timestamp: new Date().toISOString(),
      hostname: 'same-host',
    });
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: existingLock,
    });

    try {
      await runLockClaim('order-processor', { env: 'prod' });
      expect.fail('should have thrown ControlledExit');
    } catch (err) {
      expect(err).toBeInstanceOf(ControlledExit);
      expect((err as ControlledExit).code).toBe(6);
    }
  });

  it('--all-envs writes locks for all configured envs', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    await runLockClaim('order-processor', { allEnvs: true });

    const files = vol.toJSON();
    expect(files[`${PROJECT_DIR}/.chiral/locks/dev00001/wf-abc123.lock`]).toBeDefined();
    expect(files[`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]).toBeDefined();
  });

  it('--all-envs rolls back written locks when a later env has a conflict', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    // Pre-lock prod
    const existingLock = JSON.stringify({
      version: 1,
      actor: 'bob@example.com',
      timestamp: new Date().toISOString(),
      hostname: 'other-host',
    });
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: existingLock,
    });

    try {
      await runLockClaim('order-processor', { allEnvs: true });
      expect.fail('should have thrown ControlledExit');
    } catch (err) {
      expect(err).toBeInstanceOf(ControlledExit);
      expect((err as ControlledExit).code).toBe(6);
    }

    // dev lock should have been rolled back
    const files = vol.toJSON();
    expect(files[`${PROJECT_DIR}/.chiral/locks/dev00001/wf-abc123.lock`]).toBeUndefined();
    // prod lock (pre-existing) should still be there
    expect(files[`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]).toBeDefined();
  });

  it('calls syncToRemote after successful lock claim', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    await runLockClaim('order-processor', { env: 'prod' });
    expect(mockSyncToRemote).toHaveBeenCalledOnce();
  });

  it('emits JSON envelope on success with --json', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLockClaim('order-processor', { env: 'prod', json: true });

    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const jsonLine = calls.find((c) => c.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.workflowId).toBe('wf-abc123');
    expect(parsed.data.logicalName).toBe('order-processor');
    expect(parsed.data.env).toBe('prod');
    expect(parsed.data.actor).toBe('actor@example.com');
    consoleSpy.mockRestore();
  });

  it('emits JSON conflict error (code lock_conflict) on conflict', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    const existingLock = JSON.stringify({
      version: 1,
      actor: 'bob@example.com',
      timestamp: new Date().toISOString(),
      hostname: 'other-host',
    });
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: existingLock,
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runLockClaim('order-processor', { env: 'prod', json: true });
    } catch {
      // expected ControlledExit(6)
    }
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const jsonLine = calls.find((c) => c.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('lock_conflict');
    consoleSpy.mockRestore();
  });
});

// ── runLockList ───────────────────────────────────────────────────────────────

describe('runLockList', () => {
  it('prints "No active locks." when no locks exist', async () => {
    setupBase();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLockList({});
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('No active locks.');
    consoleSpy.mockRestore();
  });

  it('returns JSON envelope with empty locks array when no locks', async () => {
    setupBase();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLockList({ json: true });
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const jsonLine = calls.find((c) => c.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.locks).toEqual([]);
    consoleSpy.mockRestore();
  });

  it('lists active lock with correct fields in JSON output', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    const lockTimestamp = new Date(Date.now() - 7200_000).toISOString(); // 2h ago
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'actor@example.com',
        timestamp: lockTimestamp,
        hostname: 'test-host',
      }),
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLockList({ json: true });
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const jsonLine = calls.find((c) => c.startsWith('{'));
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.data.locks).toHaveLength(1);
    const entry = parsed.data.locks[0];
    expect(entry.workflowId).toBe('wf-abc123');
    expect(entry.logicalName).toBe('order-processor');
    expect(entry.env).toBe('prod');
    expect(entry.actor).toBe('actor@example.com');
    expect(entry.ageSeconds).toBeGreaterThanOrEqual(7190);
    expect(entry.stale).toBe(false);
    consoleSpy.mockRestore();
  });

  it('--stale 2h filters to only locks older than 7200 seconds', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    const recentTimestamp = new Date(Date.now() - 3600_000).toISOString(); // 1h ago (not stale)
    const oldTimestamp = new Date(Date.now() - 10_800_000).toISOString(); // 3h ago (stale)

    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'actor@example.com',
        timestamp: recentTimestamp,
        hostname: 'test-host',
      }),
      [`${PROJECT_DIR}/.chiral/locks/dev00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'actor@example.com',
        timestamp: oldTimestamp,
        hostname: 'test-host',
      }),
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLockList({ json: true, stale: '2h' });
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const jsonLine = calls.find((c) => c.startsWith('{'));
    const parsed = JSON.parse(jsonLine!);
    // Only the 3h-old dev lock should be returned
    expect(parsed.data.locks).toHaveLength(1);
    expect(parsed.data.locks[0].env).toBe('dev');
    consoleSpy.mockRestore();
  });

  it('throws UserError for invalid --stale duration', async () => {
    setupBase();
    await expect(runLockList({ stale: 'invalid' })).rejects.toThrow(UserError);
  });

  it('throws UserError for unknown --env value', async () => {
    setupBase();
    await expect(runLockList({ env: 'staging' })).rejects.toThrow(UserError);
  });

  it('shows stale:true for locks older than 24h threshold', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    const oldTimestamp = new Date(Date.now() - 25 * 3600_000).toISOString(); // 25h ago
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'actor@example.com',
        timestamp: oldTimestamp,
        hostname: 'test-host',
      }),
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLockList({ json: true });
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const parsed = JSON.parse(calls.find((c) => c.startsWith('{'))!);
    expect(parsed.data.locks[0].stale).toBe(true);
    consoleSpy.mockRestore();
  });
});

// ── runUnlock ─────────────────────────────────────────────────────────────────

describe('runUnlock', () => {
  it('throws UserError when --env and --all-envs are both set', async () => {
    setupBase();
    await expect(
      runUnlock('order-processor', { env: 'prod', allEnvs: true }),
    ).rejects.toThrow(UserError);
  });

  it('throws UserError when neither --env nor --all-envs is set', async () => {
    setupBase();
    await expect(runUnlock('order-processor', {})).rejects.toThrow(UserError);
  });

  it('throws UserError when workflow is not locked in the target env', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    await expect(
      runUnlock('order-processor', { env: 'prod' }),
    ).rejects.toThrow(UserError);
  });

  it('removes lock file on successful unlock', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'actor@example.com',
        timestamp: new Date().toISOString(),
        hostname: 'test-host',
      }),
    });
    await runUnlock('order-processor', { env: 'prod' });
    expect(vol.toJSON()[`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]).toBeUndefined();
  });

  it('throws UserError when actor does not own the lock and --force is not set', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'bob@example.com',
        timestamp: new Date().toISOString(),
        hostname: 'other-host',
      }),
    });
    await expect(
      runUnlock('order-processor', { env: 'prod' }),
    ).rejects.toThrow(UserError);
  });

  it('--force on own lock succeeds', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'actor@example.com',
        timestamp: new Date().toISOString(),
        hostname: 'test-host',
      }),
    });
    await expect(
      runUnlock('order-processor', { env: 'prod', force: true }),
    ).resolves.not.toThrow();
    expect(vol.toJSON()[`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]).toBeUndefined();
  });

  it('--force on another actor\'s lock throws UserError on free tier', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'bob@example.com',
        timestamp: new Date().toISOString(),
        hostname: 'other-host',
      }),
    });
    await expect(
      runUnlock('order-processor', { env: 'prod', force: true }),
    ).rejects.toThrow(UserError);
  });

  it('--all-envs skips envs where actor does not own the lock', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/dev00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'actor@example.com',
        timestamp: new Date().toISOString(),
        hostname: 'test-host',
      }),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'bob@example.com',
        timestamp: new Date().toISOString(),
        hostname: 'other-host',
      }),
    });
    await runUnlock('order-processor', { allEnvs: true });
    const files = vol.toJSON();
    // dev lock removed (own), prod lock kept (other actor's)
    expect(files[`${PROJECT_DIR}/.chiral/locks/dev00001/wf-abc123.lock`]).toBeUndefined();
    expect(files[`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]).toBeDefined();
  });

  it('emits JSON envelope on success with --json', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'actor@example.com',
        timestamp: new Date().toISOString(),
        hostname: 'test-host',
      }),
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUnlock('order-processor', { env: 'prod', json: true });
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const jsonLine = calls.find((c) => c.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.unlocked).toContain('prod');
    consoleSpy.mockRestore();
  });

  it('calls syncToRemote after successful unlock', async () => {
    setupBase(WORKFLOWS_WITH_ID);
    vol.fromJSON({
      ...vol.toJSON(),
      [`${PROJECT_DIR}/.chiral/locks/prd00001/wf-abc123.lock`]: JSON.stringify({
        version: 1,
        actor: 'actor@example.com',
        timestamp: new Date().toISOString(),
        hostname: 'test-host',
      }),
    });
    await runUnlock('order-processor', { env: 'prod' });
    expect(mockSyncToRemote).toHaveBeenCalledOnce();
  });
});
