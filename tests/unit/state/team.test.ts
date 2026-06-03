import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { readTeam, writeTeam, ensureTeam, type Team } from '../../../src/state/team.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const SAMPLE_TEAM: Team = {
  version: 1,
  members: {
    'alice@acme.com': {
      role: 'owner',
      addedBy: 'alice@acme.com',
      addedAt: '2026-06-01T00:00:00.000Z',
    },
  },
};

const MULTI_MEMBER_TEAM: Team = {
  version: 1,
  members: {
    'alice@acme.com': {
      role: 'owner',
      addedBy: 'alice@acme.com',
      addedAt: '2026-06-01T00:00:00.000Z',
    },
    'bob@acme.com': {
      role: 'member',
      addedBy: 'alice@acme.com',
      addedAt: '2026-06-01T01:00:00.000Z',
    },
  },
};

beforeEach(() => vol.reset());

describe('readTeam', () => {
  it('throws UserError when team.json does not exist', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    expect(() => readTeam('/project/.chiral')).toThrow(UserError);
    expect(() => readTeam('/project/.chiral')).toThrow('team.json');
  });

  it('throws UserError when team.json is invalid JSON', () => {
    vol.fromJSON({ '/project/.chiral/team.json': 'not json {{{' });
    expect(() => readTeam('/project/.chiral')).toThrow(UserError);
    expect(() => readTeam('/project/.chiral')).toThrow('valid JSON');
  });

  it('throws UserError when version field is wrong', () => {
    vol.fromJSON({
      '/project/.chiral/team.json': JSON.stringify({ version: 2, members: {} }),
    });
    expect(() => readTeam('/project/.chiral')).toThrow(UserError);
    expect(() => readTeam('/project/.chiral')).toThrow('Invalid team.json');
  });

  it('throws UserError when a member key is not a valid email', () => {
    const invalid = {
      version: 1,
      members: {
        'not-an-email': { role: 'owner', addedBy: 'alice@acme.com', addedAt: '2026-06-01T00:00:00.000Z' },
      },
    };
    vol.fromJSON({ '/project/.chiral/team.json': JSON.stringify(invalid) });
    expect(() => readTeam('/project/.chiral')).toThrow(UserError);
    expect(() => readTeam('/project/.chiral')).toThrow('Invalid team.json');
  });

  it('throws UserError when a member has an unknown role', () => {
    const invalid = {
      version: 1,
      members: {
        'alice@acme.com': { role: 'admin', addedBy: 'alice@acme.com', addedAt: '2026-06-01T00:00:00.000Z' },
      },
    };
    vol.fromJSON({ '/project/.chiral/team.json': JSON.stringify(invalid) });
    expect(() => readTeam('/project/.chiral')).toThrow(UserError);
    expect(() => readTeam('/project/.chiral')).toThrow('Invalid team.json');
  });

  it('loads a valid single-member team', () => {
    vol.fromJSON({ '/project/.chiral/team.json': JSON.stringify(SAMPLE_TEAM) });
    const result = readTeam('/project/.chiral');
    expect(result.version).toBe(1);
    expect(result.members['alice@acme.com'].role).toBe('owner');
  });

  it('loads a valid multi-member team', () => {
    vol.fromJSON({ '/project/.chiral/team.json': JSON.stringify(MULTI_MEMBER_TEAM) });
    const result = readTeam('/project/.chiral');
    expect(Object.keys(result.members)).toHaveLength(2);
    expect(result.members['bob@acme.com'].role).toBe('member');
  });
});

describe('ensureTeam', () => {
  it('returns null when team.json does not exist', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    expect(ensureTeam('/project/.chiral')).toBeNull();
  });

  it('returns the team when team.json exists', () => {
    vol.fromJSON({ '/project/.chiral/team.json': JSON.stringify(SAMPLE_TEAM) });
    const result = ensureTeam('/project/.chiral');
    expect(result).not.toBeNull();
    expect(result!.members['alice@acme.com'].role).toBe('owner');
  });
});

describe('writeTeam', () => {
  it('writes team as formatted JSON', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeTeam('/project/.chiral', SAMPLE_TEAM);
    const raw = vol.readFileSync('/project/.chiral/team.json', 'utf-8') as string;
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(SAMPLE_TEAM);
  });

  it('writes with two-space indentation', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeTeam('/project/.chiral', SAMPLE_TEAM);
    const raw = vol.readFileSync('/project/.chiral/team.json', 'utf-8') as string;
    expect(raw).toMatch(/^  "/m);
  });

  it('round-trips correctly through readTeam', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeTeam('/project/.chiral', MULTI_MEMBER_TEAM);
    const result = readTeam('/project/.chiral');
    expect(result).toEqual(MULTI_MEMBER_TEAM);
  });

  it('throws UserError when directory does not exist', () => {
    vol.fromJSON({});
    expect(() => writeTeam('/nonexistent/.chiral', SAMPLE_TEAM)).toThrow(UserError);
  });
});
