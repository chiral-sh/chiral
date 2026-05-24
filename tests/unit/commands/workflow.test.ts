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
  search: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { input, search } from '@inquirer/prompts';
import { runWorkflowMap, runWorkflowList, runWorkflowUnmap } from '../../../src/commands/workflow.js';
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

const EMPTY_WORKFLOWS = JSON.stringify({ version: 1, workflows: {} });

const WORKFLOWS_WITH_ENTRY = JSON.stringify({
  version: 1,
  workflows: {
    'invoice-sync': { dev: { name: 'Invoice Sync' }, prod: { name: 'Invoice Sync' } },
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

function setupBase(workflowsContent = EMPTY_WORKFLOWS) {
  vol.fromJSON({
    [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
    [`${PROJECT_DIR}/.chiral/workflows.json`]: workflowsContent,
    [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
  });
}

// ── workflow map ──────────────────────────────────────────────────────────────

describe('runWorkflowMap', () => {
  it('throws UserError when workflows.json not found', async () => {
    vol.fromJSON({
      '/project/.chiral/config.json': VALID_CONFIG,
      '/project/.chiral/audit.jsonl': '',
    });
    await expect(
      runWorkflowMap(['order-processor', 'dev=Order Processor [DEV]', 'prod=Order Processor'], {}),
    ).rejects.toThrow(UserError);
  });

  it('writes a uniform mapping (mode 3)', async () => {
    setupBase();
    await runWorkflowMap(['invoice-sync', 'Invoice Sync'], {});

    const written = JSON.parse(vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string);
    expect(written.workflows['invoice-sync']).toEqual({ dev: { name: 'Invoice Sync' }, prod: { name: 'Invoice Sync' } });
  });

  it('writes a per-env mapping (mode 4)', async () => {
    setupBase();
    await runWorkflowMap(
      ['order-processor', 'dev=Order Processor [DEV]', 'prod=Order Processor'],
      {},
    );

    const written = JSON.parse(vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string);
    expect(written.workflows['order-processor']).toEqual({
      dev: { name: 'Order Processor [DEV]' },
      prod: { name: 'Order Processor' },
    });
  });

  it('upserts an existing entry without duplicating', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    await runWorkflowMap(['invoice-sync', 'dev=Invoice Sync Dev'], {});

    const written = JSON.parse(vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string);
    expect(written.workflows['invoice-sync']['dev']).toEqual({ name: 'Invoice Sync Dev' });
    expect(written.workflows['invoice-sync']['prod']).toEqual({ name: 'Invoice Sync' });
    expect(Object.keys(written.workflows)).toHaveLength(1);
  });

  it('throws on name conflict with another logical entry', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    await expect(
      runWorkflowMap(['other-sync', 'dev=Invoice Sync'], {}),
    ).rejects.toThrow(UserError);
  });

  it('throws on unexpected plain positional argument (mode error)', async () => {
    setupBase();
    await expect(
      runWorkflowMap(['name', 'uniform', 'extra'], {}),
    ).rejects.toThrow(/Unexpected argument/);
  });

  it('does not write in --dry-run mode', async () => {
    setupBase();
    await runWorkflowMap(['invoice-sync', 'Invoice Sync'], { dryRun: true });

    const written = JSON.parse(vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string);
    expect(written.workflows).toEqual({});
  });

  it('emits JSON in --json mode', async () => {
    setupBase();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowMap(['invoice-sync', 'Invoice Sync'], { json: true });
    const jsonOutput = spy.mock.calls.map((c) => c[0]).find((s: string) => s.startsWith('{'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput as string);
    expect(parsed.logical_name).toBe('invoice-sync');
    spy.mockRestore();
  });

  it('writes an audit entry on success', async () => {
    setupBase();
    await runWorkflowMap(['invoice-sync', 'Invoice Sync'], {});

    const auditContent = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.action).toBe('map');
    expect(entry.match_method).toBe('manual');
    expect(entry.result).toBe('success');
  });

  it('does not re-prompt for a workflow already mapped as a cross-env alias in the same session', async () => {
    // dev has "webhook caller - dev", staging has "first workflow"
    // User maps logical "webhook-caller": dev="webhook caller - dev", staging="first workflow"
    // "first workflow" from staging should then be skipped (already mapped), not re-prompted
    const DEP_DEV = '20260524T120000Z-aaaaaaaa';
    const DEP_STG = '20260524T120001Z-bbbbbbbb';
    const FD = '/project/.chiral';
    const BASE_META = { command: 'adopt' as const, workflow_count: 1, filters: { tag: null, pattern: null, onlyActive: false, id: null } };

    vol.fromJSON({
      '/project/.chiral/config.json': JSON.stringify({
        version: 1, project: 'test-project',
        environments: {
          dev: { url: 'https://dev.n8n.example.com', apiKey: 'key-dev' },
          staging: { url: 'https://staging.n8n.example.com', apiKey: 'key-staging' },
        },
      }),
      '/project/.chiral/workflows.json': EMPTY_WORKFLOWS,
      '/project/.chiral/audit.jsonl': '',
    });

    writeSnapshot(FD, DEP_DEV, { id: '101', name: 'webhook caller - dev' });
    writeSnapshotMeta(FD, DEP_DEV, { ...BASE_META, deployment_id: DEP_DEV, env: 'dev', timestamp: '2026-05-24T12:00:00.000Z' });
    writeSnapshot(FD, DEP_STG, { id: '201', name: 'first workflow' });
    writeSnapshotMeta(FD, DEP_STG, { ...BASE_META, deployment_id: DEP_STG, env: 'staging', timestamp: '2026-05-24T12:00:01.000Z' });

    const mockInput = vi.mocked(input);
    const mockSearch = vi.mocked(search);
    // First unmapped: "webhook caller - dev" from dev
    // input prompt 1: logical name → "webhook-caller"
    // search prompt 1: name in dev (from snapshot) → "webhook caller - dev"
    // search prompt 2: name in staging (from snapshot) → "first workflow"
    // Second unmapped: "first workflow" from staging — already mapped, so no more prompts
    mockInput.mockResolvedValueOnce('webhook-caller');
    mockSearch
      .mockResolvedValueOnce('webhook caller - dev')  // name in dev
      .mockResolvedValueOnce('first workflow');        // name in staging

    const logLines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { logLines.push(String(a[0])); });
    await runWorkflowMap([], {});
    spy.mockRestore();

    // Diagnostic: if no unmapped workflows were found, show what was logged
    expect(logLines.join('\n'), `console.log output:\n${logLines.join('\n')}`).toContain('Unmapped');

    // search should have been called exactly 2 times (dev + staging) — not 4+ (which would mean "first workflow" was re-prompted)
    expect(mockInput).toHaveBeenCalledTimes(1);  // logical name only
    expect(mockSearch).toHaveBeenCalledTimes(2);

    const written = JSON.parse(vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string);
    expect(written.workflows['webhook-caller']).toEqual({
      dev: { name: 'webhook caller - dev', id: '101' },
      staging: { name: 'first workflow', id: '201' },
    });
  });
});

// ── workflow list ─────────────────────────────────────────────────────────────

describe('runWorkflowList', () => {
  it('throws UserError when workflows.json not found', async () => {
    vol.fromJSON({ '/project/.chiral/config.json': VALID_CONFIG });
    await expect(runWorkflowList({})).rejects.toThrow(UserError);
  });

  it('prints dim message when no mappings exist', async () => {
    setupBase();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({});
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('No workflow mappings found');
    spy.mockRestore();
  });

  it('prints table with all entries', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({});
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('invoice-sync');
    expect(output).toContain('Invoice Sync');
    spy.mockRestore();
  });

  it('filters by --env', async () => {
    const workflowsWithGap = JSON.stringify({
      version: 1,
      workflows: {
        'invoice-sync': { dev: { name: 'Invoice Sync' } },
        'order-processor': { prod: { name: 'Order Processor' } },
      },
    });
    setupBase(workflowsWithGap);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ env: 'dev' });
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('invoice-sync');
    expect(output).not.toContain('order-processor');
    spy.mockRestore();
  });

  it('throws for unknown --env value', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    await expect(runWorkflowList({ env: 'staging' })).rejects.toThrow(UserError);
  });

  it('emits JSON in --json mode', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ json: true });
    const output = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.workflows).toBeDefined();
    expect(parsed.version).toBe(1);
    spy.mockRestore();
  });

  it('emits filtered blob for --env --json', async () => {
    const multiEnvWorkflows = JSON.stringify({
      version: 1,
      workflows: {
        'invoice-sync': { dev: { name: 'Invoice Sync' }, prod: { name: 'Invoice Sync' } },
        'dev-only': { dev: { name: 'Dev Only Workflow' } },
      },
    });
    setupBase(multiEnvWorkflows);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ env: 'prod', json: true });
    const output = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.workflows['invoice-sync']).toBeDefined();
    expect(parsed.workflows['dev-only']).toBeUndefined();
    spy.mockRestore();
  });

  // ── --unmapped flag ───────────────────────────────────────────────────────────

  it('throws for --unmapped when no snapshots exist', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    await expect(runWorkflowList({ unmapped: true })).rejects.toThrow(/No snapshots found/);
  });

  it('shows unmapped workflows from snapshots', async () => {
    vol.fromJSON({
      '/project/.chiral/config.json': VALID_CONFIG,
      '/project/.chiral/workflows.json': EMPTY_WORKFLOWS,
      '/project/.chiral/audit.jsonl': '',
      '/project/.chiral/snapshots/20240101T120000Z-a3f2b9c1/meta.json': JSON.stringify({
        deployment_id: '20240101T120000Z-a3f2b9c1',
        env: 'dev',
        command: 'adopt',
        timestamp: '2024-01-01T12:00:00.000Z',
        workflow_count: 1,
        filters: { tag: null, pattern: null, onlyActive: false, id: null },
      }),
      '/project/.chiral/snapshots/20240101T120000Z-a3f2b9c1/wf-1.json': JSON.stringify({
        id: 'wf-1',
        name: 'My Unmapped Workflow',
        active: true,
      }),
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ unmapped: true });
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('My Unmapped Workflow');
    spy.mockRestore();
  });

  it('emits UnmappedResult[] for --unmapped --json', async () => {
    vol.fromJSON({
      '/project/.chiral/config.json': VALID_CONFIG,
      '/project/.chiral/workflows.json': EMPTY_WORKFLOWS,
      '/project/.chiral/audit.jsonl': '',
      '/project/.chiral/snapshots/20240101T120000Z-a3f2b9c1/meta.json': JSON.stringify({
        deployment_id: '20240101T120000Z-a3f2b9c1', env: 'dev', command: 'adopt',
        timestamp: '2024-01-01T12:00:00.000Z', workflow_count: 1,
        filters: { tag: null, pattern: null, onlyActive: false, id: null },
      }),
      '/project/.chiral/snapshots/20240101T120000Z-a3f2b9c1/wf-abc.json': JSON.stringify({
        id: 'wf-abc', name: 'Unmapped WF', active: true,
      }),
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ unmapped: true, json: true });
    const output = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    // Must be an array of UnmappedResult, NOT the full workflows.json blob
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ env: 'dev', name: 'Unmapped WF', id: 'wf-abc' });
    spy.mockRestore();
  });

  it('emits empty array for --unmapped --json when all are mapped', async () => {
    vol.fromJSON({
      '/project/.chiral/config.json': VALID_CONFIG,
      '/project/.chiral/workflows.json': WORKFLOWS_WITH_ENTRY,
      '/project/.chiral/audit.jsonl': '',
      '/project/.chiral/snapshots/20240101T120000Z-a3f2b9c1/meta.json': JSON.stringify({
        deployment_id: '20240101T120000Z-a3f2b9c1', env: 'dev', command: 'adopt',
        timestamp: '2024-01-01T12:00:00.000Z', workflow_count: 1,
        filters: { tag: null, pattern: null, onlyActive: false, id: null },
      }),
      '/project/.chiral/snapshots/20240101T120000Z-a3f2b9c1/inv.json': JSON.stringify({
        id: 'inv', name: 'Invoice Sync', active: true,
      }),
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ unmapped: true, json: true });
    const output = spy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(output)).toEqual([]);
    spy.mockRestore();
  });

  it('scopes --unmapped --env to the specified environment only', async () => {
    vol.fromJSON({
      '/project/.chiral/config.json': VALID_CONFIG,
      '/project/.chiral/workflows.json': EMPTY_WORKFLOWS,
      '/project/.chiral/audit.jsonl': '',
      // dev snapshot has "Dev Only WF"
      '/project/.chiral/snapshots/20240101T120000Z-aaaaaaaa/meta.json': JSON.stringify({
        deployment_id: '20240101T120000Z-aaaaaaaa', env: 'dev', command: 'adopt',
        timestamp: '2024-01-01T12:00:00.000Z', workflow_count: 1,
        filters: { tag: null, pattern: null, onlyActive: false, id: null },
      }),
      '/project/.chiral/snapshots/20240101T120000Z-aaaaaaaa/dev-wf.json': JSON.stringify({
        id: 'dev-wf', name: 'Dev Only WF', active: true,
      }),
      // prod snapshot has "Prod Only WF"
      '/project/.chiral/snapshots/20240101T120000Z-bbbbbbbb/meta.json': JSON.stringify({
        deployment_id: '20240101T120000Z-bbbbbbbb', env: 'prod', command: 'adopt',
        timestamp: '2024-01-01T12:00:01.000Z', workflow_count: 1,
        filters: { tag: null, pattern: null, onlyActive: false, id: null },
      }),
      '/project/.chiral/snapshots/20240101T120000Z-bbbbbbbb/prod-wf.json': JSON.stringify({
        id: 'prod-wf', name: 'Prod Only WF', active: true,
      }),
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ unmapped: true, env: 'dev', json: true });
    const parsed: Array<{ env: string; name: string }> = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.every((r) => r.env === 'dev')).toBe(true);
    expect(parsed.some((r) => r.name === 'Dev Only WF')).toBe(true);
    expect(parsed.some((r) => r.name === 'Prod Only WF')).toBe(false);
    spy.mockRestore();
  });

  // ── --incomplete flag ─────────────────────────────────────────────────────────

  it('emits IncompleteResult[] for --incomplete --json with a missing id', async () => {
    const missingId = JSON.stringify({
      version: 1,
      workflows: {
        'second-wf': {
          dev: { name: 'second workflow', id: 'uejsDIYc1knExlM4' },
          prod: { name: 'second' }, // no id
        },
      },
    });
    setupBase(missingId);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ incomplete: true, json: true });
    const parsed: Array<{ logical: string; issues: Array<{ kind: string; env: string }> }> =
      JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.logical).toBe('second-wf');
    expect(parsed[0]?.issues).toContainEqual({ kind: 'missing_id', env: 'prod', name: 'second' });
    spy.mockRestore();
  });

  it('emits IncompleteResult[] for --incomplete --json with a missing env entry', async () => {
    const missingEnv = JSON.stringify({
      version: 1,
      workflows: {
        'invoice-sync': {
          dev: { name: 'Invoice Sync', id: 'abc' },
          // prod entirely absent
        },
      },
    });
    setupBase(missingEnv);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ incomplete: true, json: true });
    const parsed: Array<{ logical: string; issues: Array<{ kind: string; env: string }> }> =
      JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed[0]?.issues).toContainEqual({ kind: 'missing_env', env: 'prod' });
    spy.mockRestore();
  });

  it('emits empty array for --incomplete --json when all mappings are complete', async () => {
    const complete = JSON.stringify({
      version: 1,
      workflows: {
        'invoice-sync': {
          dev: { name: 'Invoice Sync', id: 'dev-id' },
          prod: { name: 'Invoice Sync', id: 'prod-id' },
        },
      },
    });
    setupBase(complete);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ incomplete: true, json: true });
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual([]);
    spy.mockRestore();
  });

  it('filters --incomplete --env to entries with issues in that env', async () => {
    const mixed = JSON.stringify({
      version: 1,
      workflows: {
        // dev issue only
        'dev-missing': {
          dev: { name: 'Dev WF' }, // missing id
          prod: { name: 'Dev WF', id: 'p1' },
        },
        // prod issue only
        'prod-missing': {
          dev: { name: 'Prod WF', id: 'd1' },
          prod: { name: 'Prod WF' }, // missing id
        },
      },
    });
    setupBase(mixed);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ incomplete: true, env: 'prod', json: true });
    const parsed: Array<{ logical: string }> = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.some((r) => r.logical === 'prod-missing')).toBe(true);
    expect(parsed.some((r) => r.logical === 'dev-missing')).toBe(false);
    spy.mockRestore();
  });

  it('prints human incomplete output containing logical name and issue type', async () => {
    const missingId = JSON.stringify({
      version: 1,
      workflows: {
        'second-wf': {
          dev: { name: 'second workflow', id: 'uejsDIYc1knExlM4' },
          prod: { name: 'second' },
        },
      },
    });
    setupBase(missingId);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
    await runWorkflowList({ incomplete: true });
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('second-wf');
    expect(output).toContain('missing id');
    spy.mockRestore();
  });

  it('throws UserError when --unmapped and --incomplete are both set', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    await expect(
      runWorkflowList({ unmapped: true, incomplete: true }),
    ).rejects.toThrow(UserError);
  });
});

