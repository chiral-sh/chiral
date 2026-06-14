import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../../src/lib/config.js';

// Use vi.hoisted so these are available inside vi.mock factory closures
const { mockAdd, mockStatus, mockCommit, mockPush, mockEnv, mockBranchLocal, mockExistsSync } = vi.hoisted(() => {
  const mockPush = vi.fn();
  // env() returns a chainable object with push - simulates simple-git's .env().push() chain
  const mockEnv = vi.fn((_env: Record<string, string | undefined>) => ({ push: mockPush }));
  return {
    mockAdd: vi.fn(),
    mockStatus: vi.fn(),
    mockCommit: vi.fn(),
    mockPush,
    mockEnv,
    mockBranchLocal: vi.fn(),
    mockExistsSync: vi.fn(),
  };
});

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    add: mockAdd,
    status: mockStatus,
    commit: mockCommit,
    env: mockEnv,
    branchLocal: mockBranchLocal,
  })),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: mockExistsSync };
});

import { syncToRemote, formatSyncSuccess, formatSyncFailure, logSyncError, STAGED_RELATIVE } from '../../../src/lib/git-sync.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(gitSync?: Config['gitSync']): Config {
  return {
    version: 1,
    project: 'test',
    environments: { dev: { url: 'https://dev.example.com', apiKey: 'key' } },
    gitSync,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockStatus.mockResolvedValue({ staged: ['.chiral/workflows.json'] });
  mockAdd.mockResolvedValue(undefined);
  mockCommit.mockResolvedValue(undefined);
  mockPush.mockResolvedValue(undefined);
  mockEnv.mockReturnValue({ push: mockPush });
  mockBranchLocal.mockResolvedValue({ all: ['main'], current: 'main' });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('STAGED_RELATIVE', () => {
  it('includes team.json', () => {
    expect(STAGED_RELATIVE).toContain('team.json');
  });

  it('does not include config.json', () => {
    expect(STAGED_RELATIVE).not.toContain('config.json');
  });
});

describe('syncToRemote', () => {
  it('skips when gitSync is not configured', async () => {
    const result = await syncToRemote('/project/.chiral', makeConfig(), 'msg');
    expect(result.skipped).toBe(true);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('skips when gitSync.enabled is false', async () => {
    const config = makeConfig({ enabled: false, remote: 'origin', branch: 'main' });
    const result = await syncToRemote('/project/.chiral', config, 'msg');
    expect(result.skipped).toBe(true);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('stages non-secret files, commits, and pushes on success', async () => {
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    const result = await syncToRemote('/project/.chiral', config, 'chore(chiral): pull dev');
    expect(mockAdd).toHaveBeenCalledOnce();
    expect(mockCommit).toHaveBeenCalledWith('chore(chiral): pull dev', expect.any(Array));
    expect(mockEnv).toHaveBeenCalledOnce();
    expect(mockPush).toHaveBeenCalledWith('origin', 'main');
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.commitMsg).toBe('chore(chiral): pull dev');
    expect(result.remote).toBe('origin');
  });

  it('does not stage config.json', async () => {
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    await syncToRemote('/project/.chiral', config, 'msg');
    const stagedPaths: string[] = mockAdd.mock.calls[0][0] as string[];
    expect(stagedPaths.every((p) => !p.includes('config.json'))).toBe(true);
  });

  it('returns nothingToCommit when staging produces no staged files', async () => {
    mockStatus.mockResolvedValue({ staged: [] });
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    const result = await syncToRemote('/project/.chiral', config, 'msg');
    expect(result.nothingToCommit).toBe(true);
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('stages team.json alongside credentials.json', async () => {
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    await syncToRemote('/project/.chiral', config, 'msg');
    const stagedPaths: string[] = mockAdd.mock.calls[0][0] as string[];
    expect(stagedPaths.some((p) => p.includes('team.json'))).toBe(true);
    expect(stagedPaths.some((p) => p.includes('credentials.json'))).toBe(true);
  });

  it('skips non-existent files when staging', async () => {
    mockExistsSync.mockImplementation((p: string) => !String(p).includes('snapshots'));
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    await syncToRemote('/project/.chiral', config, 'msg');
    const stagedPaths: string[] = mockAdd.mock.calls[0][0] as string[];
    expect(stagedPaths.every((p) => !p.includes('snapshots'))).toBe(true);
  });

  it('reports nothingToCommit when only an unrelated file is staged', async () => {
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    mockStatus.mockResolvedValue({ staged: ['unrelated.txt'] });
    const result = await syncToRemote('/project/.chiral', config, 'msg');
    expect(result.nothingToCommit).toBe(true);
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('commits only the staged .chiral pathspec, not the whole index', async () => {
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    mockStatus.mockResolvedValue({ staged: ['.chiral/workflows.json', 'unrelated.txt'] });
    await syncToRemote('/project/.chiral', config, 'msg');
    const commitArgs = mockCommit.mock.calls[0] as [string, string[]];
    const pathspec = commitArgs[1];
    expect(pathspec.every((p) => p.startsWith('.chiral'))).toBe(true);
    expect(pathspec).not.toContain('unrelated.txt');
  });

  it('returns failure result when push throws', async () => {
    mockPush.mockRejectedValue(new Error('remote rejected'));
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    const result = await syncToRemote('/project/.chiral', config, 'chore(chiral): push dev→prod');
    expect(result.success).toBe(false);
    expect(result.message).toContain('remote rejected');
    expect(result.manualCmd).toContain('git push origin main');
    expect(result.manualCmd).toContain('chore(chiral): push dev→prod');
  });

  it('uses the configured branch when pushing', async () => {
    const config = makeConfig({ enabled: true, remote: 'upstream', branch: 'release' });
    mockBranchLocal.mockResolvedValue({ all: ['release'], current: 'release' });
    await syncToRemote('/project/.chiral', config, 'msg');
    expect(mockPush).toHaveBeenCalledWith('upstream', 'release');
  });

  it('strips VSCode credential env vars before pushing', async () => {
    const original = process.env;
    process.env = {
      ...original,
      GIT_ASKPASS: '/usr/share/code/resources/app/extensions/git/dist/askpass.sh',
      VSCODE_GIT_ASKPASS_NODE: '/usr/share/code/node',
      VSCODE_GIT_ASKPASS_MAIN: '/usr/share/code/resources/app/extensions/git/dist/askpass-main.js',
      VSCODE_GIT_ASKPASS_EXTRA_ARGS: '',
    };
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    await syncToRemote('/project/.chiral', config, 'msg');
    const envArg = mockEnv.mock.calls[0]![0];
    expect(envArg['GIT_ASKPASS']).toBeUndefined();
    expect(envArg['VSCODE_GIT_ASKPASS_NODE']).toBeUndefined();
    expect(envArg['VSCODE_GIT_ASKPASS_MAIN']).toBeUndefined();
    expect(envArg['VSCODE_GIT_ASKPASS_EXTRA_ARGS']).toBeUndefined();
    process.env = original;
  });

  it('returns failure with clear hint when configured branch does not exist locally', async () => {
    mockBranchLocal.mockResolvedValue({ all: ['master'], current: 'master' });
    const config = makeConfig({ enabled: true, remote: 'origin', branch: 'main' });
    const result = await syncToRemote('/project/.chiral', config, 'chore(chiral): pull dev');
    expect(result.success).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
    expect(result.message).toContain('"master"');
    expect(result.message).toContain('"main"');
    expect(result.manualCmd).toContain('master');
  });
});

describe('formatSyncSuccess', () => {
  it('formats the success line with remote and commit message', () => {
    const line = formatSyncSuccess({
      skipped: false,
      success: true,
      remote: 'origin',
      commitMsg: 'chore(chiral): push dev→prod',
    });
    expect(line).toContain('origin');
    expect(line).toContain('chore(chiral): push dev→prod');
    expect(line).toContain('✓');
  });
});

describe('formatSyncFailure', () => {
  it('includes the manual fallback command', () => {
    const lines = formatSyncFailure({
      skipped: false,
      success: false,
      message: 'network error',
      manualCmd: 'git add .chiral/ && git commit -m "msg" && git push origin main',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('⚠');
    expect(joined).toContain('git push origin main');
    expect(joined).toContain('network error');
  });

  it('classifies rejected push with friendly message and rebase hint', () => {
    const gitOutput = [
      'To https://github.com/org/repo.git',
      ' ! [rejected]        main -> main (fetch first)',
      "error: failed to push some refs to 'https://github.com/org/repo.git'",
    ].join('\n');
    const lines = formatSyncFailure({
      skipped: false,
      success: false,
      message: gitOutput,
      manualCmd: 'git add .chiral/ && git push origin main',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('branches have diverged');
    expect(joined).toContain('Rebase');
    expect(joined).not.toMatch(/⚠.*To https/);
  });

  it('classifies auth failure with friendly message and SSH hint', () => {
    const gitOutput = [
      'remote: Invalid username or password.',
      "fatal: Authentication failed for 'https://github.com/org/repo.git'",
    ].join('\n');
    const lines = formatSyncFailure({
      skipped: false,
      success: false,
      message: gitOutput,
      manualCmd: 'git push origin main',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('authentication failed');
    expect(joined).toContain('SSH');
  });
});

describe('logSyncError', () => {
  it('writes full error output to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
    logSyncError('line one\nline two\nline three');
    const calls = spy.mock.calls.map((c) => c.join(' '));
    expect(calls.some((c) => c.includes('line one'))).toBe(true);
    expect(calls.some((c) => c.includes('line three'))).toBe(true);
    spy.mockRestore();
  });
});
