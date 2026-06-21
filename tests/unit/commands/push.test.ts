import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { UserError, ControlledExit } from '../../../src/lib/errors.js';
import * as prompts from '@inquirer/prompts';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
}));

vi.mock('../../../src/lib/n8n-client.js', () => ({
  N8nClient: vi.fn(),
}));

vi.mock('../../../src/state/snapshots.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/state/snapshots.js')>(
    '../../../src/state/snapshots.js',
  );
  return { ...actual };
});

import { execSync } from 'node:child_process';
import { N8nClient } from '../../../src/lib/n8n-client.js';
import { runPush, pushCommand } from '../../../src/commands/push.js';
import { computeContentHash } from '../../../src/state/fingerprints.js';
import { readAuditLog } from '../../../src/state/audit.js';
import type { WorkflowSummary, CredentialSummary, TagSummary } from '../../../src/lib/n8n-client.js';
import type { SnapshotWorkflow } from '../../../src/state/snapshots.js';
import * as snapshots from '../../../src/state/snapshots.js';

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

function makeSnapshotWf(id: string, name: string, versionId: string, tags: string[] = [], creds: string[] = []): SnapshotWorkflow {
  const nodes = creds.map((c) => ({
    id: `node-${c}`,
    name: 'Node',
    type: 'test-type',
    credentials: { myCred: { id: 'c1', name: c } },
  }));
  return {
    id,
    name,
    versionId,
    active: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    tags: tags.map((t) => ({ id: `tag-${t}`, name: t })),
    nodes,
    connections: {},
  };
}

function makeSummary(id: string, name: string, versionId: string, active = true): WorkflowSummary {
  return {
    id,
    name,
    versionId,
    active,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    tags: [],
  };
}

type MockTargetClient = {
  warnIfExpiringSoon: ReturnType<typeof vi.fn>;
  listWorkflows: ReturnType<typeof vi.fn>;
  listCredentials: ReturnType<typeof vi.fn>;
  listTags: ReturnType<typeof vi.fn>;
};

function makeTargetClientMock(overrides?: Partial<MockTargetClient>): MockTargetClient {
  return {
    warnIfExpiringSoon: vi.fn(),
    listWorkflows: overrides?.listWorkflows ?? vi.fn().mockResolvedValue([]),
    listCredentials: overrides?.listCredentials ?? vi.fn().mockResolvedValue([]),
    listTags: overrides?.listTags ?? vi.fn().mockResolvedValue([]),
  };
}

type FullMockTargetClient = MockTargetClient & {
  getWorkflow: ReturnType<typeof vi.fn>;
  createWorkflow: ReturnType<typeof vi.fn>;
  updateWorkflow: ReturnType<typeof vi.fn>;
  activateWorkflow: ReturnType<typeof vi.fn>;
  deactivateWorkflow: ReturnType<typeof vi.fn>;
};

function makeFullTargetClientMock(overrides?: Partial<FullMockTargetClient>): FullMockTargetClient {
  return {
    warnIfExpiringSoon: vi.fn(),
    listWorkflows: overrides?.listWorkflows ?? vi.fn().mockResolvedValue([]),
    listCredentials: overrides?.listCredentials ?? vi.fn().mockResolvedValue([]),
    listTags: overrides?.listTags ?? vi.fn().mockResolvedValue([]),
    getWorkflow: overrides?.getWorkflow ?? vi.fn().mockResolvedValue({ id: 'tgt-1', name: 'WF', nodes: [], connections: {}, settings: {}, versionId: 'v1', active: false, tags: [], createdAt: '', updatedAt: '' }),
    createWorkflow: overrides?.createWorkflow ?? vi.fn().mockResolvedValue({ id: 'new-id', versionId: 'created-v1' }),
    updateWorkflow: overrides?.updateWorkflow ?? vi.fn().mockResolvedValue({ versionId: 'updated-v1' }),
    activateWorkflow: overrides?.activateWorkflow ?? vi.fn().mockResolvedValue(undefined),
    deactivateWorkflow: overrides?.deactivateWorkflow ?? vi.fn().mockResolvedValue(undefined),
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

const PUSH_ENV_IDS = { dev: 'devpush1', prod: 'prdpush1' };
const PUSH_ENVS_JSON = JSON.stringify({ version: 1, envs: PUSH_ENV_IDS });

function setupProject(snapshotWorkflows: SnapshotWorkflow[] = [], targetWorkflows: WorkflowSummary[] = []) {
  vol.fromJSON({
    [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
    [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
    [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
    [`${PROJECT_DIR}/.chiral/envs.json`]: PUSH_ENVS_JSON,
    [`${PROJECT_DIR}/.chiral/credentials.json`]: JSON.stringify({
      version: 1,
      credentials: {
        postgres: { dev: 'dev_pg', prod: 'prod_pg' },
      },
    }),
  });

  if (snapshotWorkflows.length > 0) {
    const deploymentId = '20260522T120000Z-abcdef12';
    const snapshotDir = `/project/.chiral/snapshots/${deploymentId}`;
    vol.mkdirSync(snapshotDir, { recursive: true });
    vol.writeFileSync(
      `${snapshotDir}/meta.json`,
      JSON.stringify({
        deployment_id: deploymentId,
        env: 'dev',
        command: 'pull',
        timestamp: new Date().toISOString(),
        workflow_count: snapshotWorkflows.length,
        filters: { tag: null, pattern: null, onlyActive: false, id: null },
      }),
    );
    for (const wf of snapshotWorkflows) {
      vol.writeFileSync(`${snapshotDir}/${wf.id}.json`, JSON.stringify(wf));
    }
  }

  MockN8nClient.mockImplementation(function(_env, envName) {
    if (envName === 'prod') {
      return makeTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue(targetWorkflows),
        listCredentials: vi.fn().mockResolvedValue([{ name: 'prod_pg' } as CredentialSummary]),
        listTags: vi.fn().mockResolvedValue([{ name: 'billing', id: 'tag-1' } as TagSummary]),
      }) as never;
    }
    return makeTargetClientMock() as never;
  });
}

// ── guards and options ────────────────────────────────────────────────────────

describe('runPush (dry-run) - guards', () => {
  it('throws UserError when source equals target', async () => {
    await expect(
      runPush({ from: 'dev', to: 'dev', dryRun: true }),
    ).rejects.toThrow('source and target are both "dev"');
  });

  it('throws when no snapshot exists for source', async () => {
    setupProject(); // empty project, no snapshot
    await expect(
      runPush({ from: 'dev', to: 'prod', dryRun: true }),
    ).rejects.toThrow('No snapshot found for dev');
  });

  it('throws UserError when source env is not in config', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1')]);
    await expect(
      runPush({ from: 'staging', to: 'prod', dryRun: true }),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('throws UserError when target env is not in config', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1')]);
    await expect(
      runPush({ from: 'dev', to: 'staging', dryRun: true }),
    ).rejects.toBeInstanceOf(UserError);
  });
});

// ── classification (create / update / skip) ───────────────────────────────────

describe('runPush (dry-run) - classification', () => {
  it('classifies as would-create when target lacks workflow', async () => {
    setupProject([makeSnapshotWf('src-1', 'New WF', 'v1')], []);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('+');
    expect(joined).toContain('New WF');
    expect(joined).toContain('will be created');
  });

  it('classifies as would-update when versionIds differ', async () => {
    setupProject(
      [makeSnapshotWf('src-1', 'Existing WF', 'v2')],
      [makeSummary('tgt-1', 'Existing WF', 'v1')],
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('~');
    expect(joined).toContain('Existing WF');
    expect(joined).toContain('will be updated');
  });

  it('classifies as skipped when versionIds match', async () => {
    setupProject(
      [makeSnapshotWf('src-1', 'Unchanged WF', 'v1')],
      [makeSummary('tgt-1', 'Unchanged WF', 'v1')],
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('─');
    expect(joined).toContain('Unchanged WF');
    expect(joined).toContain('skipped');
  });

  it('adds active note to update when target is active', async () => {
    setupProject(
      [makeSnapshotWf('src-1', 'Active WF', 'v2')],
      [makeSummary('tgt-1', 'Active WF', 'v1', true)], // active in prod
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    expect(output.join('\n')).toContain('active, will be paused briefly');
  });
});

// ── credential mapping ────────────────────────────────────────────────────────

describe('runPush (dry-run) - credential mapping', () => {
  it('shows mapping for credentials found in nodes', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', [], ['dev_pg'])]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('Credential map:');
    expect(joined).toContain('dev_pg');
    expect(joined).toContain('prod_pg');
    expect(joined).toContain('✓');
  });

  it('shows passthrough warning for unmapped credentials', async () => {
    // dev_stripe is not in credentials.json
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', [], ['dev_stripe'])]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('dev_stripe');
    expect(joined).toContain('⚠');
    expect(joined).toContain('passing through unchanged');
  });

  it('aborts with error when mapped target credential does not exist', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', [], ['dev_pg'])]);

    // Override mock to return empty credentials from target
    MockN8nClient.mockImplementation(function() {
      return makeTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]), // missing prod_pg!
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    const err = await runPush({ from: 'dev', to: 'prod', dryRun: true }).catch(e => e);

    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(1);

    const joined = output.join('\n');
    expect(joined).toContain('✗');
    expect(joined).toContain('missing in prod');
    expect(joined).toContain('Cannot push');
    expect(joined).toContain('chiral credential map postgres prod=prod_pg');
  });
});

// ── tag warnings ──────────────────────────────────────────────────────────────

describe('runPush (dry-run) - tag warnings', () => {
  it('warns when snapshot workflow has a tag missing in target', async () => {
    // 'unknown_tag' is not returned by targetClient.listTags()
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', ['unknown_tag'])]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('⚠');
    expect(joined).toContain('Tag "unknown_tag" not found in');
  });

  it('does not warn when tag exists in target', async () => {
    // 'billing' is returned by our targetClient mock
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', ['billing'])]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).not.toContain('Tag "billing" not found');
  });
});

// ── stale snapshot prompt ─────────────────────────────────────────────────────

describe('runPush (dry-run) - stale snapshot', () => {
  it('prompts and aborts if snapshot is > 24h old and user says no', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1')]);

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const meta = {
      deployment_id: '20260522T120000Z-abcdef12',
      env: 'dev',
      command: 'pull',
      timestamp: twoDaysAgo,
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null }
    };
    vol.writeFileSync(
      '/project/.chiral/snapshots/20260522T120000Z-abcdef12/meta.json',
      JSON.stringify(meta),
    );

    // Mock confirm to return false
    vi.mocked(prompts.confirm).mockResolvedValue(false);

    const err = await runPush({ from: 'dev', to: 'prod', dryRun: true }).catch(e => e);
    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(0);
    expect(prompts.confirm).toHaveBeenCalled();
  });

  it('prompts as stale when meta.json is unreadable/corrupt (readSnapshotMeta returns null)', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1')]);

    // findLatestDeploymentForEnv resolves the deployment via its own internal
    // (unmocked) call to readSnapshotMeta. The subsequent stale-check call -
    // the one push.ts makes directly - returns null (e.g. a torn meta.json
    // read mid-write); this must still be treated as stale, not silently
    // skipped.
    const spy = vi.spyOn(snapshots, 'readSnapshotMeta').mockReturnValue(null);

    vi.mocked(prompts.confirm).mockResolvedValue(false);

    const err = await runPush({ from: 'dev', to: 'prod', dryRun: true }).catch(e => e);
    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(0);
    expect(prompts.confirm).toHaveBeenCalled();

    spy.mockRestore();
  });

  it('skips prompt when --yes is passed', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1')]);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const meta = {
      deployment_id: '20260522T120000Z-abcdef12',
      env: 'dev',
      command: 'pull',
      timestamp: twoDaysAgo,
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null }
    };
    vol.writeFileSync(
      '/project/.chiral/snapshots/20260522T120000Z-abcdef12/meta.json',
      JSON.stringify(meta),
    );

    vi.mocked(prompts.confirm).mockResolvedValue(true);

    await runPush({ from: 'dev', to: 'prod', dryRun: true, yes: true });
    expect(prompts.confirm).not.toHaveBeenCalled();
  });
});

