import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import {
  loadTableMap,
  writeTableMap,
  upsertTableEnvEntry,
  removeTableEnvEntry,
  TablesMap,
  TableEntry,
} from '../../../src/state/tables.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const EMPTY_MAP: TablesMap = { version: 1, tables: {} };

const FULL_MAP: TablesMap = {
  version: 1,
  tables: {
    contacts: {
      dev: { id: 'dev-id-1', name: 'Contacts Dev' },
      prod: { id: 'prod-id-1', name: 'Contacts Prod' },
    },
    orders: {
      dev: { id: 'dev-id-2', name: 'Orders Dev' },
    },
  },
};

beforeEach(() => vol.reset());

describe('loadTableMap', () => {
  it('returns empty map when tables.json absent', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    const result = loadTableMap('/project/.chiral');
    expect(result).toEqual({ version: 1, tables: {} });
  });

  it('throws UserError containing "tables.json" on corrupt JSON', () => {
    vol.fromJSON({ '/project/.chiral/tables.json': 'not valid {{{' });
    expect(() => loadTableMap('/project/.chiral')).toThrow(UserError);
    expect(() => loadTableMap('/project/.chiral')).toThrow('tables.json');
  });

  it('throws UserError on schema mismatch — missing id field', () => {
    const bad = { version: 1, tables: { contacts: { dev: { name: 'Contacts' } } } };
    vol.fromJSON({ '/project/.chiral/tables.json': JSON.stringify(bad) });
    expect(() => loadTableMap('/project/.chiral')).toThrow(UserError);
  });

  it('throws UserError on schema mismatch — missing name field', () => {
    const bad = { version: 1, tables: { contacts: { dev: { id: 'abc123' } } } };
    vol.fromJSON({ '/project/.chiral/tables.json': JSON.stringify(bad) });
    expect(() => loadTableMap('/project/.chiral')).toThrow(UserError);
  });

  it('throws UserError on wrong version', () => {
    vol.fromJSON({
      '/project/.chiral/tables.json': JSON.stringify({ version: 2, tables: {} }),
    });
    expect(() => loadTableMap('/project/.chiral')).toThrow(UserError);
  });

  it('loads full map correctly', () => {
    vol.fromJSON({ '/project/.chiral/tables.json': JSON.stringify(FULL_MAP) });
    const result = loadTableMap('/project/.chiral');
    expect(result.tables['contacts']['dev']).toEqual({ id: 'dev-id-1', name: 'Contacts Dev' });
    expect(result.tables['contacts']['prod']).toEqual({ id: 'prod-id-1', name: 'Contacts Prod' });
    expect(result.tables['orders']['dev']).toEqual({ id: 'dev-id-2', name: 'Orders Dev' });
  });

  it('defaults tables to empty object when field omitted', () => {
    vol.fromJSON({ '/project/.chiral/tables.json': JSON.stringify({ version: 1 }) });
    const result = loadTableMap('/project/.chiral');
    expect(result.tables).toEqual({});
  });
});

describe('writeTableMap + loadTableMap round-trip', () => {
  it('writes and reads back correctly', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeTableMap('/project/.chiral', FULL_MAP);
    const result = loadTableMap('/project/.chiral');
    expect(result).toEqual(FULL_MAP);
  });

  it('writes empty map and reads back', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeTableMap('/project/.chiral', EMPTY_MAP);
    const result = loadTableMap('/project/.chiral');
    expect(result).toEqual(EMPTY_MAP);
  });

  it('overwrites existing tables.json', () => {
    vol.fromJSON({ '/project/.chiral/tables.json': JSON.stringify(FULL_MAP) });
    writeTableMap('/project/.chiral', EMPTY_MAP);
    const result = loadTableMap('/project/.chiral');
    expect(result.tables).toEqual({});
  });
});

describe('upsertTableEnvEntry', () => {
  it('creates new logical entry when not present', () => {
    const map: TablesMap = { version: 1, tables: {} };
    upsertTableEnvEntry(map, 'contacts', 'dev', { id: 'dev-id', name: 'Contacts' });
    expect(map.tables['contacts']['dev']).toEqual({ id: 'dev-id', name: 'Contacts' });
  });

  it('adds new env to existing logical entry without overwriting other envs', () => {
    const map: TablesMap = {
      version: 1,
      tables: { contacts: { dev: { id: 'dev-id', name: 'Contacts Dev' } } },
    };
    upsertTableEnvEntry(map, 'contacts', 'prod', { id: 'prod-id', name: 'Contacts Prod' });
    expect(map.tables['contacts']['dev']).toEqual({ id: 'dev-id', name: 'Contacts Dev' });
    expect(map.tables['contacts']['prod']).toEqual({ id: 'prod-id', name: 'Contacts Prod' });
  });

  it('updates existing env entry', () => {
    const map: TablesMap = {
      version: 1,
      tables: { contacts: { dev: { id: 'old-id', name: 'Old Name' } } },
    };
    upsertTableEnvEntry(map, 'contacts', 'dev', { id: 'new-id', name: 'New Name' });
    expect(map.tables['contacts']['dev']).toEqual({ id: 'new-id', name: 'New Name' });
  });

  it('does not affect other logical entries', () => {
    const map: TablesMap = {
      version: 1,
      tables: { orders: { dev: { id: 'orders-id', name: 'Orders' } } },
    };
    upsertTableEnvEntry(map, 'contacts', 'dev', { id: 'contacts-id', name: 'Contacts' });
    expect(map.tables['orders']['dev']).toEqual({ id: 'orders-id', name: 'Orders' });
  });
});

describe('removeTableEnvEntry', () => {
  it('removes entire logical entry when env not specified', () => {
    const map: TablesMap = JSON.parse(JSON.stringify(FULL_MAP));
    removeTableEnvEntry(map, 'contacts');
    expect(map.tables['contacts']).toBeUndefined();
    expect(map.tables['orders']).toBeDefined();
  });

  it('removes only specified env, leaves others intact', () => {
    const map: TablesMap = JSON.parse(JSON.stringify(FULL_MAP));
    removeTableEnvEntry(map, 'contacts', 'dev');
    expect(map.tables['contacts']['dev']).toBeUndefined();
    expect(map.tables['contacts']['prod']).toEqual({ id: 'prod-id-1', name: 'Contacts Prod' });
  });

  it('removes logical entry entirely when last env is removed', () => {
    const map: TablesMap = {
      version: 1,
      tables: { contacts: { dev: { id: 'dev-id', name: 'Contacts' } } },
    };
    removeTableEnvEntry(map, 'contacts', 'dev');
    expect(map.tables['contacts']).toBeUndefined();
  });

  it('is a no-op when logical name not in map', () => {
    const map: TablesMap = JSON.parse(JSON.stringify(FULL_MAP));
    expect(() => removeTableEnvEntry(map, 'nonexistent')).not.toThrow();
    expect(map.tables['contacts']).toBeDefined();
  });
});
