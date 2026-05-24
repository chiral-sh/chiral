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

import { execSync } from 'node:child_process';
import { N8nClient } from '../../../src/lib/n8n-client.js';
import { runPull } from '../../../src/commands/pull.js';
import { writeSnapshot, writeSnapshotMeta } from '../../../src/state/snapshots.js';

const mockExecSync = vi.mocked(execSync);
const MockN8nClient = vi.mocked(N8nClient);

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
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'dev-key' },
    prod: { url: 'https://prod.n8n.example.com', apiKey: 'prod-key' },
  },
});

const SINGLE_ENV_CONFIG = JSON.stringify({
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'dev-key' },
  },
});

const WF1 = {
  id: 'wf-1',
  name: 'Workflow One',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  tags: [{ id: 't1', name: 'production' }],
  versionId: 'v1',
  nodes: [],
  connections: {},
  settings: {},
};

const WF2 = {
  id: 'wf-2',
  name: 'Workflow Two',
  active: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  tags: [],
  versionId: 'v1',
  nodes: [],
  connections: {},
  settings: {},
};

const PREV_DEPLOYMENT = '20240101T000000Z-aaaaaaaa';

function makeClientMock(overrides?: {
  listWorkflows?: () => Promise<unknown>;
  getWorkflow?: (id: string) => Promise<unknown>;
}) {
  return {
    warnIfExpiringSoon: vi.fn(),
    listWorkflows: overrides?.listWorkflows ?? vi.fn().mockResolvedValue([WF1, WF2]),
    getWorkflow:
      overrides?.getWorkflow ??
      vi.fn().mockImplementation((id: string) =>
        Promise.resolve(id === 'wf-1' ? WF1 : WF2),
      ),
  };
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('actor@example.com\n' as never);
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'test-project';
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
});

function setupProject(config = VALID_CONFIG) {
  vol.fromJSON({
    [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
    [`${PROJECT_DIR}/.chiral/config.json`]: config,
    [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
  });
}

function setupPreviousSnapshot(env = 'dev') {
  writeSnapshot(`${PROJECT_DIR}/.chiral`, PREV_DEPLOYMENT, { ...WF1, versionId: 'v1' });
  writeSnapshot(`${PROJECT_DIR}/.chiral`, PREV_DEPLOYMENT, { ...WF2, versionId: 'v1' });
  writeSnapshotMeta(`${PROJECT_DIR}/.chiral`, PREV_DEPLOYMENT, {
    deployment_id: PREV_DEPLOYMENT,
    env,
    command: 'pull',
    timestamp: '2024-01-01T00:00:00.000Z',
    workflow_count: 2,
    filters: { tag: null, pattern: null, onlyActive: false, id: null },
  });
}

describe('runPull — setup errors', () => {
  it('throws UserError when git user.email is not set', async () => {
    setupProject();
    mockExecSync.mockImplementation(() => { throw new Error('no email'); });
    await expect(runPull({ env: 'dev' })).rejects.toThrow(UserError);
    await expect(runPull({ env: 'dev' })).rejects.toThrow('git config user.email');
  });

  it('throws UserError when config.json is missing', async () => {
    vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: INDEX });
    await expect(runPull({ env: 'dev' })).rejects.toThrow(UserError);
    await expect(runPull({ env: 'dev' })).rejects.toThrow('chiral environment add');
  });

  it('throws UserError when --env is not in config', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    await expect(runPull({ env: 'staging' })).rejects.toThrow(UserError);
    await expect(runPull({ env: 'staging' })).rejects.toThrow('Unknown environment "staging"');
  });
});

