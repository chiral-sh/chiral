import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  confirm: vi.fn().mockResolvedValue(false),
}));

vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    dim: (s: string) => s,
    cyan: (s: string) => s,
  },
}));

import os from 'node:os';
import { execSync } from 'node:child_process';
import { input, confirm } from '@inquirer/prompts';
import { runInit } from '../../../src/commands/init.js';
import { createChiralDirectory } from '../../../src/state/init.js';

const mockExecSync = vi.mocked(execSync);
const mockInput = vi.mocked(input);
const mockConfirm = vi.mocked(confirm);

const GLOBAL_DIR = '/mock-global';
const INDEX_PATH = `${GLOBAL_DIR}/projects/index.json`;
const PROJECT_DIR = `${GLOBAL_DIR}/projects/my-project`;

function emptyIndex(): string {
  return JSON.stringify({ version: 1, projects: {} });
}

function oneProjectIndex(name = 'existing'): string {
  return JSON.stringify({
    version: 1,
    projects: { [name]: { path: `${GLOBAL_DIR}/projects/${name}`, createdAt: '2024-01-01T00:00:00.000Z' } },
  });
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  mockExecSync.mockImplementation((cmd: string) => {
    if (String(cmd) === 'git config user.email') return 'test@example.com' as never;
    return Buffer.from('') as never;
  });
  vol.fromJSON({ [INDEX_PATH]: emptyIndex() });
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
});

function setTTY(value: true | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true, writable: true });
}

describe('runInit', () => {
  it('throws UserError when project name is empty and prompt returns empty string', async () => {
    mockInput.mockResolvedValueOnce('   ');
    await expect(runInit({})).rejects.toThrow('Project name is required');
  });

  // Limit check is commented out in init.ts until the license gate is wired up (see CLAUDE.md Phase 5)
  it.skip('throws UserError when free tier limit is reached', async () => {
    vol.fromJSON({ [INDEX_PATH]: oneProjectIndex() });
    await expect(runInit({ project: 'new-project' })).rejects.toThrow(UserError);
    await expect(runInit({ project: 'new-project' })).rejects.toThrow('Free tier allows 1 project');
  });

  it('throws UserError when project directory already exists on disk', async () => {
    vol.fromJSON({ [`${PROJECT_DIR}/.gitkeep`]: '' });
    await expect(runInit({ project: 'my-project' })).rejects.toThrow(UserError);
    await expect(runInit({ project: 'my-project' })).rejects.toThrow('already exists');
  });

  it('creates .chiral/ directory structure in global projects dir on success', async () => {
    await runInit({ project: 'my-project' });

    expect(vol.existsSync(`${PROJECT_DIR}/.chiral`)).toBe(true);
    expect(vol.existsSync(`${PROJECT_DIR}/.chiral/locks`)).toBe(true);
    expect(vol.existsSync(`${PROJECT_DIR}/.chiral/snapshots`)).toBe(true);
    expect(vol.existsSync(`${PROJECT_DIR}/.chiral/config.example.json`)).toBe(true);
    expect(vol.existsSync(`${PROJECT_DIR}/.chiral/.gitignore`)).toBe(true);
    expect(vol.existsSync(`${PROJECT_DIR}/.chiral/audit.jsonl`)).toBe(true);
  });

  it('uses project name from --project flag without prompting', async () => {
    await runInit({ project: 'my-project' });

    expect(mockInput).not.toHaveBeenCalled();
    const raw = vol.readFileSync(`${PROJECT_DIR}/.chiral/config.example.json`, 'utf-8') as string;
    expect(JSON.parse(raw).project).toBe('my-project');
  });

  it('prompts for project name when --project flag is not provided', async () => {
    mockInput.mockResolvedValueOnce('my-project');

    await runInit({});

    expect(mockInput).toHaveBeenCalledOnce();
    const raw = vol.readFileSync(`${PROJECT_DIR}/.chiral/config.example.json`, 'utf-8') as string;
    expect(JSON.parse(raw).project).toBe('my-project');
  });

  it('registers project in index.json after successful init', async () => {
    await runInit({ project: 'my-project' });

    const raw = vol.readFileSync(INDEX_PATH, 'utf-8') as string;
    const index = JSON.parse(raw);
    expect(index.projects['my-project']).toBeDefined();
    expect(index.projects['my-project'].path).toBe(PROJECT_DIR);
  });

  it('prints project name and "chiral environment add dev" next-step hint', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => output.push(a.join(' ')));

    await runInit({ project: 'my-project' });

    vi.mocked(console.log).mockRestore();
    expect(output.some((l) => l.includes('my-project'))).toBe(true);
    expect(output.some((l) => l.includes('chiral environment add'))).toBe(true);
  });

  it('skips git init when --no-git is passed', async () => {
    await runInit({ project: 'my-project', noGit: true });

    const gitCalls = mockExecSync.mock.calls.map(([c]) => String(c));
    expect(gitCalls.some((c) => c.includes('git init'))).toBe(false);
  });

  it('runs git init in the project directory when git is installed', async () => {
    await runInit({ project: 'my-project' });

    const gitInitCall = mockExecSync.mock.calls.find(([c]) => String(c) === 'git init');
    expect(gitInitCall).toBeDefined();
  });

  it('creates team.json with actor email as owner after successful init', async () => {
    await runInit({ project: 'my-project' });

    expect(vol.existsSync(`${PROJECT_DIR}/.chiral/team.json`)).toBe(true);
    const raw = vol.readFileSync(`${PROJECT_DIR}/.chiral/team.json`, 'utf-8') as string;
    const team = JSON.parse(raw);
    expect(team.version).toBe(1);
    expect(team.members['test@example.com']).toBeDefined();
    expect(team.members['test@example.com'].role).toBe('owner');
    expect(team.members['test@example.com'].addedBy).toBe('test@example.com');
    expect(typeof team.members['test@example.com'].addedAt).toBe('string');
  });

  it('throws UserError when git config user.email is not set', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd) === 'git config user.email') throw new Error('exit code 1');
      return Buffer.from('') as never;
    });
    await expect(runInit({ project: 'my-project' })).rejects.toThrow(UserError);
    await expect(runInit({ project: 'my-project' })).rejects.toThrow('git config user.email');
  });

  it('does not create team.json when createChiralDirectory is called without ownerEmail', () => {
    const chiralDir = `${PROJECT_DIR}/.chiral`;
    createChiralDirectory(chiralDir, 'my-project', undefined, undefined);
    expect(vol.existsSync(`${chiralDir}/team.json`)).toBe(false);
  });
});