// ── JSON output ───────────────────────────────────────────────────────────────

describe('runPush (dry-run) - JSON output', () => {
  it('emits valid json matching expected structure', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v2', ['billing'], ['dev_pg'])], [makeSummary('tgt-1', 'W1', 'v1')]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ from: 'dev', to: 'prod', dryRun: true, json: true });

    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);

    expect(parsed.status).toBe('ok');
    expect(parsed.data.from).toBe('dev');
    expect(parsed.data.dry_run).toBe(true);
    expect(parsed.data.updated).toContain('W1');
    expect(parsed.data.created).toEqual([]);
    expect(parsed.data.credential_map[0].targetName).toBe('prod_pg');
    expect(parsed.data.credential_errors).toEqual([]);
  });

  it('exits 1 and includes credential_errors in json when mapped credential is missing', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', [], ['dev_pg'])]);

    MockN8nClient.mockImplementation(function() {
      return makeTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]), // prod_pg missing
        listTags: vi.fn().mockResolvedValue([]),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    const err = await runPush({ from: 'dev', to: 'prod', dryRun: true, json: true }).catch(e => e);

    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(1);
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.data.credential_errors).toHaveLength(1);
    expect(parsed.data.credential_errors[0].targetName).toBe('prod_pg');
  });

  it('includes deployment_id (not null) in json when no workflows match filters', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', [], [])]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ from: 'dev', to: 'prod', dryRun: true, json: true, pattern: 'NoMatch*' });

    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.data.deployment_id).toBe('20260522T120000Z-abcdef12');
    expect(parsed.data.credential_errors).toEqual([]);
  });
});

// ── filters ───────────────────────────────────────────────────────────────────

describe('runPush (dry-run) - filters', () => {
  it('--tag excludes workflows that do not have the tag', async () => {
    setupProject([
      makeSnapshotWf('src-1', 'Tagged WF', 'v1', ['billing']),
      makeSnapshotWf('src-2', 'Untagged WF', 'v1', []),
    ]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true, tag: 'billing' });

    const joined = output.join('\n');
    expect(joined).toContain('Tagged WF');
    expect(joined).not.toContain('Untagged WF');
  });

  it('--pattern excludes workflows whose names do not match the glob', async () => {
    setupProject([
      makeSnapshotWf('src-1', 'Customer Orders', 'v1'),
      makeSnapshotWf('src-2', 'Billing Pipeline', 'v1'),
    ]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true, pattern: 'Customer *' });

    const joined = output.join('\n');
    expect(joined).toContain('Customer Orders');
    expect(joined).not.toContain('Billing Pipeline');
  });

  it('does not include skipped workflows nodes in credential map validation', async () => {
    // src-1 is skipped (same versionId), src-2 is new
    // src-1 references dev_pg which maps to prod_pg (exists in target)
    // src-2 has no credentials - should produce no credential errors
    setupProject(
      [
        makeSnapshotWf('src-1', 'Unchanged WF', 'v1', [], ['dev_pg']),
        makeSnapshotWf('src-2', 'New WF', 'v1', [], []),
      ],
      [makeSummary('tgt-1', 'Unchanged WF', 'v1')],
    );

    MockN8nClient.mockImplementation(function() {
      return makeTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([makeSummary('tgt-1', 'Unchanged WF', 'v1')]),
        listCredentials: vi.fn().mockResolvedValue([]), // prod_pg NOT present - would abort if skipped wf is included
        listTags: vi.fn().mockResolvedValue([]),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    // Should succeed: skipped workflow's credentials are not validated
    await expect(
      runPush({ from: 'dev', to: 'prod', dryRun: true }),
    ).resolves.toBeUndefined();

    expect(output.join('\n')).not.toContain('Cannot push');
  });
});

// ── summary line ──────────────────────────────────────────────────────────────