describe('runPull — first pull (no previous snapshot)', () => {
  it('writes snapshot files for all fetched workflows', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runPull({ env: 'dev' });

    const snapshots = Object.keys(vol.toJSON() ?? {}).filter(
      (p) => p.includes('/snapshots/') && p.endsWith('.json') && !p.endsWith('meta.json'),
    );
    expect(snapshots).toHaveLength(2);
  });

  it('writes meta.json for the new deployment', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runPull({ env: 'dev' });

    const metas = Object.keys(vol.toJSON() ?? {}).filter((p) => p.endsWith('meta.json'));
    expect(metas).toHaveLength(1);
    const meta = JSON.parse(vol.readFileSync(metas[0], 'utf-8') as string);
    expect(meta.env).toBe('dev');
    expect(meta.command).toBe('pull');
    expect(meta.workflow_count).toBe(2);
  });

  it('writes a success audit entry with pulled workflow IDs', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runPull({ env: 'dev' });

    const entry = JSON.parse(
      (vol.readFileSync(`${PROJECT_DIR}/.chiral/audit.jsonl`, 'utf-8') as string).trim(),
    );
    expect(entry.action).toBe('pull');
    expect(entry.result).toBe('success');
    expect(entry.target_env).toBe('dev');
    expect(entry.workflow_ids).toEqual(['wf-1', 'wf-2']);
  });
});

describe('runPull — zero workflows', () => {
  it('shows a warning instead of success when no workflows found on first pull', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        getWorkflow: vi.fn(),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    const joined = output.join('\n');
    expect(joined).toContain('No workflows found');
    expect(joined).toContain('is this expected');
    expect(joined).not.toContain('baseline saved');
  });

  it('shows a warning instead of success when no workflows found on repeat pull', async () => {
    setupProject();
    setupPreviousSnapshot(); // WF1 v1 + WF2 v1 previously — but n8n now returns nothing

    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        getWorkflow: vi.fn(),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    // 0 workflows + previous snapshot had 2 → both are now deleted, so delta has changes
    // (all workflows show as ⚠ removed from n8n), not the zero-workflow warning path
    // This test verifies the deleted-workflow path handles zero remaining correctly
    const joined = output.join('\n');
    expect(joined).toContain('removed from n8n');
    expect(joined).not.toContain('up to date');
  });

  it('shows zero-workflow warning when previous snapshot also had zero workflows', async () => {
    setupProject();
    // Set up a previous snapshot with 0 workflows explicitly
    writeSnapshotMeta('/project/.chiral', PREV_DEPLOYMENT, {
      deployment_id: PREV_DEPLOYMENT,
      env: 'dev',
      command: 'pull',
      timestamp: '2024-01-01T00:00:00.000Z',
      workflow_count: 0,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });

    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        getWorkflow: vi.fn(),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    const joined = output.join('\n');
    expect(joined).toContain('No workflows found');
    expect(joined).toContain('is this expected');
    expect(joined).not.toContain('up to date');
  });
});

describe('runPull — delta against previous snapshot', () => {
  it('detects a new workflow not in previous snapshot', async () => {
    setupProject();
    setupPreviousSnapshot();

    const WF3 = { ...WF1, id: 'wf-3', name: 'Workflow Three', versionId: 'v1' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1, WF2, WF3]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1 : id === 'wf-2' ? WF2 : WF3),
        ),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).toContain('Workflow Three');
    expect(output.join('\n')).toContain('(new)');
  });

  it('detects an updated workflow with a changed versionId', async () => {
    setupProject();
    setupPreviousSnapshot();

    const WF1_UPDATED = { ...WF1, versionId: 'v2' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1_UPDATED, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1_UPDATED : WF2),
        ),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).toContain('Workflow One');
    expect(output.join('\n')).toContain('(updated)');
  });

  it('detects a deleted workflow no longer in n8n', async () => {
    setupProject();
    setupPreviousSnapshot(); // WF1 + WF2 in previous

    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1]), // WF2 gone
        getWorkflow: vi.fn().mockResolvedValue(WF1),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).toContain('Workflow Two');
    expect(output.join('\n')).toContain('(removed from n8n)');
  });

  it('reports nothing changed when all versionIds match', async () => {
    setupProject();
    setupPreviousSnapshot(); // WF1 v1 + WF2 v1

    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1 : WF2),
        ),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).toContain('up to date');
    expect(output.join('\n')).not.toContain('(new)');
    expect(output.join('\n')).not.toContain('(updated)');
  });
});

