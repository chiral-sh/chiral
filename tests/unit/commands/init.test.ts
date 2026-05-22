import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: (_q: string, cb: (a: string) => void) => cb('test-project'),
    close: vi.fn(),
  }),
}));

import { execSync } from 'node:child_process';
import { runInit } from '../../../src/commands/init.js';

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
});

describe('runInit', () => {
  it('throws UserError when not inside a Git repository', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });

    await expect(runInit({ project: 'my-project' }, '/no-git')).rejects.toThrow(
      new UserError('flightdeck init must be run inside a Git repository'),
    );
  });

  it('throws UserError when .flightdeck/ already exists', async () => {
    mockExecSync.mockReturnValue(Buffer.from('.git'));
    vol.fromJSON({ '/project/.flightdeck/.gitignore': 'config.json\n' });

    await expect(runInit({ project: 'my-project' }, '/project')).rejects.toThrow(
      new UserError('Already initialized. Delete .flightdeck/ to start over.'),
    );
  });

  it('throws UserError when project name is empty and prompt returns empty string', async () => {
    const { createInterface } = await import('node:readline');
    vi.mocked(createInterface).mockReturnValue({
      question: (_q: string, cb: (a: string) => void) => cb('   '),
      close: vi.fn(),
    } as never);

    mockExecSync.mockReturnValue(Buffer.from('.git'));

    await expect(runInit({}, '/project')).rejects.toThrow(
      new UserError('Project name is required'),
    );
  });

  it('creates .flightdeck/ directory structure on success', async () => {
    mockExecSync.mockReturnValue(Buffer.from('.git'));

    await runInit({ project: 'my-project' }, '/project');

    expect(vol.existsSync('/project/.flightdeck')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/locks')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/snapshots')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/config.example.json')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/.gitignore')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/audit.jsonl')).toBe(true);
  });

  it('uses project name from --project flag without prompting', async () => {
    mockExecSync.mockReturnValue(Buffer.from('.git'));
    const { createInterface } = await import('node:readline');
    const mockCreateInterface = vi.mocked(createInterface);

    await runInit({ project: 'flagged-project' }, '/project');

    expect(mockCreateInterface).not.toHaveBeenCalled();

    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    expect(JSON.parse(raw).project).toBe('flagged-project');
  });

  it('prompts for project name when --project flag is not provided', async () => {
    mockExecSync.mockReturnValue(Buffer.from('.git'));
    const { createInterface } = await import('node:readline');
    vi.mocked(createInterface).mockReturnValue({
      question: (_q: string, cb: (a: string) => void) => cb('prompted-name'),
      close: vi.fn(),
    } as never);

    await runInit({}, '/project');

    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    expect(JSON.parse(raw).project).toBe('prompted-name');
  });

  it('calls git rev-parse with the provided cwd', async () => {
    mockExecSync.mockReturnValue(Buffer.from('.git'));

    await runInit({ project: 'my-project' }, '/my-repo');

    expect(mockExecSync).toHaveBeenCalledWith('git rev-parse --git-dir', {
      cwd: '/my-repo',
      stdio: 'pipe',
    });
  });
});
