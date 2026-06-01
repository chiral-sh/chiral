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

import { execSync } from 'node:child_process';
import { runTeamList, runTeamWhoami } from '../../../src/commands/team.js';

const mockExecSync = vi.mocked(execSync);

const GLOBAL_DIR = '/mock-global';
const PROJECT_DIR = '/project';

const INDEX = JSON.stringify({
  version: 1,
  projects: { 'test-project': { path: PROJECT_DIR, createdAt: '2024-01-01T00:00:00.000Z' } },
});

const TEAM_WITH_TWO = JSON.stringify({
  version: 1,
  members: {
    'alice@acme.com': {
      role: 'owner',
      addedBy: 'alice@acme.com',
      addedAt: '2026-06-01T10:00:00.000Z',
    },
    'bob@acme.com': {
      role: 'member',
      addedBy: 'alice@acme.com',
      addedAt: '2026-06-01T11:00:00.000Z',
    },
  },
});

const TEAM_ALICE_ONLY = JSON.stringify({
  version: 1,
  members: {
    'alice@acme.com': {
      role: 'owner',
      addedBy: 'alice@acme.com',
      addedAt: '2026-06-01T10:00:00.000Z',
    },
  },
});

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('alice@acme.com\n' as never);
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'test-project';
  vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: INDEX });
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
});

function setupBase(teamContent = TEAM_WITH_TWO) {
  vol.fromJSON({
    [`${PROJECT_DIR}/.chiral/team.json`]: teamContent,
  });
}

// ── team list ─────────────────────────────────────────────────────────────────

describe('runTeamList', () => {
  it('throws UserError when no active project', async () => {
    vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: JSON.stringify({ version: 1, projects: {} }) });
    delete process.env['CHIRAL_PROJECT'];
    await expect(runTeamList({})).rejects.toThrow(UserError);
    await expect(runTeamList({})).rejects.toThrow("No active project found");
  });

  it('throws UserError when team.json is missing', async () => {
    vol.fromJSON({
      [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
      [`${PROJECT_DIR}/.chiral/config.json`]: '{}',
    });
    await expect(runTeamList({})).rejects.toThrow(UserError);
    await expect(runTeamList({})).rejects.toThrow("No team.json found");
  });

  it('renders one row per member in table format', async () => {
    setupBase();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    await runTeamList({});
    spy.mockRestore();

    const output = lines.join('\n');
    expect(output).toContain('alice@acme.com');
    expect(output).toContain('bob@acme.com');
    expect(output).toContain('owner');
    expect(output).toContain('member');
  });

  it('emits valid JSON envelope with owner and members array on --json', async () => {
    setupBase();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    await runTeamList({ json: true });
    spy.mockRestore();

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.owner).toBe('alice@acme.com');
    expect(Array.isArray(parsed.data.members)).toBe(true);
    expect(parsed.data.members).toHaveLength(2);

    const alice = parsed.data.members.find((m: { email: string }) => m.email === 'alice@acme.com');
    expect(alice).toBeDefined();
    expect(alice.role).toBe('owner');
    expect(alice.addedBy).toBe('alice@acme.com');
    expect(alice.addedAt).toBe('2026-06-01T10:00:00.000Z');

    const bob = parsed.data.members.find((m: { email: string }) => m.email === 'bob@acme.com');
    expect(bob).toBeDefined();
    expect(bob.role).toBe('member');
  });
});

// ── team whoami ───────────────────────────────────────────────────────────────

describe('runTeamWhoami', () => {
  it('throws UserError when no active project', async () => {
    vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: JSON.stringify({ version: 1, projects: {} }) });
    delete process.env['CHIRAL_PROJECT'];
    await expect(runTeamWhoami({})).rejects.toThrow(UserError);
    await expect(runTeamWhoami({})).rejects.toThrow("No active project found");
  });

  it('throws UserError when git config user.email is unset', async () => {
    setupBase();
    mockExecSync.mockImplementation(() => { throw new Error('exit 1'); });
    await expect(runTeamWhoami({})).rejects.toThrow(UserError);
    await expect(runTeamWhoami({})).rejects.toThrow("git config user.email is not set");
  });

  it('throws UserError when team.json is missing', async () => {
    vol.fromJSON({
      [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
      [`${PROJECT_DIR}/.chiral/config.json`]: '{}',
    });
    await expect(runTeamWhoami({})).rejects.toThrow(UserError);
    await expect(runTeamWhoami({})).rejects.toThrow("No team.json found");
  });

  it('prints role when actor is in the roster', async () => {
    setupBase();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    await runTeamWhoami({});
    spy.mockRestore();

    const output = lines.join('\n');
    expect(output).toContain('alice@acme.com');
    expect(output).toContain('owner');
  });

  it('prints not-in-roster advisory when actor is absent from team.json', async () => {
    mockExecSync.mockReturnValue('unknown@acme.com\n' as never);
    setupBase();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    await runTeamWhoami({});
    spy.mockRestore();

    const output = lines.join('\n');
    expect(output).toContain('unknown@acme.com');
    expect(output).toContain("not in this project's roster");
    expect(output).toContain('chiral team add unknown@acme.com');
  });

  it('emits JSON envelope with role and isOwner when actor is in roster', async () => {
    setupBase();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    await runTeamWhoami({ json: true });
    spy.mockRestore();

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.email).toBe('alice@acme.com');
    expect(parsed.data.role).toBe('owner');
    expect(parsed.data.isOwner).toBe(true);
  });

  it('emits JSON envelope with role null and isOwner false when not in roster', async () => {
    mockExecSync.mockReturnValue('unknown@acme.com\n' as never);
    setupBase();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    await runTeamWhoami({ json: true });
    spy.mockRestore();

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.email).toBe('unknown@acme.com');
    expect(parsed.data.role).toBeNull();
    expect(parsed.data.isOwner).toBe(false);
  });

  it('shows bob as member with isOwner false', async () => {
    mockExecSync.mockReturnValue('bob@acme.com\n' as never);
    setupBase();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    await runTeamWhoami({ json: true });
    spy.mockRestore();

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.data.role).toBe('member');
    expect(parsed.data.isOwner).toBe(false);
  });
});
