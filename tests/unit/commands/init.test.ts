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
  confirm: vi.fn(),
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
import { input, confirm } from '@inquirer/prompts';
import { runInit } from '../../../src/commands/init.js';

const mockExecSync = vi.mocked(execSync);
const mockInput = vi.mocked(input);
const mockConfirm = vi.mocked(confirm);

function mockGitEnv(branch = 'main', remote = 'origin'): void {
  mockExecSync.mockImplementation((cmd: unknown, opts?: unknown) => {
    const c = String(cmd);
    const encoding = (opts as Record<string, unknown> | undefined)?.encoding;
    // Commands with encoding: 'utf-8' expect a string return; others get a Buffer
    if (c.includes('rev-parse --git-dir')) return Buffer.from('.git');
    if (c.includes('rev-parse --abbrev-ref HEAD')) return encoding ? `${branch}\n` : Buffer.from(`${branch}\n`);
    if (c.includes('remote -v')) return encoding ? `${remote}\thttps://github.com/org/repo.git (fetch)\n` : Buffer.from('');
    return encoding ? '' : Buffer.from('');
  });
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockGitEnv();
  mockConfirm.mockResolvedValue(false); // opt out of git sync by default
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
    vol.fromJSON({ '/project/.flightdeck/.gitignore': 'config.json\n' });

    await expect(runInit({ project: 'my-project' }, '/project')).rejects.toThrow(
      new UserError('Already initialized. Delete .flightdeck/ to start over.'),
    );
  });

  it('throws UserError when project name is empty and prompt returns empty string', async () => {
    mockInput.mockResolvedValueOnce('   ');

    await expect(runInit({}, '/project')).rejects.toThrow(
      new UserError('Project name is required'),
    );
  });

  it('creates .flightdeck/ directory structure on success', async () => {
    await runInit({ project: 'my-project' }, '/project');

    expect(vol.existsSync('/project/.flightdeck')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/locks')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/snapshots')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/config.example.json')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/.gitignore')).toBe(true);
    expect(vol.existsSync('/project/.flightdeck/audit.jsonl')).toBe(true);
  });

  it('uses project name from --project flag without prompting', async () => {
    await runInit({ project: 'flagged-project' }, '/project');

    expect(mockInput).not.toHaveBeenCalled();
    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    expect(JSON.parse(raw).project).toBe('flagged-project');
  });

  it('prompts for project name when --project flag is not provided', async () => {
    mockInput.mockResolvedValueOnce('prompted-name');

    await runInit({}, '/project');

    expect(mockInput).toHaveBeenCalledOnce();
    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    expect(JSON.parse(raw).project).toBe('prompted-name');
  });

  it('uses cwd basename as default for the project name prompt', async () => {
    mockInput.mockResolvedValueOnce('my-repo');

    await runInit({}, '/home/user/my-repo');

    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({ default: 'my-repo' }),
    );
  });

  it('calls git rev-parse with the provided cwd', async () => {
    await runInit({ project: 'my-project' }, '/my-repo');

    expect(mockExecSync).toHaveBeenCalledWith(
      'git rev-parse --git-dir',
      expect.objectContaining({ cwd: '/my-repo' }),
    );
  });

  it('uses the detected branch as gitSync.branch when git sync is enabled', async () => {
    mockGitEnv('master');
    mockConfirm.mockResolvedValue(true);
    mockInput.mockResolvedValueOnce('origin'); // remote prompt

    await runInit({ project: 'my-project' }, '/project');

    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    expect(JSON.parse(raw).gitSync?.branch).toBe('master');
  });

  it('uses detected branch with --remote flag (non-interactive)', async () => {
    mockGitEnv('develop');

    await runInit({ project: 'my-project', remote: 'origin' }, '/project');

    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    expect(JSON.parse(raw).gitSync?.branch).toBe('develop');
  });

  it('prints project name and next-step configure instruction', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => output.push(a.join(' ')));
    await runInit({ project: 'acme' }, '/project');
    vi.mocked(console.log).mockRestore();

    expect(output.some((l) => l.includes('acme'))).toBe(true);
    expect(output.some((l) => l.includes('flightdeck configure'))).toBe(true);
  });
});