describe('runPush (dry-run) - summary', () => {
  it('shows already-in-sync message when all workflows are up to date', async () => {
    setupProject(
      [makeSnapshotWf('src-1', 'Same WF', 'v1')],
      [makeSummary('tgt-1', 'Same WF', 'v1')],
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    expect(output.join('\n')).toContain('already in sync');
  });
});

// ── fingerprint-based classification ─────────────────────────────────────────

describe('runPush (dry-run) - fingerprint-based classification', () => {
  it('classifies as skipped when target fingerprint contentHash matches source despite different versionId', async () => {
    const wf = makeSnapshotWf('src-1', 'Same Content WF', 'v2');
    // Target has versionId v1 (differs from snapshot v2), but same actual content
    setupProject([wf], [makeSummary('tgt-1', 'Same Content WF', 'v1')]);

    // Pre-populate target fingerprints with a hash matching the source snapshot
    const hash = computeContentHash(wf as Record<string, unknown>);
    vol.writeFileSync(
      '/project/.chiral/fingerprints.json',
      JSON.stringify({
        version: 1,
        envs: {
          prod: {
            'tgt-1': {
              name: 'Same Content WF',
              versionId: 'v1',
              contentHash: hash,
              structureHash: 'sha256:' + 'a'.repeat(64),
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          },
        },
      }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('─');
    expect(joined).toContain('Same Content WF');
    expect(joined).toContain('skipped');
    expect(joined).not.toContain('will be updated');
  });

  it('classifies as would-update when target fingerprint contentHash differs from source', async () => {
    const wf = makeSnapshotWf('src-1', 'Changed WF', 'v2');
    setupProject([wf], [makeSummary('tgt-1', 'Changed WF', 'v1')]);

    // Different hash → content has genuinely changed
    vol.writeFileSync(
      '/project/.chiral/fingerprints.json',
      JSON.stringify({
        version: 1,
        envs: {
          prod: {
            'tgt-1': {
              name: 'Changed WF',
              versionId: 'v1',
              contentHash: 'sha256:' + 'b'.repeat(64), // intentionally different
              structureHash: 'sha256:' + 'b'.repeat(64),
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          },
        },
      }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('~');
    expect(joined).toContain('Changed WF');
    expect(joined).toContain('will be updated');
  });
});

// ── dry-run: no workflow map writes ──────────────────────────────────────────

describe('runPush (dry-run) - workflow map not written', () => {
  it('does not create workflows.json when dry-run mode is used', async () => {
    setupProject([makeSnapshotWf('src-1', 'New WF', 'v1')], []);

    await runPush({ from: 'dev', to: 'prod', dryRun: true, yes: true });

    expect(vol.existsSync('/project/.chiral/workflows.json')).toBe(false);
  });
});

// ── live push fingerprint writes ──────────────────────────────────────────────

describe('runPush (live) - fingerprint writes', () => {
  it('writes fingerprint to target env after successful createWorkflow', async () => {
    const wf = makeSnapshotWf('src-1', 'New WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' }),
      }) as never;
    });

    await runPush({ from: 'dev', to: 'prod', yes: true });

    const raw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    const fp = JSON.parse(raw);
    const entry = fp.envs?.prod?.['tgt-new'];
    expect(entry).toBeDefined();
    expect(entry.name).toBe('New WF');
    expect(entry.versionId).toBe('created-v1');
    expect(entry.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.structureHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('writes fingerprint to target env after successful updateWorkflow', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false); // inactive
    setupProject([wf], [targetWf]);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([targetWf]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        getWorkflow: vi.fn().mockResolvedValue({ ...targetWf, nodes: [], connections: {}, settings: {} }),
        updateWorkflow: vi.fn().mockResolvedValue({ versionId: 'updated-v1' }),
      }) as never;
    });

    await runPush({ from: 'dev', to: 'prod', yes: true });

    const raw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    const fp = JSON.parse(raw);
    const entry = fp.envs?.prod?.['tgt-1'];
    expect(entry).toBeDefined();
    expect(entry.name).toBe('Existing WF');
    expect(entry.versionId).toBe('updated-v1');
    expect(entry.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('does a follow-up updateWorkflow when created workflow has a description', async () => {
    const wf = { ...makeSnapshotWf('src-1', 'New WF', 'v1'), description: 'Handles orders' };
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' });
    const updateWorkflow = vi.fn().mockResolvedValue({ versionId: 'desc-v1' });

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
        updateWorkflow,
      }) as never;
    });

    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(createWorkflow).toHaveBeenCalledOnce();
    // description must not be in the POST body
    expect(createWorkflow.mock.calls[0][0]).not.toHaveProperty('description');
    // follow-up PUT must include description
    expect(updateWorkflow).toHaveBeenCalledOnce();
    expect(updateWorkflow.mock.calls[0][1]).toHaveProperty('description', 'Handles orders');
  });

  it('does not call updateWorkflow after create when workflow has no description', async () => {
    const wf = makeSnapshotWf('src-1', 'New WF', 'v1'); // no description field
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' });
    const updateWorkflow = vi.fn().mockResolvedValue({ versionId: 'v1' });

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
        updateWorkflow,
      }) as never;
    });

    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(createWorkflow).toHaveBeenCalledOnce();
    expect(updateWorkflow).not.toHaveBeenCalled();
  });

  it('does not write fingerprint when createWorkflow fails', async () => {
    const wf = makeSnapshotWf('src-1', 'Failing WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockRejectedValue(new Error('API error')),
      }) as never;
    });

    // suppress console output - we're only checking the fingerprints file
    vi.spyOn(console, 'log').mockImplementation(function() { });
    vi.spyOn(console, 'error').mockImplementation(function() { });

    await runPush({ from: 'dev', to: 'prod', yes: true }).catch(() => { });

    expect(vol.existsSync('/project/.chiral/fingerprints.json')).toBe(false);
  });
});

// ── live push idempotency with mapped credentials (C1/M3/M6) ──────────────────

describe('runPush (live) - idempotency with a mapped credential', () => {
  it('classifies as skipped on re-push when only the mapped credential name differs', async () => {
    const wf = makeSnapshotWf('src-1', 'Cred WF', 'v1', [], ['dev_pg']);
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-1', versionId: 'created-v1' });

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([]),
          listCredentials: vi.fn().mockResolvedValue([{ name: 'prod_pg' } as CredentialSummary]),
          listTags: vi.fn().mockResolvedValue([]),
          createWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function () { });

    // First push: creates the workflow and writes a target fingerprint over
    // the remapped (prod_pg) credential name.
    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(createWorkflow).toHaveBeenCalledOnce();

    const fpRaw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    const fp = JSON.parse(fpRaw);
    expect(fp.envs?.prod?.['tgt-1']).toBeDefined();

    // Second push: target now reports a different versionId for the same
    // workflow (simulating n8n bumping versionId without a logic change),
    // but the stored content hash still matches.
    const updateWorkflow = vi.fn().mockResolvedValue({ versionId: 'updated-v1' });
    const deactivateWorkflow = vi.fn().mockResolvedValue(undefined);

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([makeSummary('tgt-1', 'Cred WF', 'different-v1', false)]),
          listCredentials: vi.fn().mockResolvedValue([{ name: 'prod_pg' } as CredentialSummary]),
          listTags: vi.fn().mockResolvedValue([]),
          updateWorkflow,
          deactivateWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(updateWorkflow).not.toHaveBeenCalled();
    expect(deactivateWorkflow).not.toHaveBeenCalled();

    const joined = output.join('\n');
    expect(joined).toContain('Cred WF');
    expect(joined).toContain('skipped');
  });
});

// ── credential-rotation regression (S1/T1/T6) ──────────────────────────────────

describe('runPush (live) - credential-rotation detection', () => {
  it('classifies as would-update on re-push when the node credential is swapped to a different, unmapped instance (genuine rotation)', async () => {
    const wf = makeSnapshotWf('src-1', 'Cred WF', 'v1', [], ['dev_pg']);
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-1', versionId: 'created-v1' });

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([]),
          listCredentials: vi.fn().mockResolvedValue([{ name: 'prod_pg' } as CredentialSummary]),
          listTags: vi.fn().mockResolvedValue([]),
          createWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function () { });

    // First push: creates the workflow and writes a target fingerprint over
    // the remapped (prod_pg) credential name.
    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(createWorkflow).toHaveBeenCalledOnce();

    // Second push: the source node now points at a completely different,
    // unmapped credential of the same type (rotation), with a versionId that
    // differs from the target's reported versionId so the fast path is
    // bypassed and the content hash must be compared.
    const rotatedWf = makeSnapshotWf('src-1', 'Cred WF', 'v2', [], ['dev_stripe']);
    vol.writeFileSync(
      `/project/.chiral/snapshots/20260522T120000Z-abcdef12/src-1.json`,
      JSON.stringify(rotatedWf),
    );

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([makeSummary('tgt-1', 'Cred WF', 'different-v1', false)]),
          listCredentials: vi.fn().mockResolvedValue([{ name: 'prod_pg' } as CredentialSummary]),
          listTags: vi.fn().mockResolvedValue([]),
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('Cred WF');
    expect(joined).toContain('will be updated');
    expect(joined).not.toContain('skipped');
  });

  it('still classifies as skipped on re-push when only the mapped credential name differs (mapped rotation, C1 preserved)', async () => {
    const wf = makeSnapshotWf('src-1', 'Cred WF', 'v1', [], ['dev_pg']);
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-1', versionId: 'created-v1' });

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([]),
          listCredentials: vi.fn().mockResolvedValue([{ name: 'prod_pg' } as CredentialSummary]),
          listTags: vi.fn().mockResolvedValue([]),
          createWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function () { });

    // First push: creates the workflow and writes a target fingerprint over
    // the remapped (prod_pg) credential name.
    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(createWorkflow).toHaveBeenCalledOnce();

    // Second push: source still references the mapped dev credential, with a
    // versionId that differs from the target's reported versionId so the
    // content hash must be compared. The cred-map normalizes dev_pg ->
    // prod_pg on both sides, so the hash should match and the workflow is
    // still reported skipped.
    const wf2 = makeSnapshotWf('src-1', 'Cred WF', 'v2', [], ['dev_pg']);
    vol.writeFileSync(
      `/project/.chiral/snapshots/20260522T120000Z-abcdef12/src-1.json`,
      JSON.stringify(wf2),
    );

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([makeSummary('tgt-1', 'Cred WF', 'different-v1', false)]),
          listCredentials: vi.fn().mockResolvedValue([{ name: 'prod_pg' } as CredentialSummary]),
          listTags: vi.fn().mockResolvedValue([]),
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('Cred WF');
    expect(joined).toContain('skipped');
    expect(joined).not.toContain('will be updated');
  });
});

