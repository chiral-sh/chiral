import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { UserError, ControlledExit } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../../src/lib/n8n-client.js', () => ({
  N8nClient: vi.fn(),
}));

vi.mock('../../../src/lib/git-sync.js', () => ({
  syncToRemote: vi.fn().mockResolvedValue({ skipped: true }),
  formatSyncSuccess: vi.fn().mockReturnValue(''),
  formatSyncFailure: vi.fn().mockReturnValue([]),
  logSyncError: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import { runTableMap, runTableList, runTableUnmap } from '../../../src/commands/table.js';
import { writeSnapshot, writeSnapshotMeta } from '../../../src/state/snapshots.js';

const mockExecSync = vi.mocked(execSync);

const GLOBAL_DIR = '/mock-global';
const PROJECT_DIR = '/project';
const INDEX = JSON.stringify({
  version: 1,
  projects: { 'test-project': { path: PROJECT_DIR, createdAt: '2024-01-01T00:00:00.000Z' } },
});

const VALID_CONFIG = JSON.stringify({
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'key-dev' },
    prod: { url: 'https://prod.n8n.example.com', apiKey: 'key-prod' },
  },
});

const EMPTY_TABLES = JSON.stringify({ version: 1, tables: {} });

const TABLES_WITH_ENTRY = JSON.stringify({
  version: 1,
  tables: {
    contacts: {
      dev: { id: 'z1HfHUA6tctvw6O8', name: 'contacts' },
      prod: { id: 'pQ7rSt2uVwXy8zA9', name: 'contacts' },
    },
  },
});

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('actor@example.com\n' as never);
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'test-project';
  vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: INDEX });
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
});

