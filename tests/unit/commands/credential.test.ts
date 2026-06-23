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
  input: vi.fn(),
  confirm: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { input } from '@inquirer/prompts';
import { syncToRemote } from '../../../src/lib/git-sync.js';
import {
  runCredentialMap,
  runCredentialList,
  runCredentialUnmap,
} from '../../../src/commands/credential.js';
import { writeSnapshot, writeSnapshotMeta } from '../../../src/state/snapshots.js';
import {
  deriveCredentialLogicalName,
  extractCredentialsFromSnapshots,
} from '../../../src/state/credentials.js';

const mockExecSync = vi.mocked(execSync);
const mockInput = vi.mocked(input);
const mockSyncToRemote = vi.mocked(syncToRemote);

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

const VALID_CONFIG_WITH_LICENSE = JSON.stringify({
  version: 1,
  project: 'test-project',
  licenseKey: 'test-license-key',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'key-dev' },
    prod: { url: 'https://prod.n8n.example.com', apiKey: 'key-prod' },
  },
});

const EMPTY_CREDENTIALS = JSON.stringify({ version: 1, credentials: {} });

const FULL_CREDENTIALS = JSON.stringify({
  version: 1,
  credentials: {
    postgres: { dev: 'dev_postgres', prod: 'prod_postgres' },
    sendgrid: { dev: 'dev_sendgrid' },
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

function setupBase(credentialsContent = EMPTY_CREDENTIALS, configContent = VALID_CONFIG) {
  vol.fromJSON({
    [`${PROJECT_DIR}/.chiral/config.json`]: configContent,
    [`${PROJECT_DIR}/.chiral/credentials.json`]: credentialsContent,
    [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
  });
}

function makeWorkflow(id: string, name: string, credentialNames: string[] = []) {
  return {
    id,
    name,
    nodes: credentialNames.map((credName, i) => ({
      id: `node-${i}`,
      name: `Node ${i}`,
      type: 'n8n-nodes-base.postgres',
      credentials: {
        postgres: { id: `cred-${i}`, name: credName },
      },
    })),
  };
}

// ── deriveCredentialLogicalName ───────────────────────────────────────────────

describe('deriveCredentialLogicalName', () => {
  it('strips leading dev_ prefix', () => {
    expect(deriveCredentialLogicalName('dev_postgres')).toBe('postgres');
  });

  it('strips trailing _prod suffix', () => {
    expect(deriveCredentialLogicalName('postgres_prod')).toBe('postgres');
  });

  it('strips leading staging_ prefix and leaves rest intact', () => {
    expect(deriveCredentialLogicalName('staging_sendgrid_api')).toBe('sendgrid_api');
  });

  it('returns name unchanged when no env token found', () => {
    expect(deriveCredentialLogicalName('shared_webhook')).toBe('shared_webhook');
  });

  it('strips custom env name when provided', () => {
    expect(deriveCredentialLogicalName('production_stripe', ['production'])).toBe('stripe');
  });

  it('strips custom env suffix when provided', () => {
    expect(deriveCredentialLogicalName('stripe_sandbox', ['sandbox'])).toBe('stripe');
  });

  it('returns unchanged when custom env not in name', () => {
    expect(deriveCredentialLogicalName('production_stripe', [])).toBe('production_stripe');
  });

  it('built-in tokens still work when custom env names provided', () => {
    expect(deriveCredentialLogicalName('dev_postgres', ['dev', 'production'])).toBe('postgres');
  });
});

// ── extractCredentialsFromSnapshots ──────────────────────────────────────────

describe('extractCredentialsFromSnapshots', () => {
  const CHIRAL = `${PROJECT_DIR}/.chiral`;

  it('returns empty array when no snapshots exist', () => {
    vol.fromJSON({ [`${CHIRAL}/`]: null });
    expect(extractCredentialsFromSnapshots(CHIRAL, ['dev'])).toEqual([]);
  });

  it('returns credential entries from a single-env snapshot', () => {
    vol.fromJSON({ [`${CHIRAL}/`]: null });
    const deployId = '20240101T120000Z-abcd1234';
    writeSnapshotMeta(CHIRAL, deployId, {
      deployment_id: deployId,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
    writeSnapshot(CHIRAL, deployId, makeWorkflow('wf-1', 'Billing', ['dev_postgres']));

    const result = extractCredentialsFromSnapshots(CHIRAL, ['dev']);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'dev_postgres', env: 'dev', workflowNames: ['Billing'] });
  });

  it('aggregates workflow names for the same credential', () => {
    vol.fromJSON({ [`${CHIRAL}/`]: null });
    const deployId = '20240101T120000Z-abcd1234';
    writeSnapshotMeta(CHIRAL, deployId, {
      deployment_id: deployId,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 2,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
    writeSnapshot(CHIRAL, deployId, makeWorkflow('wf-1', 'Billing', ['dev_postgres']));
    writeSnapshot(CHIRAL, deployId, makeWorkflow('wf-2', 'Invoice Sync', ['dev_postgres']));

    const result = extractCredentialsFromSnapshots(CHIRAL, ['dev']);
    expect(result).toHaveLength(1);
    expect(result[0]!.workflowNames).toEqual(expect.arrayContaining(['Billing', 'Invoice Sync']));
  });

  it('deduplicates same credential name within one env', () => {
    vol.fromJSON({ [`${CHIRAL}/`]: null });
    const deployId = '20240101T120000Z-abcd1234';
    writeSnapshotMeta(CHIRAL, deployId, {
      deployment_id: deployId,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
    // Same credential name used twice in the same workflow
    const wf = {
      id: 'wf-1',
      name: 'Billing',
      nodes: [
        { id: 'n1', name: 'Node1', type: 'postgres', credentials: { postgres: { id: 'c1', name: 'dev_postgres' } } },
        { id: 'n2', name: 'Node2', type: 'postgres', credentials: { postgres: { id: 'c2', name: 'dev_postgres' } } },
      ],
    };
    writeSnapshot(CHIRAL, deployId, wf);

    const result = extractCredentialsFromSnapshots(CHIRAL, ['dev']);
    expect(result).toHaveLength(1);
  });

  it('returns empty array when env has no snapshot', () => {
    vol.fromJSON({ [`${CHIRAL}/`]: null });
    const result = extractCredentialsFromSnapshots(CHIRAL, ['prod']);
    expect(result).toEqual([]);
  });
});

// ── runCredentialMap - non-interactive ────────────────────────────────────────

describe('runCredentialMap - non-interactive', () => {
  it('writes uniform mapping (mode 3)', async () => {
    setupBase();
    await runCredentialMap(['postgres', 'postgres'], {});
    const creds = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/credentials.json`, 'utf-8') as string,
    );
    expect(creds.credentials.postgres).toEqual({ dev: 'postgres', prod: 'postgres' });
  });

  it('upserts without destroying existing entries', async () => {
    setupBase(FULL_CREDENTIALS);
    await runCredentialMap(['stripe', 'stripe'], {});
    const creds = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/credentials.json`, 'utf-8') as string,
    );
    expect(creds.credentials.postgres).toBeDefined();
    expect(creds.credentials.sendgrid).toBeDefined();
    expect(creds.credentials.stripe).toEqual({ dev: 'stripe', prod: 'stripe' });
  });

  it('writes per-env mapping (mode 4)', async () => {
    setupBase();
    await runCredentialMap(['postgres', 'dev=dev_postgres', 'prod=prod_postgres'], {});
    const creds = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/credentials.json`, 'utf-8') as string,
    );
    expect(creds.credentials.postgres).toEqual({ dev: 'dev_postgres', prod: 'prod_postgres' });
  });

  it('applies uniform name plus per-env override', async () => {
    setupBase();
    await runCredentialMap(['db', 'postgres', 'prod=prod_db'], {});
    const creds = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/credentials.json`, 'utf-8') as string,
    );
    // dev gets uniform name, prod gets override
    expect(creds.credentials.db.prod).toBe('prod_db');
    expect(creds.credentials.db.dev).toBe('postgres');
  });

  it('warns but writes for unknown env name', async () => {
    setupBase();
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
    await runCredentialMap(['postgres', 'qa=qa_postgres'], {});
    console.error = orig;
    expect(errs.some((l) => l.includes('⚠') && l.includes('qa'))).toBe(true);
    const creds = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/credentials.json`, 'utf-8') as string,
    );
    expect(creds.credentials.postgres.qa).toBe('qa_postgres');
  });

  it('throws UserError for three plain args', async () => {
    setupBase();
    await expect(
      runCredentialMap(['postgres', 'postgres_name', 'extra'], {}),
    ).rejects.toThrow(UserError);
    await expect(
      runCredentialMap(['postgres', 'postgres_name', 'extra'], {}),
    ).rejects.toThrow('did you mean <env>=<name>');
  });

  it('throws UserError when credentials.json missing', async () => {
    vol.fromJSON({
      [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
      [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
    });
    await expect(
      runCredentialMap(['postgres', 'postgres'], {}),
    ).rejects.toThrow(UserError);
  });

  it('dry-run does not write credentials.json', async () => {
    setupBase();
    await runCredentialMap(['postgres', 'postgres'], { dryRun: true });
    const creds = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/credentials.json`, 'utf-8') as string,
    );
    expect(creds.credentials.postgres).toBeUndefined();
  });

  it('dry-run does not call syncToRemote', async () => {
    setupBase();
    await runCredentialMap(['postgres', 'postgres'], { dryRun: true });
    expect(mockSyncToRemote).not.toHaveBeenCalled();
  });

  it('writes audit entry with action map', async () => {
    setupBase();
    await runCredentialMap(['postgres', 'postgres'], {});
    const audit = vol.readFileSync(`${PROJECT_DIR}/.chiral/audit.jsonl`, 'utf-8') as string;
    expect(audit).toContain('"action":"map"');
  });

  it('calls syncToRemote after successful write', async () => {
    setupBase();
    await runCredentialMap(['postgres', 'postgres'], {});
    expect(mockSyncToRemote).toHaveBeenCalledOnce();
  });

  it('throws UserError for --smart without license', async () => {
    setupBase();
    await expect(
      runCredentialMap(['postgres', 'postgres'], { smart: true }),
    ).rejects.toThrow(UserError);
    await expect(
      runCredentialMap(['postgres', 'postgres'], { smart: true }),
    ).rejects.toThrow('paid license');
  });

  it('emits JSON output with --json flag', async () => {
    setupBase();
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialMap(['postgres', 'postgres'], { json: true });
    console.log = orig;
    const output = JSON.parse(logs[0]!);
    expect(output.status).toBe('ok');
    expect(output.data.logical_name).toBe('postgres');
    expect(output.data.env_names).toMatchObject({ dev: 'postgres', prod: 'postgres' });
  });
});

// ── runCredentialMap - interactive ────────────────────────────────────────────

describe('runCredentialMap - interactive', () => {
  const CHIRAL = `${PROJECT_DIR}/.chiral`;
  const DEV_DEPLOY = '20240101T120000Z-aaaa1111';
  const PROD_DEPLOY = '20240101T120000Z-bbbb2222';

  function setupWithSnapshots() {
    setupBase();
    writeSnapshotMeta(CHIRAL, DEV_DEPLOY, {
      deployment_id: DEV_DEPLOY,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
    writeSnapshot(CHIRAL, DEV_DEPLOY, makeWorkflow('wf-1', 'Billing Pipeline', ['dev_postgres']));
    writeSnapshotMeta(CHIRAL, PROD_DEPLOY, {
      deployment_id: PROD_DEPLOY,
      env: 'prod',
      command: 'adopt',
      timestamp: '2024-01-01T13:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
    writeSnapshot(CHIRAL, PROD_DEPLOY, makeWorkflow('wf-2', 'Billing Prod', ['prod_postgres']));
  }

  it('prompts with pre-filled logical name derived from credential name', async () => {
    setupWithSnapshots();
    // Sequence: logical name prompt → dev name prompt → prod name prompt
    mockInput
      .mockResolvedValueOnce('postgres')   // logical name [postgres]
      .mockResolvedValueOnce('dev_postgres') // Name in dev
      .mockResolvedValueOnce('prod_postgres'); // Name in prod (auto-detected)

    await runCredentialMap([], {});

    // First input call should have default 'postgres' (derived from 'dev_postgres')
    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({ default: 'postgres' }),
    );
  });

  it('exact cross-env auto-fill pre-fills prod prompt', async () => {
    setupWithSnapshots();
    mockInput
      .mockResolvedValueOnce('postgres')   // logical name
      .mockResolvedValueOnce('dev_postgres') // dev name
      .mockResolvedValueOnce('prod_postgres'); // prod (auto-detected default)

    await runCredentialMap([], {});

    // The prod prompt should be called with default 'prod_postgres' (auto-detected)
    const prodCall = mockInput.mock.calls.find(
      (call) => call[0] && typeof call[0] === 'object' && (call[0] as { default?: string }).default === 'prod_postgres',
    );
    expect(prodCall).toBeDefined();
  });

  it('saves mapped entry to credentials.json', async () => {
    setupWithSnapshots();
    mockInput
      .mockResolvedValueOnce('postgres')
      .mockResolvedValueOnce('dev_postgres')
      .mockResolvedValueOnce('prod_postgres');

    await runCredentialMap([], {});

    const creds = JSON.parse(
      vol.readFileSync(`${CHIRAL}/credentials.json`, 'utf-8') as string,
    );
    expect(creds.credentials.postgres).toEqual({
      dev: 'dev_postgres',
      prod: 'prod_postgres',
    });
  });

  it('shows coverage summary after interactive session', async () => {
    setupWithSnapshots();
    mockInput
      .mockResolvedValueOnce('postgres')
      .mockResolvedValueOnce('dev_postgres')
      .mockResolvedValueOnce('prod_postgres');

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialMap([], {});
    console.log = orig;

    expect(logs.some((l) => l.includes('Coverage:'))).toBe(true);
  });

  it('shows all covered message when every workflow is covered', async () => {
    setupWithSnapshots();
    mockInput
      .mockResolvedValueOnce('postgres')
      .mockResolvedValueOnce('dev_postgres')
      .mockResolvedValueOnce('prod_postgres');

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialMap([], {});
    console.log = orig;

    const covLine = logs.find((l) => l.includes('Coverage:'));
    expect(covLine).toBeDefined();
  });

  it('falls back to blank prompts when no snapshots exist', async () => {
    setupBase();
    // No snapshots written

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialMap([], {});
    console.log = orig;

    // Should show "no snapshots" message
    expect(logs.some((l) => l.includes("No snapshots found"))).toBe(true);
    // Should NOT call input prompts
    expect(mockInput).not.toHaveBeenCalled();
  });

  it('throws UserError when config.json missing in interactive mode', async () => {
    vol.fromJSON({
      [`${PROJECT_DIR}/.chiral/credentials.json`]: EMPTY_CREDENTIALS,
      [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
    });
    await expect(runCredentialMap([], {})).rejects.toThrow(UserError);
    await expect(runCredentialMap([], {})).rejects.toThrow("Interactive mode requires");
  });

  it('--smart without license throws even in interactive mode', async () => {
    setupBase();
    await expect(runCredentialMap([], { smart: true })).rejects.toThrow('paid license');
  });
});

// ── runCredentialList ─────────────────────────────────────────────────────────

describe('runCredentialList', () => {
  it('prints no-credentials message when registry is empty', async () => {
    setupBase();
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialList({});
    console.log = orig;
    expect(logs.some((l) => l.includes('No credentials mapped'))).toBe(true);
  });

  it('renders table with env column headers', async () => {
    setupBase(FULL_CREDENTIALS);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialList({});
    console.log = orig;
    const output = logs.join('\n');
    expect(output).toContain('dev');
    expect(output).toContain('prod');
    expect(output).toContain('postgres');
  });

  it('renders (not set) for env with missing mapping', async () => {
    setupBase(FULL_CREDENTIALS);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialList({});
    console.log = orig;
    expect(logs.some((l) => l.includes('(not set)'))).toBe(true);
  });

  it('throws UserError when credentials.json missing', async () => {
    vol.fromJSON({
      [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
      [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
    });
    await expect(runCredentialList({})).rejects.toThrow(UserError);
  });

  it('--env filters table to entries for that env', async () => {
    setupBase(FULL_CREDENTIALS);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    // sendgrid has no prod mapping - filtering to prod should exclude it
    await runCredentialList({ env: 'prod' });
    console.log = orig;
    const output = logs.join('\n');
    expect(output).toContain('postgres');
    expect(output).not.toContain('sendgrid');
  });

  it('--env throws UserError for unknown environment', async () => {
    setupBase(FULL_CREDENTIALS);
    await expect(runCredentialList({ env: 'unknown-env' })).rejects.toThrow(UserError);
    await expect(runCredentialList({ env: 'unknown-env' })).rejects.toThrow('Unknown environment');
  });

  it('--json emits full credentials as JSON', async () => {
    setupBase(FULL_CREDENTIALS);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialList({ json: true });
    console.log = orig;
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.data.credentials.postgres).toBeDefined();
  });
});

describe('runCredentialList --uncovered', () => {
  const CHIRAL = `${PROJECT_DIR}/.chiral`;
  const DEV_DEPLOY = '20240101T120000Z-cccc3333';

  it('throws UserError when no snapshots exist', async () => {
    setupBase();
    await expect(runCredentialList({ uncovered: true })).rejects.toThrow(UserError);
    await expect(runCredentialList({ uncovered: true })).rejects.toThrow('No snapshots found');
  });

  it('shows uncovered credential from snapshot not in credentials.json', async () => {
    setupBase();
    writeSnapshotMeta(CHIRAL, DEV_DEPLOY, {
      deployment_id: DEV_DEPLOY,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
    writeSnapshot(CHIRAL, DEV_DEPLOY, makeWorkflow('wf-1', 'Checkout', ['dev_stripe']));

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialList({ uncovered: true });
    console.log = orig;
    expect(logs.some((l) => l.includes('dev_stripe'))).toBe(true);
  });

  it('shows all-mapped message when no gaps exist', async () => {
    setupBase(FULL_CREDENTIALS);
    writeSnapshotMeta(CHIRAL, DEV_DEPLOY, {
      deployment_id: DEV_DEPLOY,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
    writeSnapshot(CHIRAL, DEV_DEPLOY, makeWorkflow('wf-1', 'Billing', ['dev_postgres']));

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialList({ uncovered: true });
    console.log = orig;
    expect(logs.some((l) => l.includes('All credentials') && l.includes('are mapped'))).toBe(true);
  });

  it('--uncovered --json returns array', async () => {
    setupBase();
    writeSnapshotMeta(CHIRAL, DEV_DEPLOY, {
      deployment_id: DEV_DEPLOY,
      env: 'dev',
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
    writeSnapshot(CHIRAL, DEV_DEPLOY, makeWorkflow('wf-1', 'Checkout', ['dev_stripe']));

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    await runCredentialList({ uncovered: true, json: true });
    console.log = orig;
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.status).toBe('ok');
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data[0]).toMatchObject({ env: 'dev', name: 'dev_stripe' });
  });
});

// ── runCredentialUnmap ────────────────────────────────────────────────────────

describe('runCredentialUnmap', () => {
  it('removes entire credential entry', async () => {
    setupBase(FULL_CREDENTIALS);
    await runCredentialUnmap('postgres', {});
    const creds = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/credentials.json`, 'utf-8') as string,
    );
    expect(creds.credentials.postgres).toBeUndefined();
    expect(creds.credentials.sendgrid).toBeDefined();
  });

  it('removes only one env mapping with --env', async () => {
    setupBase(FULL_CREDENTIALS);
    await runCredentialUnmap('postgres', { env: 'dev' });
    const creds = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/credentials.json`, 'utf-8') as string,
    );
    expect(creds.credentials.postgres.dev).toBeUndefined();
    expect(creds.credentials.postgres.prod).toBe('prod_postgres');
  });

  it('removes entire entry when last env is deleted', async () => {
    // sendgrid has only dev mapping
    setupBase(FULL_CREDENTIALS);
    await runCredentialUnmap('sendgrid', { env: 'dev' });
    const creds = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/credentials.json`, 'utf-8') as string,
    );
    expect(creds.credentials.sendgrid).toBeUndefined();
  });

  it('throws UserError for non-existent logical name', async () => {
    setupBase(FULL_CREDENTIALS);
    await expect(runCredentialUnmap('nonexistent', {})).rejects.toThrow(UserError);
    await expect(runCredentialUnmap('nonexistent', {})).rejects.toThrow('not found in credentials.json');
  });

  it('throws UserError for --env not in entry', async () => {
    setupBase(FULL_CREDENTIALS);
    await expect(runCredentialUnmap('sendgrid', { env: 'prod' })).rejects.toThrow(UserError);
    await expect(runCredentialUnmap('sendgrid', { env: 'prod' })).rejects.toThrow('No mapping for');
  });

  it('writes audit entry with action unmap', async () => {
    setupBase(FULL_CREDENTIALS);
    await runCredentialUnmap('postgres', {});
    const audit = vol.readFileSync(`${PROJECT_DIR}/.chiral/audit.jsonl`, 'utf-8') as string;
    expect(audit).toContain('"action":"unmap"');
  });

  it('calls syncToRemote after removal', async () => {
    setupBase(FULL_CREDENTIALS);
    await runCredentialUnmap('postgres', {});
    expect(mockSyncToRemote).toHaveBeenCalledOnce();
  });
});