// ── live push workflow map registration ───────────────────────────────────────

describe('runPush (live) - workflow map registration', () => {
  it('writes workflows.json entry with source and target IDs after createWorkflow', async () => {
    const wf = makeSnapshotWf('src-1', 'New WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' }),
      }) as never;
    });

    await runPush({ from: 'dev', to: 'prod', yes: true });

    const raw = vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string;
    const map = JSON.parse(raw);
    const entries = Object.values(map.workflows) as Record<string, { name: string; id?: string }>[];
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry['dev']).toEqual({ name: 'New WF', id: 'src-1' });
    expect(entry['prod']).toEqual({ name: 'New WF', id: 'tgt-new' });
  });

  it('writes workflows.json entry with source and target IDs after updateWorkflow', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false);
    setupProject([wf], [targetWf]);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([targetWf]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        getWorkflow: vi.fn().mockResolvedValue({ ...targetWf, nodes: [], connections: {}, settings: {} }),
        updateWorkflow: vi.fn().mockResolvedValue({ versionId: 'updated-v1' }),
      }) as never;
    });

    await runPush({ from: 'dev', to: 'prod', yes: true });

    const raw = vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string;
    const map = JSON.parse(raw);
    const entries = Object.values(map.workflows) as Record<string, { name: string; id?: string }>[];
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry['dev']).toEqual({ name: 'Existing WF', id: 'src-1' });
    expect(entry['prod']).toEqual({ name: 'Existing WF', id: 'tgt-1' });
  });

  it('uses resolved name for target entry when workflow map has a mapping', async () => {
    const wf = makeSnapshotWf('src-1', 'Invoice Sync [DEV]', 'v1');
    setupProject([wf], []);

    vol.writeFileSync('/project/.chiral/workflows.json', JSON.stringify({
      version: 1,
      workflows: {
        'invoice-sync': {
          dev: { name: 'Invoice Sync [DEV]' },
          prod: { name: 'Invoice Sync' },
        },
      },
    }));

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-inv', versionId: 'v1' }),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', yes: true });

    // Success line should show resolved name with mapped-from note
    expect(output.join('\n')).toContain('Invoice Sync');
    expect(output.join('\n')).toContain('mapped from');

    // Map entry should have target ID
    const raw = vol.readFileSync('/project/.chiral/workflows.json', 'utf-8') as string;
    const map = JSON.parse(raw);
    expect(map.workflows['invoice-sync']['prod']).toEqual({ name: 'Invoice Sync', id: 'tgt-inv' });
  });

  it('does not write workflows.json when createWorkflow fails', async () => {
    const wf = makeSnapshotWf('src-1', 'Failing WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockRejectedValue(new Error('API error')),
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function() { });
    vi.spyOn(console, 'error').mockImplementation(function() { });

    await runPush({ from: 'dev', to: 'prod', yes: true }).catch(() => { });

    expect(vol.existsSync('/project/.chiral/workflows.json')).toBe(false);
  });
});

// ── header text ───────────────────────────────────────────────────────────────

describe('runPush - header text', () => {
  it('shows "Dry run:" header in dry-run mode', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1')]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    expect(output.join('\n')).toContain('Dry run:');
    expect(output.join('\n')).not.toContain('Pushing');
  });

  it('shows "Pushing" header in live push mode', async () => {
    const wf = makeSnapshotWf('src-1', 'W1', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-1', versionId: 'v1' }),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(output.join('\n')).toContain('Pushing');
    expect(output.join('\n')).not.toContain('Dry run:');
  });
});

// ── stale snapshot with --yes ─────────────────────────────────────────────────

describe('runPush - stale snapshot with --yes', () => {
  function setupStaleProject() {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1')]);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    vol.writeFileSync(
      '/project/.chiral/snapshots/20260522T120000Z-abcdef12/meta.json',
      JSON.stringify({
        deployment_id: '20260522T120000Z-abcdef12',
        env: 'dev',
        command: 'pull',
        timestamp: twoDaysAgo,
        workflow_count: 1,
        filters: { tag: null, pattern: null, onlyActive: false, id: null },
      }),
    );
  }

  it('shows stale warning even when --yes is set', async () => {
    setupStaleProject();
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true, yes: true });

    expect(output.join('\n')).toContain('old');
    expect(output.join('\n')).toContain('chiral pull');
  });

  it('does not show prompt when --yes is set despite stale snapshot', async () => {
    setupStaleProject();
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    await runPush({ from: 'dev', to: 'prod', dryRun: true, yes: true });

    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it('JSON mode with stale snapshot and pending changes without --yes is rejected by the --yes guard, not silently allowed through', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v2')], [makeSummary('tgt-1', 'W1', 'v1')]);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    vol.writeFileSync(
      '/project/.chiral/snapshots/20260522T120000Z-abcdef12/meta.json',
      JSON.stringify({
        deployment_id: '20260522T120000Z-abcdef12',
        env: 'dev',
        command: 'pull',
        timestamp: twoDaysAgo,
        workflow_count: 1,
        filters: { tag: null, pattern: null, onlyActive: false, id: null },
      }),
    );

    const err = await runPush({ from: 'dev', to: 'prod', json: true }).catch(e => e);

    expect(err).toBeInstanceOf(UserError);
    expect((err as UserError).message).toContain('--yes');
    expect(prompts.confirm).not.toHaveBeenCalled();
  });
});

// ── prod type-to-confirm ──────────────────────────────────────────────────────

describe('runPush (live) - prod type-to-confirm', () => {
  it('calls input() for the prod confirmation prompt, not confirm()', async () => {
    const wf = makeSnapshotWf('src-1', 'W1', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-1', versionId: 'v1' }),
      }) as never;
    });

    vi.mocked(prompts.input).mockResolvedValue('prod');
    // Per-workflow create prompt still fires for the new workflow - allow it
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod' });

    expect(prompts.input).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('"prod" to confirm') }),
    );
  });
});

// ── lock check integration ────────────────────────────────────────────────────

function writeLockFile(
  workflowId: string,
  actor: string,
  ageMs: number,
  env = 'prod',
): void {
  const envId = PUSH_ENV_IDS[env as keyof typeof PUSH_ENV_IDS] ?? env;
  vol.mkdirSync(`${PROJECT_DIR}/.chiral/locks/${envId}`, { recursive: true });
  vol.writeFileSync(
    `${PROJECT_DIR}/.chiral/locks/${envId}/${workflowId}.lock`,
    JSON.stringify({
      version: 1,
      actor,
      timestamp: new Date(Date.now() - ageMs).toISOString(),
      hostname: 'test-host',
    }),
  );
}