// ── workflow unmap ────────────────────────────────────────────────────────────

describe('runWorkflowUnmap', () => {
  it('throws UserError when workflows.json not found', async () => {
    vol.fromJSON({ '/project/.chiral/config.json': VALID_CONFIG });
    await expect(runWorkflowUnmap('invoice-sync', {})).rejects.toThrow(UserError);
  });

  it('throws when logical name not found', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    await expect(runWorkflowUnmap('nonexistent', {})).rejects.toThrow(/not found/);
  });

  it('removes entire logical entry when no --env', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    await runWorkflowUnmap('invoice-sync', {});

    const written = JSON.parse(vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string);
    expect(written.workflows['invoice-sync']).toBeUndefined();
  });

  it('removes only env-specific mapping with --env', async () => {
    const multiEnvWorkflows = JSON.stringify({
      version: 1,
      workflows: {
        'invoice-sync': { dev: { name: 'Invoice Sync' }, staging: { name: 'Invoice Sync [STG]' }, prod: { name: 'Invoice Sync' } },
      },
    });
    setupBase(multiEnvWorkflows);
    await runWorkflowUnmap('invoice-sync', { env: 'staging' });

    const written = JSON.parse(vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string);
    expect(written.workflows['invoice-sync']).toEqual({
      dev: { name: 'Invoice Sync' },
      prod: { name: 'Invoice Sync' },
    });
  });

  it('throws when --env mapping not found for that logical name', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    await expect(
      runWorkflowUnmap('invoice-sync', { env: 'staging' }),
    ).rejects.toThrow(/No mapping for/);
  });

  it('removes the entire entry when last env mapping is removed with --env', async () => {
    const singleEnvWorkflow = JSON.stringify({
      version: 1,
      workflows: {
        'invoice-sync': { dev: { name: 'Invoice Sync' } },
      },
    });
    setupBase(singleEnvWorkflow);
    await runWorkflowUnmap('invoice-sync', { env: 'dev' });

    const written = JSON.parse(vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string);
    expect(written.workflows['invoice-sync']).toBeUndefined();
  });

  it('writes an audit entry with action unmap', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    await runWorkflowUnmap('invoice-sync', {});

    const auditContent = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.action).toBe('unmap');
    expect(entry.result).toBe('success');
  });

  it('throws UserError when git actor not configured', async () => {
    setupBase(WORKFLOWS_WITH_ENTRY);
    mockExecSync.mockImplementation(() => { throw new Error('no email'); });
    await expect(runWorkflowUnmap('invoice-sync', {})).rejects.toThrow(UserError);
  });
});