describe('completion prompt in runInit', () => {
  const originalShell = process.env['SHELL'];

  afterEach(() => {
    setTTY(undefined);
    if (originalShell === undefined) {
      delete process.env['SHELL'];
    } else {
      process.env['SHELL'] = originalShell;
    }
  });

  it('does not show completion prompt when stdout is not a TTY', async () => {
    setTTY(undefined);
    process.env['SHELL'] = '/bin/bash';
    await runInit({ project: 'my-project' });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('does not show completion prompt when --json is set', async () => {
    setTTY(true);
    process.env['SHELL'] = '/bin/bash';
    await runInit({ project: 'my-project', json: true });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('does not show completion prompt when --no-install-completion is set', async () => {
    setTTY(true);
    process.env['SHELL'] = '/bin/bash';
    await runInit({ project: 'my-project', noInstallCompletion: true });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('installs bash completion without prompting when --install-completion is set', async () => {
    setTTY(undefined);
    process.env['SHELL'] = '/bin/bash';
    await runInit({ project: 'my-project', installCompletion: true });
    expect(mockConfirm).not.toHaveBeenCalled();
    const expectedPath = `${os.homedir()}/.local/share/bash-completion/completions/chiral`;
    expect(vol.existsSync(expectedPath)).toBe(true);
  });

  it('does not show completion prompt when SHELL is unset', async () => {
    setTTY(true);
    delete process.env['SHELL'];
    await runInit({ project: 'my-project' });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('does not show completion prompt when SHELL is unsupported (powershell)', async () => {
    setTTY(true);
    process.env['SHELL'] = '/usr/bin/pwsh';
    await runInit({ project: 'my-project' });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('installs bash completion script when user accepts', async () => {
    setTTY(true);
    process.env['SHELL'] = '/bin/bash';
    mockConfirm.mockResolvedValueOnce(true);
    await runInit({ project: 'my-project' });
    const expectedPath = `${os.homedir()}/.local/share/bash-completion/completions/chiral`;
    expect(vol.existsSync(expectedPath)).toBe(true);
  });

  it('does not write completion script when user declines', async () => {
    setTTY(true);
    process.env['SHELL'] = '/bin/bash';
    mockConfirm.mockResolvedValueOnce(false);
    await runInit({ project: 'my-project' });
    const expectedPath = `${os.homedir()}/.local/share/bash-completion/completions/chiral`;
    expect(vol.existsSync(expectedPath)).toBe(false);
  });

  it('installs fish completion when SHELL is /usr/bin/fish', async () => {
    setTTY(true);
    process.env['SHELL'] = '/usr/bin/fish';
    mockConfirm.mockResolvedValueOnce(true);
    await runInit({ project: 'my-project' });
    const expectedPath = `${os.homedir()}/.config/fish/completions/chiral.fish`;
    expect(vol.existsSync(expectedPath)).toBe(true);
  });
});