describe('runPush - lock check integration', () => {
  it('push with no locks proceeds without prompt', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false);
    setupProject([wf], [targetWf]);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([targetWf]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        getWorkflow: vi.fn().mockResolvedValue({ ...targetWf, nodes: [], connections: {}, settings: {} }),
        updateWorkflow: vi.fn().mockResolvedValue({ versionId: 'updated-v1' }),
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it('push against a locked workflow shows the lock holder and prompts for confirmation', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false);
    setupProject([wf], [targetWf]);
    writeLockFile('tgt-1', 'alice@example.com', 2 * 3600 * 1000);

    vi.mocked(prompts.confirm).mockResolvedValue(false);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    const err = await runPush({ from: 'dev', to: 'prod' }).catch(e => e);

    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(0);
    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Push anyway?' }),
    );
    const joined = output.join('\n');
    expect(joined).toContain('alice@example.com');
    expect(joined).toContain('Existing WF');
  });

  it('--yes bypasses the lock confirmation prompt without error', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false);
    setupProject([wf], [targetWf]);
    writeLockFile('tgt-1', 'alice@example.com', 2 * 3600 * 1000);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([targetWf]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        getWorkflow: vi.fn().mockResolvedValue({ ...targetWf, nodes: [], connections: {}, settings: {} }),
        updateWorkflow: vi.fn().mockResolvedValue({ versionId: 'updated-v1' }),
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it('lock older than staleLockAfter hours triggers stale escalation message', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false);
    setupProject([wf], [targetWf]);
    writeLockFile('tgt-1', 'alice@example.com', 25 * 3600 * 1000); // 25 hours old

    vi.mocked(prompts.confirm).mockResolvedValue(false);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod' }).catch(() => {});

    expect(output.join('\n')).toContain('may be abandoned');
  });

  it('workflow not in workflows.json emits cannot check for locks warning but does not block', async () => {
    // would-create: no target workflow, no workflows.json entry → cannot get target ID
    const wf = makeSnapshotWf('src-1', 'Brand New WF', 'v1');
    setupProject([wf], []);
    // no workflows.json, so no target ID lookup possible

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' }),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    // Should not throw — "cannot check" is a warning, not a block
    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(output.join('\n')).toContain('cannot check for locks');
    expect(prompts.confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Push anyway?' }),
    );
  });

  it('--check with active lock exits 1', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false);
    setupProject([wf], [targetWf]);
    writeLockFile('tgt-1', 'alice@example.com', 2 * 3600 * 1000);

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const err = await runPush({ from: 'dev', to: 'prod', check: true }).catch(e => e);

    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(1);
  });

  it('--check with no locks exits 0', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false);
    setupProject([wf], [targetWf]);
    // no lock files

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const err = await runPush({ from: 'dev', to: 'prod', check: true }).catch(e => e);

    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(0);
  });

  it('--check --json emits standard envelope with blocking_locks', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false);
    setupProject([wf], [targetWf]);
    writeLockFile('tgt-1', 'alice@example.com', 2 * 3600 * 1000);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    const err = await runPush({ from: 'dev', to: 'prod', check: true, json: true }).catch(e => e);

    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(1);
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.clear).toBe(false);
    expect(parsed.data.blocking_locks).toHaveLength(1);
    expect(parsed.data.blocking_locks[0].actor).toBe('alice@example.com');
    expect(parsed.data.blocking_locks[0].workflowId).toBe('tgt-1');
    expect(parsed.data.blocking_protections).toEqual([]);
  });

  it('dry-run does not check locks or prompt for lock confirmation', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false);
    setupProject([wf], [targetWf]);
    writeLockFile('tgt-1', 'alice@example.com', 2 * 3600 * 1000);

    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    // dry-run exits before lock check; confirm should NOT have been called for lock check
    expect(prompts.confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Push anyway?' }),
    );
  });
});

// ── Data Table ID substitution ────────────────────────────────────────────────

function makeSnapshotWfWithDataTable(
  id: string,
  name: string,
  versionId: string,
  tableNodes: Array<{ nodeName: string; tableId: string; cachedResultName?: string; cachedResultUrl?: string }>,
): SnapshotWorkflow {
  const nodes = tableNodes.map((t) => ({
    id: `node-${t.nodeName}`,
    name: t.nodeName,
    type: 'n8n-nodes-base.dataTable',
    parameters: {
      dataTableId: {
        __rl: true,
        value: t.tableId,
        mode: 'list',
        ...(t.cachedResultName ? { cachedResultName: t.cachedResultName } : {}),
        ...(t.cachedResultUrl ? { cachedResultUrl: t.cachedResultUrl } : {}),
      },
    },
  }));
  return {
    id,
    name,
    versionId,
    active: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    tags: [],
    nodes,
    connections: {},
  };
}

function setupProjectWithTables(
  snapshotWorkflows: SnapshotWorkflow[],
  targetWorkflows: WorkflowSummary[],
  tablesJson: object,
): void {
  setupProject(snapshotWorkflows, targetWorkflows);
  vol.writeFileSync(
    `${PROJECT_DIR}/.chiral/tables.json`,
    JSON.stringify(tablesJson),
  );
}

describe('runPush - Data Table ID substitution', () => {
  it('replaces dataTableId.value with target env ID from tables.json', async () => {
    const wf = makeSnapshotWfWithDataTable('src-1', 'WF', 'v1', [
      { nodeName: 'Get Row', tableId: 'dev-table-id', cachedResultName: 'My Table' },
    ]);
    setupProjectWithTables([wf], [], {
      version: 1,
      tables: {
        contacts: {
          dev: { id: 'dev-table-id', name: 'Contacts Dev' },
          prod: { id: 'prod-table-id', name: 'Contacts Prod' },
        },
      },
    });

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' });
    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPush({ from: 'dev', to: 'prod', yes: true });

    const postedBody = createWorkflow.mock.calls[0][0] as Record<string, unknown>;
    const nodes = postedBody['nodes'] as Array<Record<string, unknown>>;
    const dtId = (nodes[0]['parameters'] as Record<string, unknown>)['dataTableId'] as Record<string, unknown>;
    expect(dtId['value']).toBe('prod-table-id');
  });

  it('deletes cachedResultUrl from substituted datatable node', async () => {
    const wf = makeSnapshotWfWithDataTable('src-1', 'WF', 'v1', [
      { nodeName: 'Get Row', tableId: 'dev-table-id', cachedResultUrl: 'https://dev.n8n/data-tables/dev-table-id', cachedResultName: 'My Table' },
    ]);
    setupProjectWithTables([wf], [], {
      version: 1,
      tables: {
        contacts: {
          dev: { id: 'dev-table-id', name: 'Contacts Dev' },
          prod: { id: 'prod-table-id', name: 'Contacts Prod' },
        },
      },
    });

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' });
    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPush({ from: 'dev', to: 'prod', yes: true });

    const postedBody = createWorkflow.mock.calls[0][0] as Record<string, unknown>;
    const nodes = postedBody['nodes'] as Array<Record<string, unknown>>;
    const dtId = (nodes[0]['parameters'] as Record<string, unknown>)['dataTableId'] as Record<string, unknown>;
    expect(dtId).not.toHaveProperty('cachedResultUrl');
  });

  it('rewrites cachedResultName to the target table name on substituted node', async () => {
    const wf = makeSnapshotWfWithDataTable('src-1', 'WF', 'v1', [
      { nodeName: 'Get Row', tableId: 'dev-table-id', cachedResultName: 'Contacts Dev', cachedResultUrl: 'https://dev/...' },
    ]);
    setupProjectWithTables([wf], [], {
      version: 1,
      tables: {
        contacts: {
          dev: { id: 'dev-table-id', name: 'Contacts Dev' },
          prod: { id: 'prod-table-id', name: 'Contacts Prod' },
        },
      },
    });

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' });
    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPush({ from: 'dev', to: 'prod', yes: true });

    const postedBody = createWorkflow.mock.calls[0][0] as Record<string, unknown>;
    const nodes = postedBody['nodes'] as Array<Record<string, unknown>>;
    const dtId = (nodes[0]['parameters'] as Record<string, unknown>)['dataTableId'] as Record<string, unknown>;
    expect(dtId['cachedResultName']).toBe('Contacts Prod');
  });

  it('passes source ID through unchanged when no tables.json mapping exists', async () => {
    const wf = makeSnapshotWfWithDataTable('src-1', 'WF', 'v1', [
      { nodeName: 'Get Row', tableId: 'unmapped-id' },
    ]);
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' });
    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPush({ from: 'dev', to: 'prod', yes: true });

    const postedBody = createWorkflow.mock.calls[0][0] as Record<string, unknown>;
    const nodes = postedBody['nodes'] as Array<Record<string, unknown>>;
    const dtId = (nodes[0]['parameters'] as Record<string, unknown>)['dataTableId'] as Record<string, unknown>;
    expect(dtId['value']).toBe('unmapped-id');
  });

  it('emits warning per unmapped table ID with affected nodes and fix command', async () => {
    const wf = makeSnapshotWfWithDataTable('src-1', 'WF', 'v1', [
      { nodeName: 'Get Row', tableId: 'unmapped-id' },
    ]);
    setupProject([wf], []);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('unmapped-id');
    expect(joined).toContain('Get Row');
    expect(joined).toContain('chiral table map');
  });

  it('dry-run includes table warnings in output', async () => {
    const wf = makeSnapshotWfWithDataTable('src-1', 'WF', 'v1', [
      { nodeName: 'Upsert Row', tableId: 'unmapped-dev-id' },
    ]);
    setupProject([wf], []);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    expect(output.join('\n')).toContain('unmapped-dev-id');
    expect(output.join('\n')).toContain('⚠');
  });

  it('json output includes table_warnings field', async () => {
    const wf = makeSnapshotWfWithDataTable('src-1', 'WF', 'v1', [
      { nodeName: 'Get Row', tableId: 'unmapped-id' },
    ]);
    setupProject([wf], []);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ from: 'dev', to: 'prod', dryRun: true, json: true });

    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.data.table_warnings).toEqual([
      { sourceId: 'unmapped-id', affectedNodes: ['Get Row'] },
    ]);
  });

  it('json output table_warnings is empty when all table IDs are mapped', async () => {
    const wf = makeSnapshotWfWithDataTable('src-1', 'WF', 'v1', [
      { nodeName: 'Get Row', tableId: 'dev-table-id' },
    ]);
    setupProjectWithTables([wf], [], {
      version: 1,
      tables: {
        contacts: {
          dev: { id: 'dev-table-id', name: 'Contacts' },
          prod: { id: 'prod-table-id', name: 'Contacts' },
        },
      },
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ from: 'dev', to: 'prod', dryRun: true, json: true });

    const parsed = JSON.parse(output[0]);
    expect(parsed.data.table_warnings).toEqual([]);
  });
});

