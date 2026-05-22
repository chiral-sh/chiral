import { describe, it, expect, vi, beforeEach } from 'vitest';
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
});

function setupProject(config = VALID_CONFIG) {
  vol.fromJSON({
    '/project/.flightdeck/config.json': config,
    '/project/.flightdeck/audit.jsonl': '',
  });
}

function setupPreviousSnapshot(env = 'dev') {
  writeSnapshot('/project/.flightdeck', PREV_DEPLOYMENT, { ...WF1, versionId: 'v1' });
  writeSnapshot('/project/.flightdeck', PREV_DEPLOYMENT, { ...WF2, versionId: 'v1' });
  writeSnapshotMeta('/project/.flightdeck', PREV_DEPLOYMENT, {
    deployment_id: PREV_DEPLOYMENT,
    env,
    command: 'pull',
    timestamp: '2024-01-01T00:00:00.000Z',
    workflow_count: 2,
    filters: { tag: null, pattern: null, onlyActive: false },
  });
}

describe('runPull — setup errors', () => {
  it('throws UserError when git user.email is not set', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('no email'); });
    await expect(runPull({ env: 'dev' }, '/project')).rejects.toThrow(UserError);
    await expect(runPull({ env: 'dev' }, '/project')).rejects.toThrow('git config user.email');
  });

  it('throws UserError when config.json is missing', async () => {
    vol.fromJSON({});
    await expect(runPull({ env: 'dev' }, '/project')).rejects.toThrow(UserError);
    await expect(runPull({ env: 'dev' }, '/project')).rejects.toThrow('flightdeck init');
  });

  it('throws UserError when --env is not in config', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    await expect(runPull({ env: 'staging' }, '/project')).rejects.toThrow(UserError);
    await expect(runPull({ env: 'staging' }, '/project')).rejects.toThrow('Unknown environment "staging"');
  });
});

describe('runPull — first pull (no previous snapshot)', () => {
  it('writes snapshot files for all fetched workflows', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runPull({ env: 'dev' }, '/project');

    const snapshots = Object.keys(vol.toJSON() ?? {}).filter(
      (p) => p.includes('/snapshots/') && p.endsWith('.json') && !p.endsWith('meta.json'),
    );
    expect(snapshots).toHaveLength(2);
  });

  it('writes meta.json for the new deployment', async () => {
    setupProject();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runPull({ env: 'dev' }, '/project');

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

    await runPull({ env: 'dev' }, '/project');

    const entry = JSON.parse(
      (vol.readFileSync('/project/.flightdeck/audit.jsonl', 'utf-8') as string).trim(),
    );
    expect(entry.action).toBe('pull');
    expect(entry.result).toBe('success');
    expect(entry.target_env).toBe('dev');
    expect(entry.workflow_ids).toEqual(['wf-1', 'wf-2']);
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

    await runPull({ env: 'dev' }, '/project');

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

    await runPull({ env: 'dev' }, '/project');

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

    await runPull({ env: 'dev' }, '/project');

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

    await runPull({ env: 'dev' }, '/project');

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

    await runPull({ env: 'dev', tag: 'production' }, '/project');

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

    await runPull({ env: 'dev', pattern: 'Workflow O*' }, '/project');

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

    await runPull({ env: 'dev', onlyActive: true }, '/project');

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

    await runPull({ env: 'dev', tag: 'production', onlyActive: true }, '/project');

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

    await runPull({ env: 'dev', json: true }, '/project');

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

    await runPull({ env: 'dev', json: true }, '/project');

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

    await runPull({ env: 'dev', verbose: true }, '/project');

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

    await runPull({ env: 'dev', verbose: true }, '/project');

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

    await runPull({ env: 'dev', verbose: true }, '/project');

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

    await runPull({ env: 'dev' }, '/project');

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

    await expect(runPull({ env: 'dev' }, '/project')).rejects.toThrow(
      'API key for dev is invalid or expired',
    );

    const entry = JSON.parse(
      (vol.readFileSync('/project/.flightdeck/audit.jsonl', 'utf-8') as string).trim(),
    );
    expect(entry.result).toBe('failure');
    expect(entry.error).toContain('API key for dev');
  });

  it('shows Next hint pointing to the other configured env', async () => {
    setupProject(); // has dev + prod
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' }, '/project');

    expect(output.join('\n')).toContain('flightdeck diff --source dev --target prod');
  });

  it('omits Next hint when only one environment is configured', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPull({ env: 'dev' }, '/project');

    expect(output.join('\n')).not.toContain('Next:');
  });
});
