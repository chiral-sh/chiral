import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { writeStatusSentinel, readStatusSentinel } from '../../../src/state/sentinel.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

beforeEach(() => vol.reset());

describe('writeStatusSentinel', () => {
  it('writes state.json with valid ISO-8601 last_status_at', () => {
    vol.fromJSON({ '/chiral/': null });
    writeStatusSentinel('/chiral');
    const raw = JSON.parse(vol.readFileSync('/chiral/state.json', 'utf-8') as string);
    expect(raw.last_status_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('overwrites existing state.json on subsequent calls', () => {
    vol.fromJSON({ '/chiral/state.json': '{"last_status_at":"2020-01-01T00:00:00.000Z"}' });
    writeStatusSentinel('/chiral');
    const raw = JSON.parse(vol.readFileSync('/chiral/state.json', 'utf-8') as string);
    expect(raw.last_status_at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('uses atomic tmp+rename — tmp file is cleaned up after write', () => {
    vol.fromJSON({ '/chiral/': null });
    writeStatusSentinel('/chiral');
    expect(vol.existsSync('/chiral/state.json')).toBe(true);
    expect(vol.existsSync('/chiral/state.json.tmp')).toBe(false);
  });
});

describe('readStatusSentinel', () => {
  it('returns null when state.json does not exist', () => {
    vol.fromJSON({ '/chiral/': null });
    expect(readStatusSentinel('/chiral')).toBeNull();
  });

  it('reads back the ISO-8601 timestamp written by writeStatusSentinel', () => {
    vol.fromJSON({ '/chiral/': null });
    writeStatusSentinel('/chiral');
    const result = readStatusSentinel('/chiral');
    expect(result).not.toBeNull();
    expect(result!.last_status_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns null for a state.json with invalid JSON', () => {
    vol.fromJSON({ '/chiral/state.json': '{not valid json}' });
    expect(readStatusSentinel('/chiral')).toBeNull();
  });

  it('returns null for a state.json that has no last_status_at field', () => {
    vol.fromJSON({ '/chiral/state.json': '{"some_other_key":"value"}' });
    expect(readStatusSentinel('/chiral')).toBeNull();
  });
});