// ── JSON live push ────────────────────────────────────────────────────────────

describe('runPush (live) - JSON output', () => {
  it('performs a live push and emits dry_run: false with applied results when json+yes', async () => {
    const wf = makeSnapshotWf('src-1', 'New WF', 'v1');
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' });
    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ from: 'dev', to: 'prod', json: true, yes: true });

    expect(createWorkflow).toHaveBeenCalled();
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.data.dry_run).toBe(false);
    expect(parsed.data.created).toContain('New WF');
  });

  it('does not write when json+dryRun, emitting dry_run: true preview', async () => {
    const wf = makeSnapshotWf('src-1', 'New WF', 'v1');
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' });
    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ from: 'dev', to: 'prod', json: true, dryRun: true, yes: true });

    expect(createWorkflow).not.toHaveBeenCalled();
    const parsed = JSON.parse(output[0]);
    expect(parsed.data.dry_run).toBe(true);
  });

  it('throws UserError and makes no writes when json without --yes and changes are pending', async () => {
    const wf = makeSnapshotWf('src-1', 'New WF', 'v1');
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' });
    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    const err = await runPush({ from: 'dev', to: 'prod', json: true }).catch((e) => e);

    expect(err).toBeInstanceOf(UserError);
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(output).toHaveLength(0);
  });

  it('produces pure JSON stdout (single object, no stray bytes) for a live json push', async () => {
    const wf = makeSnapshotWf('src-1', 'New WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' }),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ from: 'dev', to: 'prod', json: true, yes: true });

    expect(output).toHaveLength(1);
    expect(() => JSON.parse(output[0])).not.toThrow();
  });
});

// ── corrupted snapshot files ─────────────────────────────────────────────────

describe('runPush (dry-run) - corrupted snapshot files', () => {
  it('warns to stderr and still pushes the readable workflows', async () => {
    setupProject([makeSnapshotWf('src-1', 'Good WF', 'v1')], []);

    const deploymentId = '20260522T120000Z-abcdef12';
    const snapshotDir = `/project/.chiral/snapshots/${deploymentId}`;
    vol.writeFileSync(`${snapshotDir}/src-2.json`, 'not valid json');

    const logOutput: string[] = [];
    const errOutput: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logOutput.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => errOutput.push(args.join(' ')));

    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    expect(errOutput.join('\n')).toContain('corrupted');
    const joined = logOutput.join('\n');
    expect(joined).toContain('Good WF');
    expect(joined).not.toContain('src-2');
  });
});

// ── active-workflow update failure restores activation (L3) ───────────────────

describe('runPush (live) - active workflow update failure', () => {
  it('restores activation and records failure when updateWorkflow rejects for an active workflow', async () => {
    const wfOk = makeSnapshotWf('src-ok', 'OK WF', 'v1');
    const wfActive = makeSnapshotWf('src-1', 'Active WF', 'v2');
    const targetWfActive = makeSummary('tgt-1', 'Active WF', 'v1', true);
    setupProject([wfOk, wfActive], [targetWfActive]);

    const updateWorkflow = vi.fn().mockRejectedValue(new Error('API error'));
    const deactivateWorkflow = vi.fn().mockResolvedValue(undefined);
    const activateWorkflow = vi.fn().mockResolvedValue(undefined);
    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-ok', versionId: 'created-v1' });

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([targetWfActive]),
          listCredentials: vi.fn().mockResolvedValue([]),
          listTags: vi.fn().mockResolvedValue([]),
          getWorkflow: vi.fn().mockResolvedValue({ ...targetWfActive, nodes: [], connections: {}, settings: {} }),
          createWorkflow,
          updateWorkflow,
          deactivateWorkflow,
          activateWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function () { });
    vi.spyOn(console, 'error').mockImplementation(function () { });

    const err = await runPush({ from: 'dev', to: 'prod', yes: true }).catch(e => e);
    expect(err).toBeInstanceOf(ControlledExit);
    expect((err as ControlledExit).code).toBe(1);

    // Deactivated before the update attempt, then reactivated after the
    // update failed - the workflow's active state is restored, not left off.
    expect(deactivateWorkflow).toHaveBeenCalledWith('tgt-1');
    expect(activateWorkflow).toHaveBeenCalledWith('tgt-1');

    const entries = readAuditLog('/project/.chiral');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe('partial');
  });

  it('warns distinctly when both updateWorkflow and the restore activateWorkflow reject', async () => {
    const wfActive = makeSnapshotWf('src-1', 'Active WF', 'v2');
    const targetWfActive = makeSummary('tgt-1', 'Active WF', 'v1', true);
    setupProject([wfActive], [targetWfActive]);

    const updateWorkflow = vi.fn().mockRejectedValue(new Error('API error'));
    const deactivateWorkflow = vi.fn().mockResolvedValue(undefined);
    const activateWorkflow = vi.fn().mockRejectedValue(new Error('restore error'));

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([targetWfActive]),
          listCredentials: vi.fn().mockResolvedValue([]),
          listTags: vi.fn().mockResolvedValue([]),
          getWorkflow: vi.fn().mockResolvedValue({ ...targetWfActive, nodes: [], connections: {}, settings: {} }),
          updateWorkflow,
          deactivateWorkflow,
          activateWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function () { });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(function () { });

    const err = await runPush({ from: 'dev', to: 'prod', yes: true }).catch(e => e);
    expect(err).toBeInstanceOf(ControlledExit);
    expect((err as ControlledExit).code).toBe(1);

    const warning = errorSpy.mock.calls.map(call => call.join(' ')).find(line => line.includes('Active WF'));
    expect(warning).toBeDefined();
    expect(warning).toContain('inactive');
    expect(warning).toContain('manual reactivation needed');
  });

  it('does not warn about a failed restore when the restore activateWorkflow succeeds', async () => {
    const wfActive = makeSnapshotWf('src-1', 'Active WF', 'v2');
    const targetWfActive = makeSummary('tgt-1', 'Active WF', 'v1', true);
    setupProject([wfActive], [targetWfActive]);

    const updateWorkflow = vi.fn().mockRejectedValue(new Error('API error'));
    const deactivateWorkflow = vi.fn().mockResolvedValue(undefined);
    const activateWorkflow = vi.fn().mockResolvedValue(undefined);

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([targetWfActive]),
          listCredentials: vi.fn().mockResolvedValue([]),
          listTags: vi.fn().mockResolvedValue([]),
          getWorkflow: vi.fn().mockResolvedValue({ ...targetWfActive, nodes: [], connections: {}, settings: {} }),
          updateWorkflow,
          deactivateWorkflow,
          activateWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function () { });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(function () { });

    const err = await runPush({ from: 'dev', to: 'prod', yes: true }).catch(e => e);
    expect(err).toBeInstanceOf(ControlledExit);
    expect((err as ControlledExit).code).toBe(1);

    const warning = errorSpy.mock.calls.map(call => call.join(' ')).find(line => line.includes('manual reactivation needed'));
    expect(warning).toBeUndefined();
  });
});

