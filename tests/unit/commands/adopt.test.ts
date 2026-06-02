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
import { runAdopt } from '../../../src/commands/adopt.js';

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
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'test-key' },
  },
});

const WORKFLOW_SUMMARY = {
  id: 'wf-1',
  name: 'My Workflow',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  tags: [],
  versionId: 'v1',
};

const WORKFLOW_FULL = {
  ...WORKFLOW_SUMMARY,
  nodes: [],
  connections: {},
  settings: {},
};

function makeClientMock(overrides?: Partial<{
  listWorkflows: () => Promise<unknown>;
  getWorkflow: () => Promise<unknown>;
  listCredentials: () => Promise<unknown>;
  listTags: () => Promise<unknown>;
}>) {
  return {
    warnIfExpiringSoon: vi.fn(),
    listWorkflows: overrides?.listWorkflows ?? vi.fn().mockResolvedValue([WORKFLOW_SUMMARY]),
    getWorkflow: overrides?.getWorkflow ?? vi.fn().mockResolvedValue(WORKFLOW_FULL),
    listCredentials: overrides?.listCredentials ?? vi.fn().mockResolvedValue([]),
    listTags: overrides?.listTags ?? vi.fn().mockResolvedValue([]),
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

function setupChiralDir() {
  vol.fromJSON({
    [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
    [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
    [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
  });
}

describe('runAdopt', () => {
  it('throws UserError when git user.email is not configured', async () => {
    setupChiralDir();
    mockExecSync.mockImplementation(() => { throw new Error('no email'); });

    await expect(runAdopt({ env: 'dev' })).rejects.toThrow(UserError);
    await expect(runAdopt({ env: 'dev' })).rejects.toThrow('git config user.email');
  });

  it('throws UserError when config.json is missing', async () => {
    vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: INDEX });

    await expect(runAdopt({ env: 'dev' })).rejects.toThrow(UserError);
    await expect(runAdopt({ env: 'dev' })).rejects.toThrow('chiral environment add');
  });

  it('throws UserError when --env is not in config', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await expect(runAdopt({ env: 'staging' })).rejects.toThrow(UserError);
    await expect(runAdopt({ env: 'staging' })).rejects.toThrow('Unknown environment "staging"');
  });

  it('creates N8nClient with correct env and envName', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runAdopt({ env: 'dev' });

    expect(MockN8nClient).toHaveBeenCalledWith(
      { url: 'https://dev.n8n.example.com', apiKey: 'test-key' },
      'dev',
    );
  });

  it('writes snapshot files for each workflow', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runAdopt({ env: 'dev' });

    const snapshots = Object.keys(vol.toJSON() ?? {}).filter((p) =>
      p.includes('/snapshots/') && p.endsWith('.json') && !p.endsWith('meta.json'),
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain('wf-1.json');
  });

  it('writes meta.json with content_hash after adopting workflows', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runAdopt({ env: 'dev' });

    const metas = Object.keys(vol.toJSON() ?? {}).filter((p) => p.endsWith('meta.json'));
    expect(metas).toHaveLength(1);
    const meta = JSON.parse(vol.readFileSync(metas[0], 'utf-8') as string);
    expect(meta.content_hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('writes an audit log entry on success', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runAdopt({ env: 'dev' });

    const auditContent = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.action).toBe('adopt');
    expect(entry.result).toBe('success');
    expect(entry.target_env).toBe('dev');
    expect(entry.source_env).toBeNull();
    expect(entry.workflow_ids).toEqual(['wf-1']);
    expect(entry.actor).toBe('actor@example.com');
    expect(entry.project).toBe('test-project');
  });

  it('writes a failure audit entry and re-throws on API error', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockRejectedValue(new UserError('API key for dev is invalid or expired')),
      }) as never,
    );

    await expect(runAdopt({ env: 'dev' })).rejects.toThrow(
      'API key for dev is invalid or expired',
    );

    const auditContent = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.result).toBe('failure');
    expect(entry.error).toBe('API key for dev is invalid or expired');
  });

  it('prints workflow list with active/inactive status', async () => {
    setupChiralDir();
    const inactiveWf = { ...WORKFLOW_SUMMARY, id: 'wf-2', name: 'Inactive Workflow', active: false };
    const inactiveFull = { ...WORKFLOW_FULL, id: 'wf-2', name: 'Inactive Workflow', active: false };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WORKFLOW_SUMMARY, inactiveWf]),
        getWorkflow: vi.fn()
          .mockResolvedValueOnce(WORKFLOW_FULL)
          .mockResolvedValueOnce(inactiveFull),
      }) as never,
    );

    const output: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runAdopt({ env: 'dev' });
    spy.mockRestore();

    expect(output.join('\n')).toContain('My Workflow');
    expect(output.join('\n')).toContain('active');
    expect(output.join('\n')).toContain('Inactive Workflow');
    expect(output.join('\n')).toContain('inactive');
  });

  it('fetches full workflow JSON for each summary', async () => {
    setupChiralDir();
    const getWorkflow = vi.fn().mockResolvedValue(WORKFLOW_FULL);
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow }) as never,
    );

    await runAdopt({ env: 'dev' });

    expect(getWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('handles zero workflows gracefully', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
      }) as never,
    );

    await expect(runAdopt({ env: 'dev' })).resolves.not.toThrow();

    const auditContent = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.result).toBe('success');
  });

  it('writes fingerprints.json after adopting workflows', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runAdopt({ env: 'dev' });

    const raw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    const fingerprints = JSON.parse(raw);
    expect(fingerprints.version).toBe(1);
    expect(fingerprints.envs.dev).toBeDefined();
    expect(fingerprints.envs.dev['wf-1']).toBeDefined();
  });

  it('writes all three fingerprint fields for each workflow', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runAdopt({ env: 'dev' });

    const raw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    const entry = JSON.parse(raw).envs.dev['wf-1'];
    expect(entry.name).toBe('My Workflow');
    expect(entry.versionId).toBe('v1');
    expect(entry.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.structureHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.updatedAt).toBeTruthy();
  });

  it('writes a fingerprint entry for each adopted workflow', async () => {
    setupChiralDir();
    const wf2Summary = { ...WORKFLOW_SUMMARY, id: 'wf-2', name: 'Second Workflow' };
    const wf2Full = { ...WORKFLOW_FULL, id: 'wf-2', name: 'Second Workflow' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WORKFLOW_SUMMARY, wf2Summary]),
        getWorkflow: vi.fn()
          .mockResolvedValueOnce(WORKFLOW_FULL)
          .mockResolvedValueOnce(wf2Full),
      }) as never,
    );

    await runAdopt({ env: 'dev' });

    const raw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    const envEntries = JSON.parse(raw).envs.dev;
    expect(Object.keys(envEntries)).toHaveLength(2);
    expect(envEntries['wf-1']).toBeDefined();
    expect(envEntries['wf-2']).toBeDefined();
  });

  it('does not write fingerprints.json when the API call fails', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockRejectedValue(new UserError('connection refused')),
      }) as never,
    );

    await expect(runAdopt({ env: 'dev' })).rejects.toThrow();

    expect(vol.existsSync('/project/.chiral/fingerprints.json')).toBe(false);
  });
});

