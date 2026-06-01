import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { readInitEvent } from '../../../src/state/audit.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const CHIRAL_DIR = '/project/.chiral';

const INIT_ENTRY = JSON.stringify({
  event_id: '123e4567-e89b-12d3-a456-426614174000',
  event_schema_version: 1,
  timestamp: '2024-01-01T12:00:00.000Z',
  actor: 'alice@example.com',
  action: 'init',
  project: 'acme',
  source_env: null,
  target_env: 'dev',
  workflow_ids: [],
  result: 'success',
  error: null,
  chiral_version: '0.1.0',
});

const PUSH_ENTRY = JSON.stringify({
  event_id: '223e4567-e89b-12d3-a456-426614174001',
  event_schema_version: 1,
  timestamp: '2024-02-01T10:00:00.000Z',
  actor: 'bob@example.com',
  action: 'push',
  project: 'acme',
  source_env: 'dev',
  target_env: 'prod',
  workflow_ids: [],
  result: 'success',
  error: null,
  chiral_version: '0.1.0',
});

beforeEach(() => {
  vol.reset();
});

describe('readInitEvent', () => {
  it('returns actor and timestamp from first init entry in a multi-line file', () => {
    vol.fromJSON({
      [`${CHIRAL_DIR}/audit.jsonl`]: `${PUSH_ENTRY}\n${INIT_ENTRY}\n`,
    });
    const result = readInitEvent(CHIRAL_DIR);
    expect(result).toEqual({ actor: 'alice@example.com', timestamp: '2024-01-01T12:00:00.000Z' });
  });

  it('returns the init entry even when it is the first line', () => {
    vol.fromJSON({
      [`${CHIRAL_DIR}/audit.jsonl`]: `${INIT_ENTRY}\n${PUSH_ENTRY}\n`,
    });
    const result = readInitEvent(CHIRAL_DIR);
    expect(result).toEqual({ actor: 'alice@example.com', timestamp: '2024-01-01T12:00:00.000Z' });
  });

  it('returns null when audit.jsonl does not exist', () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/`]: null });
    expect(readInitEvent(CHIRAL_DIR)).toBeNull();
  });

  it('returns null when the file is empty', () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/audit.jsonl`]: '' });
    expect(readInitEvent(CHIRAL_DIR)).toBeNull();
  });

  it('returns null when no line has action === "init"', () => {
    vol.fromJSON({
      [`${CHIRAL_DIR}/audit.jsonl`]: `${PUSH_ENTRY}\n`,
    });
    expect(readInitEvent(CHIRAL_DIR)).toBeNull();
  });

  it('silently skips malformed JSON lines without throwing', () => {
    vol.fromJSON({
      [`${CHIRAL_DIR}/audit.jsonl`]: `not-json\n${INIT_ENTRY}\n`,
    });
    // Should not throw, and should still find the init entry after the bad line
    const result = readInitEvent(CHIRAL_DIR);
    expect(result).toEqual({ actor: 'alice@example.com', timestamp: '2024-01-01T12:00:00.000Z' });
  });

  it('returns null when all lines are malformed JSON', () => {
    vol.fromJSON({
      [`${CHIRAL_DIR}/audit.jsonl`]: `bad-json\nalso-bad\n`,
    });
    expect(readInitEvent(CHIRAL_DIR)).toBeNull();
  });
});