// ── success-path reactivation guard (S2/SM2) ──────────────────────────────────

describe('runPush (live) - success-path reactivation failure', () => {
  it('reports a successful update with a failed reactivation distinctly and does not persist a current fingerprint', async () => {
    const wf = makeSnapshotWf('src-1', 'Active WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Active WF', 'v1', true); // active
    setupProject([wf], [targetWf]);

    const updateWorkflow = vi.fn().mockResolvedValue({ versionId: 'updated-v1' });
    const deactivateWorkflow = vi.fn().mockResolvedValue(undefined);
    const activateWorkflow = vi.fn().mockRejectedValue(new Error('activation error'));

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([targetWf]),
          listCredentials: vi.fn().mockResolvedValue([]),
          listTags: vi.fn().mockResolvedValue([]),
          getWorkflow: vi.fn().mockResolvedValue({ ...targetWf, nodes: [], connections: {}, settings: {} }),
          updateWorkflow,
          deactivateWorkflow,
          activateWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function () { });
    vi.spyOn(console, 'error').mockImplementation(function () { });

    const err = await runPush({ from: 'dev', to: 'prod', yes: true }).catch((e) => e);

    // The update itself succeeded - this is not reported as a plain push failure.
    expect(err).toBeUndefined();
    expect(updateWorkflow).toHaveBeenCalledOnce();
    expect(activateWorkflow).toHaveBeenCalledWith('tgt-1');

    // The fingerprint is marked as needing reactivation, not "current".
    const raw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    const fp = JSON.parse(raw);
    const entry = fp.envs?.prod?.['tgt-1'];
    expect(entry).toBeDefined();
    expect(entry.needsReactivation).toBe(true);
  });

  it('re-attempts reactivation on the next push instead of reporting up to date', async () => {
    const wf = makeSnapshotWf('src-1', 'Active WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Active WF', 'v1', true); // active

    const updateWorkflow = vi.fn().mockResolvedValue({ versionId: 'updated-v1' });
    const deactivateWorkflow = vi.fn().mockResolvedValue(undefined);
    const activateWorkflow = vi.fn()
      .mockRejectedValueOnce(new Error('activation error'))
      .mockResolvedValue(undefined);

    function setupClients() {
      MockN8nClient.mockImplementation(function (_env, envName) {
        if (envName === 'prod') {
          return makeFullTargetClientMock({
            listWorkflows: vi.fn().mockResolvedValue([targetWf]),
            listCredentials: vi.fn().mockResolvedValue([]),
            listTags: vi.fn().mockResolvedValue([]),
            getWorkflow: vi.fn().mockResolvedValue({ ...targetWf, nodes: [], connections: {}, settings: {} }),
            updateWorkflow,
            deactivateWorkflow,
            activateWorkflow,
          }) as never;
        }
        return makeTargetClientMock() as never;
      });
    }

    vi.spyOn(console, 'log').mockImplementation(function () { });
    vi.spyOn(console, 'error').mockImplementation(function () { });

    setupProject([wf], [targetWf]);
    setupClients();
    await runPush({ from: 'dev', to: 'prod', yes: true });

    let raw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    expect(JSON.parse(raw).envs?.prod?.['tgt-1']?.needsReactivation).toBe(true);

    // Re-run push against the same snapshot/state.
    setupClients();
    await runPush({ from: 'dev', to: 'prod', yes: true });

    // The workflow is re-attempted (updateWorkflow + activateWorkflow called again),
    // not silently classified as "skipped".
    expect(updateWorkflow).toHaveBeenCalledTimes(2);
    expect(activateWorkflow).toHaveBeenCalledTimes(2);

    raw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    const entry = JSON.parse(raw).envs?.prod?.['tgt-1'];
    expect(entry.needsReactivation).toBeFalsy();
  });

  it('records "updated (reactivated)" and persists the fingerprint on the happy path', async () => {
    const wf = makeSnapshotWf('src-1', 'Active WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Active WF', 'v1', true); // active
    setupProject([wf], [targetWf]);

    const updateWorkflow = vi.fn().mockResolvedValue({ versionId: 'updated-v1' });
    const deactivateWorkflow = vi.fn().mockResolvedValue(undefined);
    const activateWorkflow = vi.fn().mockResolvedValue(undefined);

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([targetWf]),
          listCredentials: vi.fn().mockResolvedValue([]),
          listTags: vi.fn().mockResolvedValue([]),
          getWorkflow: vi.fn().mockResolvedValue({ ...targetWf, nodes: [], connections: {}, settings: {} }),
          updateWorkflow,
          deactivateWorkflow,
          activateWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(activateWorkflow).toHaveBeenCalledWith('tgt-1');
    expect(output.some((l) => typeof l === 'string' && l.includes('Updated') && l.includes('reactivated'))).toBe(true);

    const raw = vol.readFileSync('/project/.chiral/fingerprints.json', 'utf-8') as string;
    const entry = JSON.parse(raw).envs?.prod?.['tgt-1'];
    expect(entry).toBeDefined();
    expect(entry.needsReactivation).toBeFalsy();
    expect(entry.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ── audit result: partial vs failure vs success (L3) ──────────────────────────

describe('runPush (live) - audit result classification', () => {
  it('records result: partial when some workflows succeed and some fail', async () => {
    const wfOk = makeSnapshotWf('src-ok', 'OK WF', 'v1');
    const wfFail = makeSnapshotWf('src-fail', 'Failing WF', 'v1');
    setupProject([wfOk, wfFail], []);

    const createWorkflow = vi.fn().mockImplementation((body: { name: string }) => {
      if (body.name === 'Failing WF') return Promise.reject(new Error('API error'));
      return Promise.resolve({ id: 'tgt-ok', versionId: 'created-v1' });
    });

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function() { });
    vi.spyOn(console, 'error').mockImplementation(function() { });

    await runPush({ from: 'dev', to: 'prod', yes: true }).catch((err) => {
      expect(err).toBeInstanceOf(ControlledExit);
      expect((err as ControlledExit).code).toBe(1);
    });

    const entries = readAuditLog('/project/.chiral');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe('partial');
  });

  it('records result: failure when all workflows fail', async () => {
    const wf = makeSnapshotWf('src-fail', 'Failing WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockRejectedValue(new Error('API error')),
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(function() { });
    vi.spyOn(console, 'error').mockImplementation(function() { });

    await runPush({ from: 'dev', to: 'prod', yes: true }).catch(() => { });

    const entries = readAuditLog('/project/.chiral');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe('failure');
  });

  it('records result: success when push has no failures', async () => {
    const wf = makeSnapshotWf('src-ok', 'OK WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function() {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-ok', versionId: 'created-v1' }),
      }) as never;
    });

    await runPush({ from: 'dev', to: 'prod', yes: true });

    const entries = readAuditLog('/project/.chiral');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe('success');
  });
});

// ── flag-conflict and stale-lock-after validation ─────────────────────────────

describe('pushCommand - flag conflicts', () => {
  beforeEach(() => {
    pushCommand.exitOverride();
  });

  it('errors when --yes and --dry-run are combined', async () => {
    await expect(
      pushCommand.parseAsync(
        ['--source', 'dev', '--target', 'prod', '--dry-run', '--yes'],
        { from: 'user' },
      ),
    ).rejects.toThrow();
  });

  it('errors when --no-activate and --dry-run are combined', async () => {
    await expect(
      pushCommand.parseAsync(
        ['--source', 'dev', '--target', 'prod', '--dry-run', '--no-activate'],
        { from: 'user' },
      ),
    ).rejects.toThrow();
  });
});

describe('pushCommand - --stale-lock-after validation', () => {
  const staleLockAfterOption = pushCommand.options.find((o) => o.long === '--stale-lock-after');

  it('rejects 0', () => {
    expect(() => staleLockAfterOption?.parseArg?.('0', undefined)).toThrow();
  });

  it('rejects negative values', () => {
    expect(() => staleLockAfterOption?.parseArg?.('-5', undefined)).toThrow();
  });

  it('returns the integer for a valid value', () => {
    expect(staleLockAfterOption?.parseArg?.('24', undefined)).toBe(24);
  });
});

// ── URL map substitution ──────────────────────────────────────────────────────

