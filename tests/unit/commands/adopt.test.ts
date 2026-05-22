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
import { runAdopt } from '../../../src/commands/adopt.js';

const mockExecSync = vi.mocked(execSync);
const MockN8nClient = vi.mocked(N8nClient);

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
});

function setupFlightdeckDir() {
  vol.fromJSON({
    '/project/.flightdeck/config.json': VALID_CONFIG,
    '/project/.flightdeck/audit.jsonl': '',
  });
}

describe('runAdopt', () => {
  it('throws UserError when git user.email is not configured', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('no email'); });

    await expect(runAdopt({ env: 'dev' }, '/project')).rejects.toThrow(UserError);
    await expect(runAdopt({ env: 'dev' }, '/project')).rejects.toThrow('git config user.email');
  });

  it('throws UserError when config.json is missing', async () => {
    vol.fromJSON({});

    await expect(runAdopt({ env: 'dev' }, '/project')).rejects.toThrow(UserError);
    await expect(runAdopt({ env: 'dev' }, '/project')).rejects.toThrow('flightdeck init');
  });

  it('throws UserError when --env is not in config', async () => {
    setupFlightdeckDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await expect(runAdopt({ env: 'staging' }, '/project')).rejects.toThrow(UserError);
    await expect(runAdopt({ env: 'staging' }, '/project')).rejects.toThrow('Unknown environment "staging"');
  });

  it('creates N8nClient with correct env and envName', async () => {
    setupFlightdeckDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runAdopt({ env: 'dev' }, '/project');

    expect(MockN8nClient).toHaveBeenCalledWith(
      { url: 'https://dev.n8n.example.com', apiKey: 'test-key' },
      'dev',
    );
  });

  it('writes snapshot files for each workflow', async () => {
    setupFlightdeckDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runAdopt({ env: 'dev' }, '/project');

    const snapshots = Object.keys(vol.toJSON() ?? {}).filter((p) =>
      p.includes('/snapshots/') && p.endsWith('.json') && !p.endsWith('meta.json'),
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain('wf-1.json');
  });

  it('writes an audit log entry on success', async () => {
    setupFlightdeckDir();
    MockN8nClient.mockImplementation(() => makeClientMock() as never);

    await runAdopt({ env: 'dev' }, '/project');

    const auditContent = vol.readFileSync('/project/.flightdeck/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.action).toBe('adopt');
    expect(entry.result).toBe('success');
    expect(entry.target_env).toBe('dev');
    expect(entry.source_env).toBeNull();
    expect(entry.workflow_ids).toEqual([]);
    expect(entry.actor).toBe('actor@example.com');
    expect(entry.project).toBe('test-project');
  });

  it('writes a failure audit entry and re-throws on API error', async () => {
    setupFlightdeckDir();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockRejectedValue(new UserError('API key for dev is invalid or expired')),
      }) as never,
    );

    await expect(runAdopt({ env: 'dev' }, '/project')).rejects.toThrow(
      'API key for dev is invalid or expired',
    );

    const auditContent = vol.readFileSync('/project/.flightdeck/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.result).toBe('failure');
    expect(entry.error).toBe('API key for dev is invalid or expired');
  });

  it('prints workflow list with active/inactive status', async () => {
    setupFlightdeckDir();
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

    await runAdopt({ env: 'dev' }, '/project');
    spy.mockRestore();

    expect(output.join('\n')).toContain('My Workflow');
    expect(output.join('\n')).toContain('active');
    expect(output.join('\n')).toContain('Inactive Workflow');
    expect(output.join('\n')).toContain('inactive');
  });

  it('fetches full workflow JSON for each summary', async () => {
    setupFlightdeckDir();
    const getWorkflow = vi.fn().mockResolvedValue(WORKFLOW_FULL);
    MockN8nClient.mockImplementation(() =>
      makeClientMock({ getWorkflow }) as never,
    );

    await runAdopt({ env: 'dev' }, '/project');

    expect(getWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('handles zero workflows gracefully', async () => {
    setupFlightdeckDir();
    MockN8nClient.mockImplementation(() =>
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
      }) as never,
    );

    await expect(runAdopt({ env: 'dev' }, '/project')).resolves.not.toThrow();

    const auditContent = vol.readFileSync('/project/.flightdeck/audit.jsonl', 'utf-8') as string;
    const entry = JSON.parse(auditContent.trim());
    expect(entry.result).toBe('success');
  });
});