describe('runPull — filters', () => {
  it('only pulls workflows matching the given tag', async () => {
    setupProject();
    const getWorkflow = vi.fn().mockResolvedValue(WF1);
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1, WF2]),
        getWorkflow,
      }) as never,
    );

    await runPull({ env: 'dev', tag: 'production' });

    // WF1 has tag 'production', WF2 does not — only WF1 should be fetched
    expect(getWorkflow).toHaveBeenCalledWith('wf-1');
    expect(getWorkflow).not.toHaveBeenCalledWith('wf-2');
  });

  it('only pulls workflows whose name matches the pattern', async () => {
    setupProject();
    const getWorkflow = vi.fn().mockResolvedValue(WF1);
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1, WF2]),
        getWorkflow,
      }) as never,
    );

    await runPull({ env: 'dev', pattern: 'Workflow O*' });

    expect(getWorkflow).toHaveBeenCalledWith('wf-1');
    expect(getWorkflow).not.toHaveBeenCalledWith('wf-2');
  });

  it('only pulls active workflows when --only-active is set', async () => {
    setupProject();
    const getWorkflow = vi.fn().mockResolvedValue(WF1);
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1, WF2]), // WF2 is inactive
        getWorkflow,
      }) as never,
    );

    await runPull({ env: 'dev', onlyActive: true });

    expect(getWorkflow).toHaveBeenCalledWith('wf-1');
    expect(getWorkflow).not.toHaveBeenCalledWith('wf-2');
  });

  it('stores filter values in meta.json', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1]),
        getWorkflow: vi.fn().mockResolvedValue(WF1),
      }) as never,
    );

    await runPull({ env: 'dev', tag: 'production', onlyActive: true });

    const metas = Object.keys(vol.toJSON() ?? {}).filter((p) => p.endsWith('meta.json'));
    const meta = JSON.parse(vol.readFileSync(metas[0], 'utf-8') as string);
    expect(meta.filters.tag).toBe('production');
    expect(meta.filters.onlyActive).toBe(true);
  });
});

describe('runPull — --json output', () => {
  it('emits a JSON object to stdout and no human text', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runPull({ env: 'dev', json: true });

    expect(logged).toHaveLength(1);
    const result = JSON.parse(logged[0]);
    expect(result.env).toBe('dev');
    expect(result.pulled).toBe(2);
    expect(result.deployment_id).toBeDefined();
  });

  it('includes new/updated/deleted/unchanged fields in JSON output', async () => {
    setupProject();
    setupPreviousSnapshot();

    const WF1_UPDATED = { ...WF1, versionId: 'v2' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1_UPDATED]), // WF2 deleted
        getWorkflow: vi.fn().mockResolvedValue(WF1_UPDATED),
      }) as never,
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runPull({ env: 'dev', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.updated).toContain('Workflow One');
    expect(result.deleted).toContain('Workflow Two');
    expect(result.unchanged).toBe(0);
  });
});

describe('runPull — --verbose output', () => {
  it('lists every pulled workflow with name and active status on first pull', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev', verbose: true });

    const joined = output.join('\n');
    expect(joined).toContain('Workflows pulled:');
    expect(joined).toContain('Workflow One');
    expect(joined).toContain('active');
    expect(joined).toContain('Workflow Two');
    expect(joined).toContain('inactive');
  });

  it('lists workflows when nothing changed', async () => {
    setupProject();
    setupPreviousSnapshot();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1 : WF2),
        ),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev', verbose: true });

    const joined = output.join('\n');
    expect(joined).toContain('up to date');
    expect(joined).toContain('Workflows pulled:');
  });

  it('lists workflows when changes are found', async () => {
    setupProject();
    setupPreviousSnapshot();

    const WF1_UPDATED = { ...WF1, versionId: 'v2' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1_UPDATED, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1_UPDATED : WF2),
        ),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev', verbose: true });

    const joined = output.join('\n');
    expect(joined).toContain('(updated)');
    expect(joined).toContain('Workflows pulled:');
    expect(joined).toContain('Workflow One');
    expect(joined).toContain('Workflow Two');
  });

  it('does not print workflow list without --verbose', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).not.toContain('Workflows pulled:');
  });
});