function makeSnapshotWfWithUrl(
  id: string,
  name: string,
  versionId: string,
  urlNodes: Array<{ nodeName: string; url: string }>,
): SnapshotWorkflow {
  return {
    id,
    name,
    versionId,
    active: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    tags: [],
    nodes: urlNodes.map((u) => ({
      id: `node-${u.nodeName}`,
      name: u.nodeName,
      type: 'n8n-nodes-base.httpRequest',
      parameters: { url: u.url },
    })),
    connections: {},
  };
}

const URL_MAP_JSON = {
  version: 1,
  urls: {
    api_base: {
      values: {
        dev: 'https://api.dev.example.com',
        prod: 'https://api.example.com',
      },
    },
  },
};

describe('runPush - URL map substitution', () => {
  it('replaces URL origin with target env value in push body', async () => {
    const wf = makeSnapshotWfWithUrl('src-1', 'WF', 'v1', [
      { nodeName: 'HTTP Request', url: 'https://api.dev.example.com/v1/orders' },
    ]);
    setupProject([wf], []);
    vol.writeFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, JSON.stringify(URL_MAP_JSON));

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' });
    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPush({ from: 'dev', to: 'prod', yes: true });

    const postedBody = createWorkflow.mock.calls[0][0] as Record<string, unknown>;
    const nodes = postedBody['nodes'] as Array<Record<string, unknown>>;
    const params = nodes[0]['parameters'] as Record<string, unknown>;
    expect(params['url']).toBe('https://api.example.com/v1/orders');
  });

  it('classifies as skipped on re-push when only the URL origin differs (idempotency)', async () => {
    const wf = makeSnapshotWfWithUrl('src-1', 'URL WF', 'v1', [
      { nodeName: 'HTTP Request', url: 'https://api.dev.example.com/v1/orders' },
    ]);
    setupProject([wf], []);
    vol.writeFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, JSON.stringify(URL_MAP_JSON));

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-1', versionId: 'created-v1' });
    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([]),
          listCredentials: vi.fn().mockResolvedValue([]),
          listTags: vi.fn().mockResolvedValue([]),
          createWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPush({ from: 'dev', to: 'prod', yes: true });
    expect(createWorkflow).toHaveBeenCalledOnce();

    // Second push: target reports a different versionId but stored hash should match
    const updateWorkflow = vi.fn().mockResolvedValue({ versionId: 'updated-v1' });
    const deactivateWorkflow = vi.fn().mockResolvedValue(undefined);

    MockN8nClient.mockImplementation(function (_env, envName) {
      if (envName === 'prod') {
        return makeFullTargetClientMock({
          listWorkflows: vi.fn().mockResolvedValue([makeSummary('tgt-1', 'URL WF', 'different-v1', false)]),
          listCredentials: vi.fn().mockResolvedValue([]),
          listTags: vi.fn().mockResolvedValue([]),
          updateWorkflow,
          deactivateWorkflow,
        }) as never;
      }
      return makeTargetClientMock() as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    await runPush({ from: 'dev', to: 'prod', yes: true });

    expect(updateWorkflow).not.toHaveBeenCalled();
    expect(deactivateWorkflow).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('skipped');
  });

  it('passes URL unchanged when no url-map entry matches', async () => {
    const wf = makeSnapshotWfWithUrl('src-1', 'WF', 'v1', [
      { nodeName: 'HTTP Request', url: 'https://unmapped.example.com/v1/items' },
    ]);
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' });
    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPush({ from: 'dev', to: 'prod', yes: true });

    const postedBody = createWorkflow.mock.calls[0][0] as Record<string, unknown>;
    const nodes = postedBody['nodes'] as Array<Record<string, unknown>>;
    const params = nodes[0]['parameters'] as Record<string, unknown>;
    expect(params['url']).toBe('https://unmapped.example.com/v1/items');
  });

  it('prints url map section with substitution line in human output', async () => {
    const wf = makeSnapshotWfWithUrl('src-1', 'WF', 'v1', [
      { nodeName: 'HTTP Request', url: 'https://api.dev.example.com/v1/orders' },
    ]);
    setupProject([wf], []);
    vol.writeFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, JSON.stringify(URL_MAP_JSON));

    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' }),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    await runPush({ from: 'dev', to: 'prod', yes: true });

    const joined = output.join('\n');
    expect(joined).toContain('URL map:');
    expect(joined).toContain('api_base:');
    expect(joined).toContain('https://api.dev.example.com');
    expect(joined).toContain('https://api.example.com');
    expect(joined).toContain('1 node');
  });

  it('prints url map section in --dry-run human output', async () => {
    const wf = makeSnapshotWfWithUrl('src-1', 'WF', 'v1', [
      { nodeName: 'HTTP Request', url: 'https://api.dev.example.com/v1/orders' },
    ]);
    setupProject([wf], []);
    vol.writeFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, JSON.stringify(URL_MAP_JSON));

    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    await runPush({ from: 'dev', to: 'prod', dryRun: true });

    const joined = output.join('\n');
    expect(joined).toContain('URL map:');
    expect(joined).toContain('api_base:');
  });

  it('prints one deduped unmapped-URL warning per unique value with hostname-slug suggestion', async () => {
    const wf = makeSnapshotWfWithUrl('src-1', 'WF', 'v1', [
      { nodeName: 'Node A', url: 'https://unmapped.dev.example.com/v1/orders' },
      { nodeName: 'Node B', url: 'https://unmapped.dev.example.com/v1/orders' },
    ]);
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' }),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    await runPush({ from: 'dev', to: 'prod', yes: true });

    const joined = output.join('\n');
    const warningCount = (joined.match(/Unmapped URL:/g) ?? []).length;
    expect(warningCount).toBe(1);
    expect(joined).toContain('unmapped_dev_example_com');
    expect(joined).toContain('chiral url map add');
  });

  it('exits 0 (does not abort) when push has only unmapped URL warnings', async () => {
    const wf = makeSnapshotWfWithUrl('src-1', 'WF', 'v1', [
      { nodeName: 'HTTP Request', url: 'https://unmapped.example.com/v1/items' },
    ]);
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' });
    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
      }) as never;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runPush({ from: 'dev', to: 'prod', yes: true })).resolves.not.toThrow();
    expect(createWorkflow).toHaveBeenCalledOnce();
  });

  it('json dry-run includes url_substitutions and url_warnings', async () => {
    const wf = makeSnapshotWfWithUrl('src-1', 'WF', 'v1', [
      { nodeName: 'HTTP Request', url: 'https://api.dev.example.com/v1/orders' },
      { nodeName: 'Node B', url: 'https://unmapped.example.com/items' },
    ]);
    setupProject([wf], []);
    vol.writeFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, JSON.stringify(URL_MAP_JSON));

    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));
    await runPush({ from: 'dev', to: 'prod', dryRun: true, json: true });

    const parsed = JSON.parse(output[0]);
    expect(parsed.data.url_substitutions).toEqual([
      {
        logicalName: 'api_base',
        sourceValue: 'https://api.dev.example.com',
        targetValue: 'https://api.example.com',
        exact: false,
        affectedNodes: ['HTTP Request'],
      },
    ]);
    expect(parsed.data.url_warnings).toEqual([
      {
        value: 'https://unmapped.example.com/items',
        suggestedKey: 'unmapped_example_com',
        affectedNodes: ['Node B'],
      },
    ]);
  });

  it('json dry-run has empty url_substitutions and url_warnings when no URLs mapped', async () => {
    const wf = makeSnapshotWf('src-1', 'WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));
    await runPush({ from: 'dev', to: 'prod', dryRun: true, json: true });

    const parsed = JSON.parse(output[0]);
    expect(parsed.data.url_substitutions).toEqual([]);
    expect(parsed.data.url_warnings).toEqual([]);
  });

  it('live json result includes url_substitutions and url_warnings', async () => {
    const wf = makeSnapshotWfWithUrl('src-1', 'WF', 'v1', [
      { nodeName: 'HTTP Request', url: 'https://api.dev.example.com/v1/orders' },
    ]);
    setupProject([wf], []);
    vol.writeFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, JSON.stringify(URL_MAP_JSON));

    MockN8nClient.mockImplementation(function () {
      return makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'v1' }),
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));
    await runPush({ from: 'dev', to: 'prod', yes: true, json: true });

    const parsed = JSON.parse(output[0]);
    expect(parsed.data.url_substitutions).toHaveLength(1);
    expect(parsed.data.url_substitutions[0].logicalName).toBe('api_base');
    expect(parsed.data.url_warnings).toEqual([]);
  });
});
