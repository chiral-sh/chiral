import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { writeAuditEntry, readAuditLog, AuditEntry } from '../../../src/state/audit.js';
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
  flightdeck_version: '0.1.0',
};

beforeEach(() => vol.reset());

describe('writeAuditEntry', () => {
  it('creates audit.jsonl and appends a JSON line', () => {
    vol.fromJSON({ '/project/.flightdeck/': null });
    writeAuditEntry('/project/.flightdeck', VALID_ENTRY);
    const contents = vol.readFileSync('/project/.flightdeck/audit.jsonl', 'utf-8') as string;
    expect(contents.trim()).toBe(JSON.stringify(VALID_ENTRY));
  });

  it('appends multiple entries as separate lines', () => {
    vol.fromJSON({ '/project/.flightdeck/': null });
    const second = { ...VALID_ENTRY, event_id: '223e4567-e89b-12d3-a456-426614174001' };
    writeAuditEntry('/project/.flightdeck', VALID_ENTRY);
    writeAuditEntry('/project/.flightdeck', second);
    const lines = (vol.readFileSync('/project/.flightdeck/audit.jsonl', 'utf-8') as string)
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(VALID_ENTRY);
    expect(JSON.parse(lines[1])).toEqual(second);
  });

  it('throws UserError when directory is not writable', () => {
    vol.fromJSON({});
    expect(() => writeAuditEntry('/nonexistent/.flightdeck', VALID_ENTRY)).toThrow(UserError);
  });
});

describe('readAuditLog', () => {
  it('returns empty array when audit.jsonl does not exist', () => {
    vol.fromJSON({ '/project/.flightdeck/': null });
    expect(readAuditLog('/project/.flightdeck')).toEqual([]);
  });

  it('reads back entries written by writeAuditEntry', () => {
    vol.fromJSON({ '/project/.flightdeck/': null });
    writeAuditEntry('/project/.flightdeck', VALID_ENTRY);
    const entries = readAuditLog('/project/.flightdeck');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(VALID_ENTRY);
  });

  it('reads multiple entries correctly', () => {
    vol.fromJSON({ '/project/.flightdeck/': null });
    const second = { ...VALID_ENTRY, event_id: '223e4567-e89b-12d3-a456-426614174001' };
    writeAuditEntry('/project/.flightdeck', VALID_ENTRY);
    writeAuditEntry('/project/.flightdeck', second);
    const entries = readAuditLog('/project/.flightdeck');
    expect(entries).toHaveLength(2);
  });

  it('throws UserError on corrupted JSON line', () => {
    vol.fromJSON({ '/project/.flightdeck/audit.jsonl': 'not-json\n' });
    expect(() => readAuditLog('/project/.flightdeck')).toThrow(UserError);
    expect(() => readAuditLog('/project/.flightdeck')).toThrow('corrupted at line 1');
  });

  it('throws UserError on invalid entry schema', () => {
    const bad = JSON.stringify({ event_id: 'not-a-uuid', action: 'unknown' });
    vol.fromJSON({ '/project/.flightdeck/audit.jsonl': bad + '\n' });
    expect(() => readAuditLog('/project/.flightdeck')).toThrow(UserError);
    expect(() => readAuditLog('/project/.flightdeck')).toThrow('invalid entry at line 1');
  });

  it('ignores blank lines', () => {
    vol.fromJSON({ '/project/.flightdeck/': null });
    writeAuditEntry('/project/.flightdeck', VALID_ENTRY);
    const raw = vol.readFileSync('/project/.flightdeck/audit.jsonl', 'utf-8') as string;
    vol.writeFileSync('/project/.flightdeck/audit.jsonl', raw + '\n\n');
    expect(readAuditLog('/project/.flightdeck')).toHaveLength(1);
  });

  it('does not return source_env for init action', () => {
    const initEntry = {
      ...VALID_ENTRY,
      action: 'init' as const,
      source_env: null,
      target_env: 'dev',
      workflow_ids: [],
    };
    vol.fromJSON({ '/project/.flightdeck/': null });
    writeAuditEntry('/project/.flightdeck', initEntry);
    const entries = readAuditLog('/project/.flightdeck');
    expect(entries[0].source_env).toBeNull();
  });
});