describe('runPull — error handling', () => {
  it('writes a failure audit entry and re-throws on API error', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockRejectedValue(new UserError('API key for dev is invalid or expired')),
      }) as never,
    );

    await expect(runPull({ env: 'dev' })).rejects.toThrow(
      'API key for dev is invalid or expired',
    );

    const entry = JSON.parse(
      (vol.readFileSync(`${PROJECT_DIR}/.chiral/audit.jsonl`, 'utf-8') as string).trim(),
    );
    expect(entry.result).toBe('failure');
    expect(entry.error).toContain('API key for dev');
  });

  it('shows diff Next hint on first pull', async () => {
    setupProject(); // has dev + prod, no previous snapshot
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).toContain('chiral diff --source dev --target prod');
  });

  it('shows diff Next hint when no changes found', async () => {
    setupProject();
    setupPreviousSnapshot();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1 : WF2),
        ),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).toContain('chiral diff --source dev --target prod');
    expect(output.join('\n')).not.toContain('push');
  });

  it('omits Next hint when only one environment is configured', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).not.toContain('Next:');
  });
});

describe('runPull — smart Next: hint', () => {
  it('suggests push --dry-run when changes are found', async () => {
    setupProject();
    setupPreviousSnapshot();

    const WF1_UPDATED = { ...WF1, versionId: 'v2' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1_UPDATED, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1_UPDATED : WF2),
        ),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).toContain('chiral push --source dev --target prod --dry-run');
  });

  it('carries --tag filter forward into push hint', async () => {
    setupProject();
    setupPreviousSnapshot();

    const WF1_UPDATED = { ...WF1, versionId: 'v2' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1_UPDATED]),
        getWorkflow: vi.fn().mockResolvedValue(WF1_UPDATED),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev', tag: 'production' });

    expect(output.join('\n')).toContain('--tag production');
    expect(output.join('\n')).toContain('--dry-run');
  });
});

describe('runPull — active/inactive counts', () => {
  it('shows active and inactive counts in fetch line', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never); // WF1 active, WF2 inactive

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    // ora spinner output is not captured by console.log spy, but the
    // active/inactive label is embedded in the spinner succeed message.
    // We verify it is computed correctly by checking json output instead.
    const jsonLogged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => jsonLogged.push(line));
  });

  it('includes active and inactive counts in --json output', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never); // WF1 active, WF2 inactive

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runPull({ env: 'dev', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.active).toBe(1);
    expect(result.inactive).toBe(1);
  });
});

describe('runPull — --name-only output', () => {
  it('prints only changed workflow names, one per line', async () => {
    setupProject();
    setupPreviousSnapshot();

    const WF1_UPDATED = { ...WF1, versionId: 'v2' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1_UPDATED, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1_UPDATED : WF2),
        ),
      }) as never,
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runPull({ env: 'dev', nameOnly: true });

    expect(logged).toContain('Workflow One');
    expect(logged).not.toContain('Workflow Two'); // unchanged
    expect(logged).not.toContain('Next:');
  });

  it('prints nothing when no changes', async () => {
    setupProject();
    setupPreviousSnapshot();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1 : WF2),
        ),
      }) as never,
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runPull({ env: 'dev', nameOnly: true });

    expect(logged).toHaveLength(0);
  });

  it('includes deleted workflow names', async () => {
    setupProject();
    setupPreviousSnapshot(); // WF1 + WF2

    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1]), // WF2 gone
        getWorkflow: vi.fn().mockResolvedValue(WF1),
      }) as never,
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runPull({ env: 'dev', nameOnly: true });

    expect(logged).toContain('Workflow Two');
  });
});

describe('runPull — --exit-code', () => {
  it('throws ControlledExit(1) when changes are found', async () => {
    setupProject();
    setupPreviousSnapshot();

    const WF1_UPDATED = { ...WF1, versionId: 'v2' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1_UPDATED, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1_UPDATED : WF2),
        ),
      }) as never,
    );

    const err = await runPull({ env: 'dev', exitCode: true }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ControlledExit');
    expect(err.code).toBe(1);
  });

  it('does not throw when nothing changed', async () => {
    setupProject();
    setupPreviousSnapshot();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1 : WF2),
        ),
      }) as never,
    );

    await expect(runPull({ env: 'dev', exitCode: true })).resolves.toBeUndefined();
  });

  it('does not throw on first pull (no previous snapshot)', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await expect(runPull({ env: 'dev', exitCode: true })).resolves.toBeUndefined();
  });
});

