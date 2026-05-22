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

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
}));

vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    dim: (s: string) => s,
    cyan: (s: string) => s,
  },
}));

import { execSync } from 'node:child_process';
import { input } from '@inquirer/prompts';
import { runInit } from '../../../src/commands/init.js';

const mockExecSync = vi.mocked(execSync);
const mockInput = vi.mocked(input);

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
    mockExecSync.mockReturnValue(Buffer.from('.git'));
    mockInput.mockResolvedValueOnce('   ');

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

    await runInit({ project: 'flagged-project' }, '/project');

    expect(mockInput).not.toHaveBeenCalled();
    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    expect(JSON.parse(raw).project).toBe('flagged-project');
  });

  it('prompts for project name when --project flag is not provided', async () => {
    mockExecSync.mockReturnValue(Buffer.from('.git'));
    mockInput.mockResolvedValueOnce('prompted-name');

    await runInit({}, '/project');

    expect(mockInput).toHaveBeenCalledOnce();
    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    expect(JSON.parse(raw).project).toBe('prompted-name');
  });

  it('uses cwd basename as default for the project name prompt', async () => {
    mockExecSync.mockReturnValue(Buffer.from('.git'));
    mockInput.mockResolvedValueOnce('my-repo');

    await runInit({}, '/home/user/my-repo');

    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({ default: 'my-repo' }),
    );
  });

  it('calls git rev-parse with the provided cwd', async () => {
    mockExecSync.mockReturnValue(Buffer.from('.git'));

    await runInit({ project: 'my-project' }, '/my-repo');

    expect(mockExecSync).toHaveBeenCalledWith('git rev-parse --git-dir', {
      cwd: '/my-repo',
      stdio: 'pipe',
    });
  });

  it('prints project name and next-step configure instruction', async () => {
    mockExecSync.mockReturnValue(Buffer.from('.git'));

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => output.push(a.join(' ')));
    await runInit({ project: 'acme' }, '/project');
    vi.mocked(console.log).mockRestore();

    expect(output.some((l) => l.includes('acme'))).toBe(true);
    expect(output.some((l) => l.includes('flightdeck configure'))).toBe(true);
  });
});