function setupBase(tablesContent = EMPTY_TABLES) {
  vol.fromJSON({
    [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
    [`${PROJECT_DIR}/.chiral/tables.json`]: tablesContent,
    [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
  });
}

// ── table map ─────────────────────────────────────────────────────────────────

describe('runTableMap', () => {
  it('does write correct { id, name } entries when name defaults to logical name', async () => {
    setupBase();
    await runTableMap(['contacts', 'dev=z1HfH', 'prod=abc123'], {});

    const written = JSON.parse(
      vol.readFileSync('/project/.chiral/tables.json', 'utf-8') as string,
    );
    expect(written.tables['contacts']).toEqual({
      dev: { id: 'z1HfH', name: 'contacts' },
      prod: { id: 'abc123', name: 'contacts' },
    });
  });

  it('does upsert existing entry without overwriting other envs', async () => {
    setupBase(TABLES_WITH_ENTRY);
    await runTableMap(['contacts', 'dev=newid'], {});

    const written = JSON.parse(
      vol.readFileSync('/project/.chiral/tables.json', 'utf-8') as string,
    );
    expect(written.tables['contacts']['dev']).toEqual({ id: 'newid', name: 'contacts' });
    expect(written.tables['contacts']['prod']).toEqual({
      id: 'pQ7rSt2uVwXy8zA9',
      name: 'contacts',
    });
  });

  it('does emit JSON envelope when --json flag is set', async () => {
    setupBase();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableMap(['contacts', 'dev=z1HfH', 'prod=abc123'], { json: true });
    const jsonOutput = spy.mock.calls.map((c) => c[0]).find((s: string) => s.startsWith('{'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput as string);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.logical_name).toBe('contacts');
    expect(parsed.data.env_entries.dev).toEqual({ id: 'z1HfH', name: 'contacts' });
    spy.mockRestore();
  });

  it('does not write to disk when --dry-run is set', async () => {
    setupBase();
    await runTableMap(['contacts', 'dev=z1HfH', 'prod=abc123'], { dryRun: true });

    const written = JSON.parse(
      vol.readFileSync('/project/.chiral/tables.json', 'utf-8') as string,
    );
    expect(written.tables).toEqual({});
  });

  it('does print dry-run summary without saving when --dry-run is set', async () => {
    setupBase();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableMap(['contacts', 'dev=z1HfH', 'prod=abc123'], { dryRun: true });
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Dry run');
    expect(output).toContain('contacts');
    spy.mockRestore();
  });

  it('does emit JSON without saving when --dry-run and --json are both set', async () => {
    setupBase();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableMap(['contacts', 'dev=z1HfH'], { dryRun: true, json: true });
    const jsonOutput = spy.mock.calls.map((c) => c[0]).find((s: string) => s.startsWith('{'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput as string);
    expect(parsed.data.dry_run).toBe(true);
    spy.mockRestore();
  });

  it('does throw UserError when --json is passed without env=id args', async () => {
    setupBase();
    await expect(runTableMap([], { json: true })).rejects.toThrow(UserError);
  });

  it('does throw UserError when logical name contains invalid characters', async () => {
    setupBase();
    await expect(runTableMap(['my/table', 'dev=z1HfH'], {})).rejects.toThrow(UserError);
  });

  it('does throw UserError when env= value is empty', async () => {
    setupBase();
    await expect(runTableMap(['contacts', 'dev='], {})).rejects.toThrow(/Missing ID/);
  });

  it('does throw UserError when extra positional argument is given', async () => {
    setupBase();
    await expect(runTableMap(['contacts', 'extra', 'dev=id'], {})).rejects.toThrow(/Unexpected argument/);
  });

  it('does write audit entry with resource=table when map succeeds', async () => {
    setupBase();
    await runTableMap(['contacts', 'dev=z1HfH', 'prod=abc123'], {});

    const auditContent = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.action).toBe('map');
    expect(entry.result).toBe('success');
    expect(entry.resource).toBe('table');
  });
});

// ── table list ────────────────────────────────────────────────────────────────

describe('runTableList', () => {
  it('does print dim message when no mappings exist', async () => {
    setupBase();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableList({});
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('No table mappings found');
    spy.mockRestore();
  });

  it('does print table with all entries when mappings are present', async () => {
    setupBase(TABLES_WITH_ENTRY);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableList({});
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('contacts');
    expect(output).toContain('z1HfHUA6tctvw6O8');
    spy.mockRestore();
  });

  it('does emit JSON envelope when --json flag is set', async () => {
    setupBase(TABLES_WITH_ENTRY);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableList({ json: true });
    const output = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.tables).toBeDefined();
    expect(parsed.data.tables['contacts']).toBeDefined();
    spy.mockRestore();
  });

  it('does filter entries when --env is set', async () => {
    const tablesWithGap = JSON.stringify({
      version: 1,
      tables: {
        contacts: { dev: { id: 'dev-id', name: 'contacts' } },
        orders: { prod: { id: 'prod-id', name: 'orders' } },
      },
    });
    setupBase(tablesWithGap);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableList({ env: 'dev' });
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('contacts');
    expect(output).not.toContain('orders');
    spy.mockRestore();
  });

  it('does throw UserError when --env value is unknown', async () => {
    setupBase(TABLES_WITH_ENTRY);
    await expect(runTableList({ env: 'staging' })).rejects.toThrow(UserError);
  });

  it('does emit filtered JSON when --env and --json are both set', async () => {
    const multiEnvTables = JSON.stringify({
      version: 1,
      tables: {
        contacts: {
          dev: { id: 'dev-id', name: 'contacts' },
          prod: { id: 'prod-id', name: 'contacts' },
        },
        'dev-only': { dev: { id: 'dev2', name: 'dev-only' } },
      },
    });
    setupBase(multiEnvTables);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableList({ env: 'prod', json: true });
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.data.tables['contacts']).toBeDefined();
    expect(parsed.data.tables['dev-only']).toBeUndefined();
    spy.mockRestore();
  });

  // ── --uncovered flag ──────────────────────────────────────────────────────

  it('does throw UserError when --uncovered is used with no snapshots', async () => {
    setupBase(TABLES_WITH_ENTRY);
    await expect(runTableList({ uncovered: true })).rejects.toThrow(/No snapshots found/);
  });

  it('does show uncovered table IDs when snapshots contain unmapped IDs', async () => {
    const DEP_ID = '20240101T120000Z-a3f2b9c1';
    const workflow = {
      id: 'wf-1',
      name: 'Sync Contacts',
      active: true,
      nodes: [
        {
          type: 'n8n-nodes-base.dataTable',
          parameters: {
            dataTableId: {
              __rl: true,
              value: 'z1HfHUA6tctvw6O8',
              cachedResultName: 'contacts',
            },
          },
        },
      ],
    };
    vol.fromJSON({
      [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
      [`${PROJECT_DIR}/.chiral/tables.json`]: EMPTY_TABLES,
      [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
    });
    writeSnapshot(`${PROJECT_DIR}/.chiral`, DEP_ID, workflow as never);
    writeSnapshotMeta(`${PROJECT_DIR}/.chiral`, DEP_ID, {
      deployment_id: DEP_ID,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableList({ uncovered: true });
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('z1HfHUA6tctvw6O8');
    spy.mockRestore();
  });

  it('does emit uncovered array when --uncovered and --json are set', async () => {
    const DEP_ID = '20240101T120000Z-b4c3d2e1';
    const workflow = {
      id: 'wf-2',
      name: 'Order Processor',
      active: true,
      nodes: [
        {
          type: 'n8n-nodes-base.dataTable',
          parameters: {
            dataTableId: { __rl: true, value: 'aB3kLm9nPq', cachedResultName: 'orders' },
          },
        },
      ],
    };
    vol.fromJSON({
      [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
      [`${PROJECT_DIR}/.chiral/tables.json`]: EMPTY_TABLES,
      [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
    });
    writeSnapshot(`${PROJECT_DIR}/.chiral`, DEP_ID, workflow as never);
    writeSnapshotMeta(`${PROJECT_DIR}/.chiral`, DEP_ID, {
      deployment_id: DEP_ID,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableList({ uncovered: true, json: true });
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.status).toBe('ok');
    expect(Array.isArray(parsed.data.uncovered)).toBe(true);
    expect(parsed.data.uncovered[0]).toMatchObject({ env: 'dev', id: 'aB3kLm9nPq' });
    spy.mockRestore();
  });

  it('does emit empty uncovered array when all snapshot IDs are already mapped', async () => {
    const DEP_ID = '20240101T120000Z-c5d4e3f2';
    const workflow = {
      id: 'wf-3',
      name: 'Sync Contacts',
      active: true,
      nodes: [
        {
          type: 'n8n-nodes-base.dataTable',
          parameters: {
            dataTableId: {
              __rl: true,
              value: 'z1HfHUA6tctvw6O8',
              cachedResultName: 'contacts',
            },
          },
        },
      ],
    };
    vol.fromJSON({
      [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
      [`${PROJECT_DIR}/.chiral/tables.json`]: TABLES_WITH_ENTRY,
      [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
    });
    writeSnapshot(`${PROJECT_DIR}/.chiral`, DEP_ID, workflow as never);
    writeSnapshotMeta(`${PROJECT_DIR}/.chiral`, DEP_ID, {
      deployment_id: DEP_ID,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableList({ uncovered: true, json: true });
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.uncovered).toEqual([]);
    spy.mockRestore();
  });
});

// ── table unmap ───────────────────────────────────────────────────────────────

describe('runTableUnmap', () => {
  it('does exit with code 4 when logical name is not found', async () => {
    setupBase(TABLES_WITH_ENTRY);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runTableUnmap('nonexistent', {})).rejects.toMatchObject({ code: 4 });
    spy.mockRestore();
  });

  it('does throw ControlledExit not UserError when logical name is not found', async () => {
    setupBase(TABLES_WITH_ENTRY);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runTableUnmap('nonexistent', {})).rejects.toBeInstanceOf(ControlledExit);
    spy.mockRestore();
  });

  it('does prompt for confirmation when entries exist and --yes is not set', async () => {
    setupBase(TABLES_WITH_ENTRY);
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await runTableUnmap('contacts', {});
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('does remove entry when user confirms', async () => {
    setupBase(TABLES_WITH_ENTRY);
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await runTableUnmap('contacts', {});

    const written = JSON.parse(
      vol.readFileSync('/project/.chiral/tables.json', 'utf-8') as string,
    );
    expect(written.tables['contacts']).toBeUndefined();
  });

  it('does not remove entry when user declines confirmation', async () => {
    setupBase(TABLES_WITH_ENTRY);
    vi.mocked(confirm).mockResolvedValueOnce(false);
    await runTableUnmap('contacts', {});

    const written = JSON.parse(
      vol.readFileSync('/project/.chiral/tables.json', 'utf-8') as string,
    );
    expect(written.tables['contacts']).toBeDefined();
  });

  it('does skip confirmation when --yes is set', async () => {
    setupBase(TABLES_WITH_ENTRY);
    await runTableUnmap('contacts', { yes: true });
    expect(confirm).not.toHaveBeenCalled();

    const written = JSON.parse(
      vol.readFileSync('/project/.chiral/tables.json', 'utf-8') as string,
    );
    expect(written.tables['contacts']).toBeUndefined();
  });

  it('does remove only the specified env entry when --env is given', async () => {
    setupBase(TABLES_WITH_ENTRY);
    await runTableUnmap('contacts', { env: 'dev' });

    const written = JSON.parse(
      vol.readFileSync('/project/.chiral/tables.json', 'utf-8') as string,
    );
    expect(written.tables['contacts']['dev']).toBeUndefined();
    expect(written.tables['contacts']['prod']).toEqual({
      id: 'pQ7rSt2uVwXy8zA9',
      name: 'contacts',
    });
  });

  it('does throw UserError when --env mapping is not found for logical name', async () => {
    setupBase(TABLES_WITH_ENTRY);
    await expect(runTableUnmap('contacts', { env: 'staging' })).rejects.toThrow(
      /No mapping for/,
    );
  });

  it('does remove entire entry when last env mapping is removed with --env', async () => {
    const singleEnvTables = JSON.stringify({
      version: 1,
      tables: {
        contacts: { dev: { id: 'dev-id', name: 'contacts' } },
      },
    });
    setupBase(singleEnvTables);
    await runTableUnmap('contacts', { env: 'dev' });

    const written = JSON.parse(
      vol.readFileSync('/project/.chiral/tables.json', 'utf-8') as string,
    );
    expect(written.tables['contacts']).toBeUndefined();
  });

  it('does write audit entry with action unmap and resource=table when unmap succeeds', async () => {
    setupBase(TABLES_WITH_ENTRY);
    await runTableUnmap('contacts', { yes: true });

    const auditContent = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.action).toBe('unmap');
    expect(entry.result).toBe('success');
    expect(entry.resource).toBe('table');
  });

  it('does throw UserError when git actor is not configured', async () => {
    setupBase(TABLES_WITH_ENTRY);
    mockExecSync.mockImplementation(() => {
      throw new Error('no email');
    });
    await expect(runTableUnmap('contacts', { yes: true })).rejects.toThrow(UserError);
  });

  it('does emit JSON envelope when --json flag is set', async () => {
    setupBase(TABLES_WITH_ENTRY);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTableUnmap('contacts', { yes: true, json: true });
    const jsonOutput = spy.mock.calls.map((c) => c[0]).find((s: string) => s.startsWith('{'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput as string);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.logical_name).toBe('contacts');
    expect(Array.isArray(parsed.data.removed_envs)).toBe(true);
    spy.mockRestore();
  });
});