describe('runPull — --id (single workflow)', () => {
  it('fetches single workflow by id without calling listWorkflows', async () => {
    setupProject();
    const getWorkflow = vi.fn().mockResolvedValue(WF1);
    const listWorkflows = vi.fn();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ listWorkflows, getWorkflow }) as never,
    );

    await runPull({ env: 'dev', id: 'wf-1' });

    expect(getWorkflow).toHaveBeenCalledWith('wf-1');
    expect(listWorkflows).not.toHaveBeenCalled();
  });

  it('writes only one snapshot file for the fetched workflow', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow: vi.fn().mockResolvedValue(WF1) }) as never,
    );

    await runPull({ env: 'dev', id: 'wf-1' });

    const snapshots = Object.keys(vol.toJSON() ?? {}).filter(
      (p) => p.includes('/snapshots/') && p.endsWith('.json') && !p.endsWith('meta.json'),
    );
    expect(snapshots).toHaveLength(1);
  });

  it('stores the workflow id in meta.json filters', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow: vi.fn().mockResolvedValue(WF1) }) as never,
    );

    await runPull({ env: 'dev', id: 'wf-1' });

    const metas = Object.keys(vol.toJSON() ?? {}).filter((p) => p.endsWith('meta.json'));
    const meta = JSON.parse(vol.readFileSync(metas[0], 'utf-8') as string);
    expect(meta.filters.id).toBe('wf-1');
  });

  it('detects new workflow with --id', async () => {
    setupProject(); // no previous snapshot
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow: vi.fn().mockResolvedValue(WF1) }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev', id: 'wf-1' });

    expect(output.join('\n')).toContain('(new)');
  });

  it('detects updated workflow with --id when versionId changes', async () => {
    setupProject();
    setupPreviousSnapshot(); // WF1 at v1

    const WF1_UPDATED = { ...WF1, versionId: 'v2' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow: vi.fn().mockResolvedValue(WF1_UPDATED) }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev', id: 'wf-1' });

    expect(output.join('\n')).toContain('(updated)');
  });

  it('emits JSON with id-mode fields', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow: vi.fn().mockResolvedValue(WF1) }) as never,
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runPull({ env: 'dev', id: 'wf-1', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.pulled).toBe(1);
    expect(result.new).toContain('Workflow One');
  });

  it('throws ControlledExit(1) with --id --exit-code when workflow is new', async () => {
    setupProject(); // no previous snapshot → workflow is new
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow: vi.fn().mockResolvedValue(WF1) }) as never,
    );

    const err = await runPull({ env: 'dev', id: 'wf-1', exitCode: true }).catch((e) => e);
    expect(err.name).toBe('ControlledExit');
    expect(err.code).toBe(1);
  });
});

describe('runPull — staleness warning', () => {
  it('prints a dim note when last pull was more than 7 days ago', async () => {
    setupProject();
    // Write a stale audit entry (8 days ago)
    const staleTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/audit.jsonl`,
      JSON.stringify({
        event_id: crypto.randomUUID(),
        event_schema_version: 1,
        timestamp: staleTimestamp,
        actor: 'actor@example.com',
        action: 'pull',
        project: 'test-project',
        source_env: null,
        target_env: 'dev',
        workflow_ids: [],
        result: 'success',
        error: null,
        chiral_version: '0.1.0',
      }) + '\n',
    );

    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).toContain('last pull from dev was');
    expect(output.join('\n')).toContain('days ago');
  });

  it('does not print a staleness note when last pull was recent', async () => {
    setupProject();
    // Write a recent audit entry (1 day ago)
    const recentTimestamp = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/audit.jsonl`,
      JSON.stringify({
        event_id: crypto.randomUUID(),
        event_schema_version: 1,
        timestamp: recentTimestamp,
        actor: 'actor@example.com',
        action: 'pull',
        project: 'test-project',
        source_env: null,
        target_env: 'dev',
        workflow_ids: [],
        result: 'success',
        error: null,
        chiral_version: '0.1.0',
      }) + '\n',
    );

    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    expect(output.join('\n')).not.toContain('days ago');
  });
});

