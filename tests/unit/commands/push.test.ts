import { describe, it, expect, vi, beforeEach } from 'vitest';
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
}));

vi.mock('../../../src/lib/n8n-client.js', () => ({
  N8nClient: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { N8nClient } from '../../../src/lib/n8n-client.js';
import { runPush } from '../../../src/commands/push.js';
import { computeContentHash } from '../../../src/state/fingerprints.js';
import type { WorkflowSummary, CredentialSummary, TagSummary } from '../../../src/lib/n8n-client.js';
import type { SnapshotWorkflow } from '../../../src/state/snapshots.js';

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
});

function setupProject(snapshotWorkflows: SnapshotWorkflow[] = [], targetWorkflows: WorkflowSummary[] = []) {
  vol.fromJSON({
    '/project/.flightdeck/config.json': VALID_CONFIG,
    '/project/.flightdeck/audit.jsonl': '',
    '/project/.flightdeck/credentials.json': JSON.stringify({
      version: 1,
      credentials: {
        postgres: { dev: 'dev_pg', prod: 'prod_pg' },
      },
    }),
  });

  if (snapshotWorkflows.length > 0) {
    const deploymentId = '20260522T120000Z-abcdef12';
    const snapshotDir = `/project/.flightdeck/snapshots/${deploymentId}`;
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

  MockN8nClient.mockImplementation((_env, envName) => {
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

describe('runPush (dry-run) — guards', () => {
  it('throws UserError when source equals target', async () => {
    await expect(
      runPush({ source: 'dev', target: 'dev', dryRun: true }, '/project'),
    ).rejects.toThrow('source and target are both "dev"');
  });

  it('throws when no snapshot exists for source', async () => {
    setupProject(); // empty project, no snapshot
    await expect(
      runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project'),
    ).rejects.toThrow('No snapshot found for dev');
  });

  it('throws UserError when source env is not in config', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1')]);
    await expect(
      runPush({ source: 'staging', target: 'prod', dryRun: true }, '/project'),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('throws UserError when target env is not in config', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1')]);
    await expect(
      runPush({ source: 'dev', target: 'staging', dryRun: true }, '/project'),
    ).rejects.toBeInstanceOf(UserError);
  });
});

// ── classification (create / update / skip) ───────────────────────────────────

describe('runPush (dry-run) — classification', () => {
  it('classifies as would-create when target lacks workflow', async () => {
    setupProject([makeSnapshotWf('src-1', 'New WF', 'v1')], []);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

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

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

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

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

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

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

    expect(output.join('\n')).toContain('active, will be paused briefly');
  });
});

// ── credential mapping ────────────────────────────────────────────────────────

describe('runPush (dry-run) — credential mapping', () => {
  it('shows mapping for credentials found in nodes', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', [], ['dev_pg'])]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

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

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

    const joined = output.join('\n');
    expect(joined).toContain('dev_stripe');
    expect(joined).toContain('⚠');
    expect(joined).toContain('passing through unchanged');
  });

  it('aborts with error when mapped target credential does not exist', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', [], ['dev_pg'])]);

    // Override mock to return empty credentials from target
    MockN8nClient.mockImplementation(() => {
      return makeTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]), // missing prod_pg!
      }) as never;
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    const err = await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project').catch(e => e);

    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(1);

    const joined = output.join('\n');
    expect(joined).toContain('✗');
    expect(joined).toContain('missing in prod');
    expect(joined).toContain('Cannot push');
    expect(joined).toContain('flightdeck credential add postgres prod=prod_pg');
  });
});

// ── tag warnings ──────────────────────────────────────────────────────────────

describe('runPush (dry-run) — tag warnings', () => {
  it('warns when snapshot workflow has a tag missing in target', async () => {
    // 'unknown_tag' is not returned by targetClient.listTags()
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', ['unknown_tag'])]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

    const joined = output.join('\n');
    expect(joined).toContain('⚠');
    expect(joined).toContain('Tag "unknown_tag" not found in');
  });

  it('does not warn when tag exists in target', async () => {
    // 'billing' is returned by our targetClient mock
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', ['billing'])]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

    const joined = output.join('\n');
    expect(joined).not.toContain('Tag "billing" not found');
  });
});

// ── stale snapshot prompt ─────────────────────────────────────────────────────

describe('runPush (dry-run) — stale snapshot', () => {
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
      '/project/.flightdeck/snapshots/20260522T120000Z-abcdef12/meta.json',
      JSON.stringify(meta),
    );

    // Mock confirm to return false
    vi.mocked(prompts.confirm).mockResolvedValue(false);

    const err = await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project').catch(e => e);
    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(0);
    expect(prompts.confirm).toHaveBeenCalled();
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
      '/project/.flightdeck/snapshots/20260522T120000Z-abcdef12/meta.json',
      JSON.stringify(meta),
    );

    vi.mocked(prompts.confirm).mockResolvedValue(true);

    await runPush({ source: 'dev', target: 'prod', dryRun: true, yes: true }, '/project');
    expect(prompts.confirm).not.toHaveBeenCalled();
  });
});

