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

vi.mock('../../../src/lib/git-sync.js', () => ({
  syncToRemote: vi.fn().mockResolvedValue({ skipped: true }),
  formatSyncSuccess: vi.fn().mockReturnValue(''),
  formatSyncFailure: vi.fn().mockReturnValue([]),
  logSyncError: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import { syncToRemote } from '../../../src/lib/git-sync.js';
import { runTeamList, runTeamWhoami, runTeamAdd, runTeamRemove, runTeamSetRole } from '../../../src/commands/team.js';

const mockExecSync = vi.mocked(execSync);
const mockConfirm = vi.mocked(confirm);
const mockSyncToRemote = vi.mocked(syncToRemote);

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
  it('does throw UserError when no active project', async () => {
    vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: JSON.stringify({ version: 1, projects: {} }) });
    delete process.env['CHIRAL_PROJECT'];
    await expect(runTeamList({})).rejects.toThrow(UserError);
    await expect(runTeamList({})).rejects.toThrow("No active project");
  });

  it('does throw UserError when team.json is missing', async () => {
    vol.fromJSON({
      [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
      [`${PROJECT_DIR}/.chiral/config.json`]: '{}',
    });
    await expect(runTeamList({})).rejects.toThrow(UserError);
    await expect(runTeamList({})).rejects.toThrow("No team.json found");
  });

  it('does render one row per member when listing in table format', async () => {
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

  it('does emit JSON envelope with owner and members when --json is set', async () => {
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
  it('does throw UserError when no active project', async () => {
    vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: JSON.stringify({ version: 1, projects: {} }) });
    delete process.env['CHIRAL_PROJECT'];
    await expect(runTeamWhoami({})).rejects.toThrow(UserError);
    await expect(runTeamWhoami({})).rejects.toThrow("No active project");
  });

  it('does throw UserError when git config user.email is unset', async () => {
    setupBase();
    mockExecSync.mockImplementation(() => { throw new Error('exit 1'); });
    await expect(runTeamWhoami({})).rejects.toThrow(UserError);
    await expect(runTeamWhoami({})).rejects.toThrow("git config user.email is not set");
  });

  it('does throw UserError when team.json is missing', async () => {
    vol.fromJSON({
      [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
      [`${PROJECT_DIR}/.chiral/config.json`]: '{}',
    });
    await expect(runTeamWhoami({})).rejects.toThrow(UserError);
    await expect(runTeamWhoami({})).rejects.toThrow("No team.json found");
  });

  it('does print role when actor is in the roster', async () => {
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

  it('does print not-in-roster advisory when actor is absent from team.json', async () => {
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

  it('does emit JSON envelope with role and isOwner when actor is in roster', async () => {
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

  it('does emit JSON envelope with role null and isOwner false when not in roster', async () => {
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

  it('does show member role and isOwner false when actor is not the owner', async () => {
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

// ── team add ──────────────────────────────────────────────────────────────────

describe('runTeamAdd', () => {
  it('does add member with default role member when no role is specified', async () => {
    setupBase(TEAM_ALICE_ONLY);
    await runTeamAdd('bob@acme.com', {});
    const team = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/team.json`, 'utf-8') as string,
    );
    expect(team.members['bob@acme.com']).toBeDefined();
    expect(team.members['bob@acme.com'].role).toBe('member');
    expect(team.members['bob@acme.com'].addedBy).toBe('alice@acme.com');
  });

  it('does add member with owner role when role owner is specified', async () => {
    setupBase(TEAM_ALICE_ONLY);
    await runTeamAdd('charlie@acme.com', { role: 'owner' });
    const team = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/team.json`, 'utf-8') as string,
    );
    expect(team.members['charlie@acme.com'].role).toBe('owner');
    expect(team.members['alice@acme.com'].role).toBe('member');
  });

  it('does demote existing owner to member when adding new member with role owner', async () => {
    setupBase(TEAM_WITH_TWO);
    await runTeamAdd('charlie@acme.com', { role: 'owner' });
    const team = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/team.json`, 'utf-8') as string,
    );
    expect(team.members['charlie@acme.com'].role).toBe('owner');
    expect(team.members['alice@acme.com'].role).toBe('member');
  });

  it('does emit JSON with added: true when member is new', async () => {
    setupBase(TEAM_ALICE_ONLY);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    await runTeamAdd('bob@acme.com', { json: true });
    spy.mockRestore();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.email).toBe('bob@acme.com');
    expect(parsed.data.role).toBe('member');
    expect(parsed.data.added).toBe(true);
  });

  it('does emit JSON with added: false when member already exists', async () => {
    setupBase(TEAM_WITH_TWO);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    await runTeamAdd('bob@acme.com', { json: true });
    spy.mockRestore();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.data.added).toBe(false);
  });

  it('does throw UserError when email is invalid', async () => {
    setupBase(TEAM_ALICE_ONLY);
    await expect(runTeamAdd('not-an-email', {})).rejects.toThrow(UserError);
    await expect(runTeamAdd('not-an-email', {})).rejects.toThrow('Invalid email');
  });

  it('does throw UserError when role is unknown', async () => {
    setupBase(TEAM_ALICE_ONLY);
    await expect(runTeamAdd('bob@acme.com', { role: 'superadmin' })).rejects.toThrow(UserError);
    await expect(runTeamAdd('bob@acme.com', { role: 'superadmin' })).rejects.toThrow('Invalid role');
  });

  it('does throw UserError when git config user.email is not a valid email', async () => {
    setupBase(TEAM_ALICE_ONLY);
    mockExecSync.mockReturnValue('notanemail\n' as never);
    await expect(runTeamAdd('bob@acme.com', {})).rejects.toThrow(UserError);
    await expect(runTeamAdd('bob@acme.com', {})).rejects.toThrow('git config user.email');
  });

  it('does print without writing team.json when --dry-run is passed', async () => {
    setupBase(TEAM_ALICE_ONLY);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    await runTeamAdd('bob@acme.com', { dryRun: true });
    spy.mockRestore();
    const team = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/team.json`, 'utf-8') as string,
    );
    expect(team.members['bob@acme.com']).toBeUndefined();
    expect(lines.join('\n')).toContain('Would');
  });

  it('does not call syncToRemote when --dry-run is passed', async () => {
    setupBase(TEAM_ALICE_ONLY);
    await runTeamAdd('bob@acme.com', { dryRun: true });
    expect(mockSyncToRemote).not.toHaveBeenCalled();
  });

  it('does call syncToRemote after successful write', async () => {
    setupBase(TEAM_ALICE_ONLY);
    await runTeamAdd('bob@acme.com', {});
    expect(mockSyncToRemote).toHaveBeenCalledOnce();
  });
});

// ── team remove ───────────────────────────────────────────────────────────────

describe('runTeamRemove', () => {
  it('does throw UserError when removing the owner', async () => {
    setupBase(TEAM_WITH_TWO);
    await expect(runTeamRemove('alice@acme.com', { yes: true })).rejects.toThrow(UserError);
    await expect(runTeamRemove('alice@acme.com', { yes: true })).rejects.toThrow('Cannot remove');
  });

  it('does throw UserError when email is not in the roster', async () => {
    setupBase(TEAM_ALICE_ONLY);
    await expect(runTeamRemove('unknown@acme.com', { yes: true })).rejects.toThrow(UserError);
    await expect(runTeamRemove('unknown@acme.com', { yes: true })).rejects.toThrow('not in the team roster');
  });

  it('does throw UserError when --yes and --dry-run are combined', async () => {
    setupBase(TEAM_WITH_TWO);
    await expect(runTeamRemove('bob@acme.com', { yes: true, dryRun: true })).rejects.toThrow(UserError);
    await expect(runTeamRemove('bob@acme.com', { yes: true, dryRun: true })).rejects.toThrow('--yes and --dry-run');
  });

  it('does remove member without prompt when --yes is passed', async () => {
    setupBase(TEAM_WITH_TWO);
    await runTeamRemove('bob@acme.com', { yes: true });
    expect(mockConfirm).not.toHaveBeenCalled();
    const team = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/team.json`, 'utf-8') as string,
    );
    expect(team.members['bob@acme.com']).toBeUndefined();
  });

  it('does emit JSON envelope with removed: true when member is removed', async () => {
    setupBase(TEAM_WITH_TWO);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    await runTeamRemove('bob@acme.com', { yes: true, json: true });
    spy.mockRestore();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.email).toBe('bob@acme.com');
    expect(parsed.data.removed).toBe(true);
  });

  it('does not prompt for confirmation when --dry-run is passed', async () => {
    setupBase(TEAM_WITH_TWO);
    await runTeamRemove('bob@acme.com', { dryRun: true });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('does print without writing team.json when --dry-run is passed', async () => {
    setupBase(TEAM_WITH_TWO);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    await runTeamRemove('bob@acme.com', { dryRun: true });
    spy.mockRestore();
    const team = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/team.json`, 'utf-8') as string,
    );
    expect(team.members['bob@acme.com']).toBeDefined();
    expect(lines.join('\n')).toContain('Would');
  });

  it('does call syncToRemote after successful removal', async () => {
    setupBase(TEAM_WITH_TWO);
    await runTeamRemove('bob@acme.com', { yes: true });
    expect(mockSyncToRemote).toHaveBeenCalledOnce();
  });

  it('does not call syncToRemote when --dry-run is passed', async () => {
    setupBase(TEAM_WITH_TWO);
    await runTeamRemove('bob@acme.com', { dryRun: true });
    expect(mockSyncToRemote).not.toHaveBeenCalled();
  });
});

// ── team set-role ─────────────────────────────────────────────────────────────

describe('runTeamSetRole', () => {
  it('does demote previous owner to member when promoting target to owner', async () => {
    setupBase(TEAM_WITH_TWO);
    await runTeamSetRole('bob@acme.com', 'owner', {});
    const team = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/team.json`, 'utf-8') as string,
    );
    expect(team.members['bob@acme.com'].role).toBe('owner');
    expect(team.members['alice@acme.com'].role).toBe('member');
  });

  it('does emit JSON with previousOwner when transferring ownership', async () => {
    setupBase(TEAM_WITH_TWO);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    await runTeamSetRole('bob@acme.com', 'owner', { json: true });
    spy.mockRestore();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.email).toBe('bob@acme.com');
    expect(parsed.data.role).toBe('owner');
    expect(parsed.data.previousOwner).toBe('alice@acme.com');
  });

  it('does throw UserError when demoting current owner to member', async () => {
    setupBase(TEAM_WITH_TWO);
    await expect(runTeamSetRole('alice@acme.com', 'member', {})).rejects.toThrow(UserError);
    await expect(runTeamSetRole('alice@acme.com', 'member', {})).rejects.toThrow('Cannot demote');
  });

  it('does throw UserError when role is unknown', async () => {
    setupBase(TEAM_WITH_TWO);
    await expect(runTeamSetRole('bob@acme.com', 'superadmin', {})).rejects.toThrow(UserError);
  });

  it('does print transfer plan without writing when --dry-run is passed', async () => {
    setupBase(TEAM_WITH_TWO);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    await runTeamSetRole('bob@acme.com', 'owner', { dryRun: true });
    spy.mockRestore();
    const team = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/team.json`, 'utf-8') as string,
    );
    expect(team.members['bob@acme.com'].role).toBe('member');
    expect(lines.join('\n')).toContain('Would');
  });

  it('does call syncToRemote after successful role change', async () => {
    setupBase(TEAM_WITH_TWO);
    await runTeamSetRole('bob@acme.com', 'owner', {});
    expect(mockSyncToRemote).toHaveBeenCalledOnce();
  });

  it('does not call syncToRemote when --dry-run is passed', async () => {
    setupBase(TEAM_WITH_TWO);
    await runTeamSetRole('bob@acme.com', 'owner', { dryRun: true });
    expect(mockSyncToRemote).not.toHaveBeenCalled();
  });
});