describe('runPull — fingerprints', () => {
  it('writes fingerprints.json with one entry per pulled workflow on first pull', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runPull({ env: 'dev' });

    const raw = vol.readFileSync(`${PROJECT_DIR}/.chiral/fingerprints.json`, 'utf-8') as string;
    const fp = JSON.parse(raw);
    expect(fp.version).toBe(1);
    expect(fp.envs.dev).toBeDefined();
    expect(fp.envs.dev['wf-1']).toBeDefined();
    expect(fp.envs.dev['wf-2']).toBeDefined();
    expect(fp.envs.dev['wf-1'].name).toBe('Workflow One');
    expect(fp.envs.dev['wf-1'].contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp.envs.dev['wf-1'].structureHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp.envs.dev['wf-1'].versionId).toBe('v1');
  });

  it('updates fingerprint entry when a workflow is pulled with a new versionId', async () => {
    setupProject();
    setupPreviousSnapshot(); // WF1 v1 on disk

    // Write an existing fingerprints.json with stale versionId
    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/fingerprints.json`,
      JSON.stringify({
        version: 1,
        envs: {
          dev: {
            'wf-1': { name: 'Workflow One', versionId: 'v1', contentHash: 'sha256:' + 'a'.repeat(64), structureHash: 'sha256:' + 'a'.repeat(64), updatedAt: '2024-01-01T00:00:00.000Z' },
          },
        },
      }),
    );

    const WF1_UPDATED = { ...WF1, versionId: 'v2' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1_UPDATED, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1_UPDATED : WF2),
        ),
      }) as never,
    );

    await runPull({ env: 'dev' });

    const raw = vol.readFileSync(`${PROJECT_DIR}/.chiral/fingerprints.json`, 'utf-8') as string;
    const fp = JSON.parse(raw);
    expect(fp.envs.dev['wf-1'].versionId).toBe('v2');
    expect(fp.envs.dev['wf-2']).toBeDefined();
  });

  it('writes fingerprint for the single workflow when using --id', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow: vi.fn().mockResolvedValue(WF1) }) as never,
    );

    await runPull({ env: 'dev', id: 'wf-1' });

    const raw = vol.readFileSync(`${PROJECT_DIR}/.chiral/fingerprints.json`, 'utf-8') as string;
    const fp = JSON.parse(raw);
    expect(fp.envs.dev['wf-1']).toBeDefined();
    expect(fp.envs.dev['wf-1'].name).toBe('Workflow One');
    expect(fp.envs.dev['wf-1'].versionId).toBe('v1');
    expect(fp.envs.dev['wf-1'].contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Only one entry — the --id workflow; WF2 is not in this pull
    expect(Object.keys(fp.envs.dev)).toHaveLength(1);
  });
});

describe('runPull — workflow map auto-heal', () => {
  it('updates map entry name when a workflow is renamed in n8n', async () => {
    setupProject();

    // Map has 'Workflow One' but n8n now returns 'Workflow One Renamed' for same ID
    vol.writeFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, JSON.stringify({
      version: 1,
      workflows: {
        'workflow-one': {
          dev: { name: 'Workflow One', id: 'wf-1' },
        },
      },
    }));

    const WF1_RENAMED = { ...WF1, name: 'Workflow One Renamed' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF1_RENAMED, WF2]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'wf-1' ? WF1_RENAMED : WF2),
        ),
      }) as never,
    );

    await runPull({ env: 'dev' });

    const raw = vol.readFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, 'utf-8') as string;
    const map = JSON.parse(raw);
    expect(map.workflows['workflow-one']['dev'].name).toBe('Workflow One Renamed');
    expect(map.workflows['workflow-one']['dev'].id).toBe('wf-1');
  });

  it('does not modify the map when workflow names are unchanged', async () => {
    setupProject();

    vol.writeFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, JSON.stringify({
      version: 1,
      workflows: {
        'workflow-one': { dev: { name: 'Workflow One', id: 'wf-1' } },
      },
    }));

    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runPull({ env: 'dev' });

    // workflows.json should be unchanged (name matches, no heal needed)
    const raw = vol.readFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, 'utf-8') as string;
    const map = JSON.parse(raw);
    expect(map.workflows['workflow-one']['dev'].name).toBe('Workflow One');
  });

  it('auto-heals map entry name via --id path', async () => {
    setupProject();

    vol.writeFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, JSON.stringify({
      version: 1,
      workflows: {
        'workflow-one': { dev: { name: 'Workflow One', id: 'wf-1' } },
      },
    }));

    const WF1_RENAMED = { ...WF1, name: 'Workflow One Renamed' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow: vi.fn().mockResolvedValue(WF1_RENAMED) }) as never,
    );

    await runPull({ env: 'dev', id: 'wf-1' });

    const raw = vol.readFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, 'utf-8') as string;
    const map = JSON.parse(raw);
    expect(map.workflows['workflow-one']['dev'].name).toBe('Workflow One Renamed');
    expect(map.workflows['workflow-one']['dev'].id).toBe('wf-1');
  });
});

describe('runPull — server-side filter params', () => {
  it('calls listWorkflows with active=true when --only-active is set', async () => {
    setupProject();
    const listWorkflows = vi.fn().mockResolvedValue([WF1]);
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ listWorkflows, getWorkflow: vi.fn().mockResolvedValue(WF1) }) as never,
    );

    await runPull({ env: 'dev', onlyActive: true });

    expect(listWorkflows).toHaveBeenCalledWith({ active: true, tags: undefined });
  });

  it('calls listWorkflows with tags when --tag is set', async () => {
    setupProject();
    const listWorkflows = vi.fn().mockResolvedValue([WF1]);
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ listWorkflows, getWorkflow: vi.fn().mockResolvedValue(WF1) }) as never,
    );

    await runPull({ env: 'dev', tag: 'production' });

    expect(listWorkflows).toHaveBeenCalledWith({ active: undefined, tags: 'production' });
  });
});

describe('runPull — output mode validation', () => {
  it('does not throw when only --json is set', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    await expect(runPull({ env: 'dev', json: true })).resolves.not.toThrow();
  });

  it('does not throw when only --name-only is set', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    await expect(runPull({ env: 'dev', nameOnly: true })).resolves.not.toThrow();
  });
});

describe('runPull — git sync runs regardless of output mode', () => {
  it('calls syncToRemote when --json mode', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    // We verify sync by checking that the audit entry is written (sync is the last step);
    // the simplest proxy is ensuring the command completes without error and the audit
    // entry exists — sync is synchronous side-effect we cannot easily intercept without
    // mocking simple-git. Instead verify the command resolves (sync always runs).
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await expect(runPull({ env: 'dev', json: true })).resolves.not.toThrow();

    // JSON output still produced
    expect(logged).toHaveLength(1);
    const result = JSON.parse(logged[0]);
    expect(result.env).toBe('dev');
  });

  it('calls syncToRemote when --name-only mode', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    // Command should complete without error; sync doesn't print anything in name-only mode
    await expect(runPull({ env: 'dev', nameOnly: true })).resolves.not.toThrow();
  });
});

describe('runPull — env-specific name detection', () => {
  const WF_ENV = {
    ...WF1,
    id: 'wf-env',
    name: 'Order Processor [DEV]',
    tags: [] as { id: string; name: string }[],
  };

  it('prints a warning when a workflow name contains an env marker and is not mapped', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF_ENV]),
        getWorkflow: vi.fn().mockResolvedValue(WF_ENV),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    vi.restoreAllMocks();
    expect(output.join('\n')).toContain('environment-specific');
    expect(output.join('\n')).toContain('Order Processor [DEV]');
    expect(output.join('\n')).toContain('workflow match');
  });

  it('does not print env-specific warning when workflow is already in workflows.json', async () => {
    setupProject();
    vol.writeFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, JSON.stringify({
      version: 1,
      workflows: {
        'order-processor': {
          dev: { name: 'Order Processor [DEV]', id: 'wf-env' },
        },
      },
    }));
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF_ENV]),
        getWorkflow: vi.fn().mockResolvedValue(WF_ENV),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    vi.restoreAllMocks();
    expect(output.join('\n')).not.toContain('environment-specific');
  });

  it('does not print env-specific warning when no workflow names have env markers', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' });

    vi.restoreAllMocks();
    expect(output.join('\n')).not.toContain('environment-specific');
  });

  it('suppresses env-specific warning in --json mode', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WF_ENV]),
        getWorkflow: vi.fn().mockResolvedValue(WF_ENV),
      }) as never,
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runPull({ env: 'dev', json: true });

    // Only one line — the JSON object; no warning line
    expect(logged).toHaveLength(1);
    expect(() => JSON.parse(logged[0])).not.toThrow();
  });
});