// ── JSON output ───────────────────────────────────────────────────────────────

describe('runPush (dry-run) — JSON output', () => {
  it('emits valid json matching expected structure', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v2', ['billing'], ['dev_pg'])], [makeSummary('tgt-1', 'W1', 'v1')]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ source: 'dev', target: 'prod', dryRun: true, json: true }, '/project');

    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);

    expect(parsed.source).toBe('dev');
    expect(parsed.dry_run).toBe(true);
    expect(parsed.updated).toContain('W1');
    expect(parsed.created).toEqual([]);
    expect(parsed.credential_map[0].targetName).toBe('prod_pg');
    expect(parsed.credential_errors).toEqual([]);
  });

  it('exits 1 and includes credential_errors in json when mapped credential is missing', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', [], ['dev_pg'])]);

    MockN8nClient.mockImplementation(() =>
      makeTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]), // prod_pg missing
        listTags: vi.fn().mockResolvedValue([]),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    const err = await runPush({ source: 'dev', target: 'prod', dryRun: true, json: true }, '/project').catch(e => e);

    expect(err).toBeInstanceOf(ControlledExit);
    expect(err.code).toBe(1);
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.credential_errors).toHaveLength(1);
    expect(parsed.credential_errors[0].targetName).toBe('prod_pg');
  });

  it('includes deployment_id (not null) in json when no workflows match filters', async () => {
    setupProject([makeSnapshotWf('src-1', 'W1', 'v1', [], [])]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(line));

    await runPush({ source: 'dev', target: 'prod', dryRun: true, json: true, pattern: 'NoMatch*' }, '/project');

    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.deployment_id).toBe('20260522T120000Z-abcdef12');
    expect(parsed.credential_errors).toEqual([]);
  });
});

// ── filters ───────────────────────────────────────────────────────────────────

describe('runPush (dry-run) — filters', () => {
  it('--tag excludes workflows that do not have the tag', async () => {
    setupProject([
      makeSnapshotWf('src-1', 'Tagged WF', 'v1', ['billing']),
      makeSnapshotWf('src-2', 'Untagged WF', 'v1', []),
    ]);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ source: 'dev', target: 'prod', dryRun: true, tag: 'billing' }, '/project');

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

    await runPush({ source: 'dev', target: 'prod', dryRun: true, pattern: 'Customer *' }, '/project');

    const joined = output.join('\n');
    expect(joined).toContain('Customer Orders');
    expect(joined).not.toContain('Billing Pipeline');
  });

  it('does not include skipped workflows nodes in credential map validation', async () => {
    // src-1 is skipped (same versionId), src-2 is new
    // src-1 references dev_pg which maps to prod_pg (exists in target)
    // src-2 has no credentials — should produce no credential errors
    setupProject(
      [
        makeSnapshotWf('src-1', 'Unchanged WF', 'v1', [], ['dev_pg']),
        makeSnapshotWf('src-2', 'New WF', 'v1', [], []),
      ],
      [makeSummary('tgt-1', 'Unchanged WF', 'v1')],
    );

    MockN8nClient.mockImplementation(() =>
      makeTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([makeSummary('tgt-1', 'Unchanged WF', 'v1')]),
        listCredentials: vi.fn().mockResolvedValue([]), // prod_pg NOT present — would abort if skipped wf is included
        listTags: vi.fn().mockResolvedValue([]),
      }) as never,
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    // Should succeed: skipped workflow's credentials are not validated
    await expect(
      runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project'),
    ).resolves.toBeUndefined();

    expect(output.join('\n')).not.toContain('Cannot push');
  });
});

// ── summary line ──────────────────────────────────────────────────────────────

