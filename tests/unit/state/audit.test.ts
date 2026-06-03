import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { writeAuditEntry, readAuditLog, readInitEvent, AuditEntry } from '../../../src/state/audit.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const VALID_ENTRY: AuditEntry = {
  event_id: '123e4567-e89b-12d3-a456-426614174000',
  event_schema_version: 1,
  timestamp: '2024-01-01T12:00:00.000Z',
  actor: 'purvesh@example.com',
  action: 'push',
  project: 'my-project',
  source_env: 'dev',
  target_env: 'prod',
  workflow_ids: ['wf-1', 'wf-2'],
  result: 'success',
  error: null,
  chiral_version: '0.1.0',
};

beforeEach(() => vol.reset());

describe('writeAuditEntry', () => {
  it('creates audit.jsonl and appends a JSON line', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeAuditEntry('/project/.chiral', VALID_ENTRY);
    const contents = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    expect(contents.trim()).toBe(JSON.stringify(VALID_ENTRY));
  });

  it('appends multiple entries as separate lines', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    const second = { ...VALID_ENTRY, event_id: '223e4567-e89b-12d3-a456-426614174001' };
    writeAuditEntry('/project/.chiral', VALID_ENTRY);
    writeAuditEntry('/project/.chiral', second);
    const lines = (vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string)
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(VALID_ENTRY);
    expect(JSON.parse(lines[1])).toEqual(second);
  });

  it('throws UserError when directory is not writable', () => {
    vol.fromJSON({});
    expect(() => writeAuditEntry('/nonexistent/.chiral', VALID_ENTRY)).toThrow(UserError);
  });
});

describe('readAuditLog', () => {
  it('returns empty array when audit.jsonl does not exist', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    expect(readAuditLog('/project/.chiral')).toEqual([]);
  });

  it('reads back entries written by writeAuditEntry', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeAuditEntry('/project/.chiral', VALID_ENTRY);
    const entries = readAuditLog('/project/.chiral');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(VALID_ENTRY);
  });

  it('reads multiple entries correctly', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    const second = { ...VALID_ENTRY, event_id: '223e4567-e89b-12d3-a456-426614174001' };
    writeAuditEntry('/project/.chiral', VALID_ENTRY);
    writeAuditEntry('/project/.chiral', second);
    const entries = readAuditLog('/project/.chiral');
    expect(entries).toHaveLength(2);
  });

  it('throws UserError on corrupted JSON line', () => {
    vol.fromJSON({ '/project/.chiral/audit.jsonl': 'not-json\n' });
    expect(() => readAuditLog('/project/.chiral')).toThrow(UserError);
    expect(() => readAuditLog('/project/.chiral')).toThrow('corrupted at line 1');
  });

  it('throws UserError on invalid entry schema', () => {
    const bad = JSON.stringify({ event_id: 'not-a-uuid', action: 'unknown' });
    vol.fromJSON({ '/project/.chiral/audit.jsonl': bad + '\n' });
    expect(() => readAuditLog('/project/.chiral')).toThrow(UserError);
    expect(() => readAuditLog('/project/.chiral')).toThrow('invalid entry at line 1');
  });

  it('ignores blank lines', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeAuditEntry('/project/.chiral', VALID_ENTRY);
    const raw = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    vol.writeFileSync('/project/.chiral/audit.jsonl', raw + '\n\n');
    expect(readAuditLog('/project/.chiral')).toHaveLength(1);
  });

  it('does not return source_env for init action', () => {
    const initEntry = {
      ...VALID_ENTRY,
      action: 'init' as const,
      source_env: null,
      target_env: 'dev',
      workflow_ids: [],
    };
    vol.fromJSON({ '/project/.chiral/': null });
    writeAuditEntry('/project/.chiral', initEntry);
    const entries = readAuditLog('/project/.chiral');
    expect(entries[0].source_env).toBeNull();
  });
});

describe('readInitEvent', () => {
  it('returns { actor, timestamp } from the first init entry in a multi-line audit file', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    const pushEntry = { ...VALID_ENTRY, action: 'push' as const };
    const initEntry1 = { ...VALID_ENTRY, action: 'init' as const, actor: 'first@example.com', timestamp: '2024-01-01T12:00:00.000Z' };
    const initEntry2 = { ...VALID_ENTRY, action: 'init' as const, actor: 'second@example.com' };
    
    writeAuditEntry('/project/.chiral', pushEntry);
    writeAuditEntry('/project/.chiral', initEntry1);
    writeAuditEntry('/project/.chiral', initEntry2);

    expect(readInitEvent('/project/.chiral')).toEqual({
      actor: 'first@example.com',
      timestamp: '2024-01-01T12:00:00.000Z'
    });
  });

  it('returns null when audit.jsonl does not exist', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    expect(readInitEvent('/project/.chiral')).toBeNull();
  });

  it('returns null when the file is empty', () => {
    vol.fromJSON({ '/project/.chiral/audit.jsonl': '' });
    expect(readInitEvent('/project/.chiral')).toBeNull();
  });

  it('returns null when no line has action === "init"', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeAuditEntry('/project/.chiral', { ...VALID_ENTRY, action: 'push' as const });
    expect(readInitEvent('/project/.chiral')).toBeNull();
  });

  it('silently skips malformed JSON lines without throwing', () => {
    vol.fromJSON({ '/project/.chiral/audit.jsonl': 'not-json\n{"action":"init","actor":"bob","timestamp":"time"}' });
    expect(readInitEvent('/project/.chiral')).toEqual({ actor: 'bob', timestamp: 'time' });
  });
});
