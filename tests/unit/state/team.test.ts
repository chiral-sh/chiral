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
  it('does throw UserError when team.json does not exist', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    expect(() => readTeam('/project/.chiral')).toThrow(UserError);
    expect(() => readTeam('/project/.chiral')).toThrow('team.json');
  });

  it('does throw UserError when team.json contains invalid JSON', () => {
    vol.fromJSON({ '/project/.chiral/team.json': 'not json {{{' });
    expect(() => readTeam('/project/.chiral')).toThrow(UserError);
    expect(() => readTeam('/project/.chiral')).toThrow('valid JSON');
  });

  it('does throw UserError when version field is wrong', () => {
    vol.fromJSON({
      '/project/.chiral/team.json': JSON.stringify({ version: 2, members: {} }),
    });
    expect(() => readTeam('/project/.chiral')).toThrow(UserError);
    expect(() => readTeam('/project/.chiral')).toThrow('Invalid team.json');
  });

  it('does throw UserError when a member key is not a valid email', () => {
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

  it('does throw UserError when a member has an unknown role', () => {
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

  it('does return team with version 1 and correct role when team.json has single member', () => {
    vol.fromJSON({ '/project/.chiral/team.json': JSON.stringify(SAMPLE_TEAM) });
    const result = readTeam('/project/.chiral');
    expect(result.version).toBe(1);
    expect(result.members['alice@acme.com'].role).toBe('owner');
  });

  it('does return all members when team.json has multiple members', () => {
    vol.fromJSON({ '/project/.chiral/team.json': JSON.stringify(MULTI_MEMBER_TEAM) });
    const result = readTeam('/project/.chiral');
    expect(Object.keys(result.members)).toHaveLength(2);
    expect(result.members['bob@acme.com'].role).toBe('member');
  });
});

describe('ensureTeam', () => {
  it('does return null when team.json does not exist', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    expect(ensureTeam('/project/.chiral')).toBeNull();
  });

  it('does return team when team.json exists and is valid', () => {
    vol.fromJSON({ '/project/.chiral/team.json': JSON.stringify(SAMPLE_TEAM) });
    const result = ensureTeam('/project/.chiral');
    expect(result).not.toBeNull();
    expect(result!.members['alice@acme.com'].role).toBe('owner');
  });

  it('does throw UserError when team.json exists but contains invalid JSON', () => {
    vol.fromJSON({ '/project/.chiral/team.json': 'not json {{{' });
    expect(() => ensureTeam('/project/.chiral')).toThrow(UserError);
    expect(() => ensureTeam('/project/.chiral')).toThrow('valid JSON');
  });
});

describe('writeTeam', () => {
  it('does write parseable JSON when writing team', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeTeam('/project/.chiral', SAMPLE_TEAM);
    const raw = vol.readFileSync('/project/.chiral/team.json', 'utf-8') as string;
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(SAMPLE_TEAM);
  });

  it('does write with two-space indentation', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeTeam('/project/.chiral', SAMPLE_TEAM);
    const raw = vol.readFileSync('/project/.chiral/team.json', 'utf-8') as string;
    expect(raw).toMatch(/^  "/m);
  });

  it('does round-trip correctly when writing then reading', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeTeam('/project/.chiral', MULTI_MEMBER_TEAM);
    const result = readTeam('/project/.chiral');
    expect(result).toEqual(MULTI_MEMBER_TEAM);
  });

  it('does throw Error when directory does not exist', () => {
    vol.fromJSON({});
    const err = () => writeTeam('/nonexistent/.chiral', SAMPLE_TEAM);
    expect(err).toThrow(Error);
    expect(err).not.toThrow(UserError);
  });

  it('does call writeJsonAtomic not writeFileSync directly', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeTeam('/project/.chiral', SAMPLE_TEAM);
    // tmp file must not linger — writeJsonAtomic cleans up on success
    const files = Object.keys(vol.toJSON());
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
  });
});