describe('runPush (dry-run) — summary', () => {
  it('shows already-in-sync message when all workflows are up to date', async () => {
    setupProject(
      [makeSnapshotWf('src-1', 'Same WF', 'v1')],
      [makeSummary('tgt-1', 'Same WF', 'v1')],
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

    expect(output.join('\n')).toContain('already in sync');
  });
});

// ── fingerprint-based classification ─────────────────────────────────────────

describe('runPush (dry-run) — fingerprint-based classification', () => {
  it('classifies as skipped when target fingerprint contentHash matches source despite different versionId', async () => {
    const wf = makeSnapshotWf('src-1', 'Same Content WF', 'v2');
    // Target has versionId v1 (differs from snapshot v2), but same actual content
    setupProject([wf], [makeSummary('tgt-1', 'Same Content WF', 'v1')]);

    // Pre-populate target fingerprints with a hash matching the source snapshot
    const hash = computeContentHash(wf as Record<string, unknown>);
    vol.writeFileSync(
      '/project/.flightdeck/fingerprints.json',
      JSON.stringify({
        version: 1,
        envs: {
          prod: {
            'Same Content WF': {
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

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

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
      '/project/.flightdeck/fingerprints.json',
      JSON.stringify({
        version: 1,
        envs: {
          prod: {
            'Changed WF': {
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

    await runPush({ source: 'dev', target: 'prod', dryRun: true }, '/project');

    const joined = output.join('\n');
    expect(joined).toContain('~');
    expect(joined).toContain('Changed WF');
    expect(joined).toContain('will be updated');
  });
});

// ── live push fingerprint writes ──────────────────────────────────────────────

describe('runPush (live) — fingerprint writes', () => {
  it('writes fingerprint to target env after successful createWorkflow', async () => {
    const wf = makeSnapshotWf('src-1', 'New WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(() =>
      makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' }),
      }) as never,
    );

    await runPush({ source: 'dev', target: 'prod', yes: true }, '/project');

    const raw = vol.readFileSync('/project/.flightdeck/fingerprints.json', 'utf-8') as string;
    const fp = JSON.parse(raw);
    const entry = fp.envs?.prod?.['New WF'];
    expect(entry).toBeDefined();
    expect(entry.versionId).toBe('created-v1');
    expect(entry.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.structureHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('writes fingerprint to target env after successful updateWorkflow', async () => {
    const wf = makeSnapshotWf('src-1', 'Existing WF', 'v2');
    const targetWf = makeSummary('tgt-1', 'Existing WF', 'v1', false); // inactive
    setupProject([wf], [targetWf]);

    MockN8nClient.mockImplementation(() =>
      makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([targetWf]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        getWorkflow: vi.fn().mockResolvedValue({ ...targetWf, nodes: [], connections: {}, settings: {} }),
        updateWorkflow: vi.fn().mockResolvedValue({ versionId: 'updated-v1' }),
      }) as never,
    );

    await runPush({ source: 'dev', target: 'prod', yes: true }, '/project');

    const raw = vol.readFileSync('/project/.flightdeck/fingerprints.json', 'utf-8') as string;
    const fp = JSON.parse(raw);
    const entry = fp.envs?.prod?.['Existing WF'];
    expect(entry).toBeDefined();
    expect(entry.versionId).toBe('updated-v1');
    expect(entry.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('does a follow-up updateWorkflow when created workflow has a description', async () => {
    const wf = { ...makeSnapshotWf('src-1', 'New WF', 'v1'), description: 'Handles orders' };
    setupProject([wf], []);

    const createWorkflow = vi.fn().mockResolvedValue({ id: 'tgt-new', versionId: 'created-v1' });
    const updateWorkflow = vi.fn().mockResolvedValue({ versionId: 'desc-v1' });

    MockN8nClient.mockImplementation(() =>
      makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
        updateWorkflow,
      }) as never,
    );

    await runPush({ source: 'dev', target: 'prod', yes: true }, '/project');

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

    MockN8nClient.mockImplementation(() =>
      makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow,
        updateWorkflow,
      }) as never,
    );

    await runPush({ source: 'dev', target: 'prod', yes: true }, '/project');

    expect(createWorkflow).toHaveBeenCalledOnce();
    expect(updateWorkflow).not.toHaveBeenCalled();
  });

  it('does not write fingerprint when createWorkflow fails', async () => {
    const wf = makeSnapshotWf('src-1', 'Failing WF', 'v1');
    setupProject([wf], []);

    MockN8nClient.mockImplementation(() =>
      makeFullTargetClientMock({
        listWorkflows: vi.fn().mockResolvedValue([]),
        listCredentials: vi.fn().mockResolvedValue([]),
        listTags: vi.fn().mockResolvedValue([]),
        createWorkflow: vi.fn().mockRejectedValue(new Error('API error')),
      }) as never,
    );

    // suppress console output — we're only checking the fingerprints file
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPush({ source: 'dev', target: 'prod', yes: true }, '/project').catch(() => {});

    expect(vol.existsSync('/project/.flightdeck/fingerprints.json')).toBe(false);
  });
});