describe('runAdopt - audit workflow_ids', () => {
  it('records adopted workflow IDs in the audit entry', async () => {
    setupChiralDir();
    const wf2Summary = { ...WORKFLOW_SUMMARY, id: 'wf-2', name: 'Second Workflow' };
    const wf2Full = { ...WORKFLOW_FULL, id: 'wf-2', name: 'Second Workflow' };
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([WORKFLOW_SUMMARY, wf2Summary]),
        getWorkflow: vi.fn()
          .mockResolvedValueOnce(WORKFLOW_FULL)
          .mockResolvedValueOnce(wf2Full),
      }) as never,
    );

    await runAdopt({ env: 'dev' });

    const auditContent = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.workflow_ids).toContain('wf-1');
    expect(entry.workflow_ids).toContain('wf-2');
    expect(entry.workflow_ids).toHaveLength(2);
  });

  it('records empty array when no workflows are adopted', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
      }) as never,
    );

    await runAdopt({ env: 'dev' });

    const auditContent = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.workflow_ids).toEqual([]);
  });
});

describe('runAdopt - fingerprints summary output', () => {
  it('prints a fingerprints saved confirmation line', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runAdopt({ env: 'dev' });

    vi.restoreAllMocks();
    expect(output.join('\n')).toContain('Fingerprints saved');
    expect(output.join('\n')).toContain('fingerprints.json');
    expect(output.join('\n')).toContain('1 workflow');
  });
});

describe('runAdopt - env-specific name detection', () => {
  const ENV_WORKFLOW_SUMMARY = {
    ...WORKFLOW_SUMMARY,
    id: 'wf-env',
    name: 'Order Processor [DEV]',
  };
  const ENV_WORKFLOW_FULL = {
    ...WORKFLOW_FULL,
    id: 'wf-env',
    name: 'Order Processor [DEV]',
  };

  it('prints a warning when a workflow name contains an env marker and is not mapped', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([ENV_WORKFLOW_SUMMARY]),
        getWorkflow: vi.fn().mockResolvedValue(ENV_WORKFLOW_FULL),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runAdopt({ env: 'dev' });

    vi.restoreAllMocks();
    expect(output.join('\n')).toContain('environment-specific');
    expect(output.join('\n')).toContain('Order Processor [DEV]');
    expect(output.join('\n')).toContain('workflow match');
  });

  it('does not print env-specific warning when the workflow is already in workflows.json', async () => {
    setupChiralDir();
    vol.writeFileSync('/project/.chiral/workflows.json', JSON.stringify({
      version: 1,
      workflows: {
        'order-processor': {
          dev: { name: 'Order Processor [DEV]', id: 'wf-env' },
        },
      },
    }));
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([ENV_WORKFLOW_SUMMARY]),
        getWorkflow: vi.fn().mockResolvedValue(ENV_WORKFLOW_FULL),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runAdopt({ env: 'dev' });

    vi.restoreAllMocks();
    expect(output.join('\n')).not.toContain('environment-specific');
  });

  it('does not print env-specific warning when workflow names have no env markers', async () => {
    setupChiralDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runAdopt({ env: 'dev' });

    vi.restoreAllMocks();
    expect(output.join('\n')).not.toContain('environment-specific');
  });
});
