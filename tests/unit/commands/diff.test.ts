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

vi.mock('../../../src/lib/pager.js', () => ({
  pageOutput: vi.fn().mockImplementation(async (text: string) => { console.log(text); }),
}));

import { execSync } from 'node:child_process';
import { N8nClient } from '../../../src/lib/n8n-client.js';
import { pageOutput } from '../../../src/lib/pager.js';
import { runDiff } from '../../../src/commands/diff.js';
import { computeContentHash, computeStructureHash } from '../../../src/state/fingerprints.js';
import { buildCredentialMap, applyCredentialMap } from '../../../src/state/credentials.js';
import type { WorkflowSummary } from '../../../src/lib/n8n-client.js';

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

function makeSummary(overrides: Partial<WorkflowSummary>): WorkflowSummary {
  return {
    id: 'wf-1',
    name: 'Workflow One',
    active: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    tags: [],
    versionId: 'v1',
    ...overrides,
  };
}

const SRC_WF1 = makeSummary({ id: 'src-1', name: 'Workflow One', versionId: 'v1' });
const SRC_WF2 = makeSummary({ id: 'src-2', name: 'Workflow Two', versionId: 'v1' });
const TGT_WF1 = makeSummary({ id: 'tgt-1', name: 'Workflow One', versionId: 'v1' });
const TGT_WF1_UPDATED = makeSummary({ id: 'tgt-1', name: 'Workflow One', versionId: 'v2' });
const TGT_WF3 = makeSummary({ id: 'tgt-3', name: 'Workflow Three', versionId: 'v1' });

type MockClient = {
  warnIfExpiringSoon: ReturnType<typeof vi.fn>;
  listWorkflows: ReturnType<typeof vi.fn>;
  getWorkflow: ReturnType<typeof vi.fn>;
};

function makeClientMock(overrides?: Partial<MockClient>): MockClient {
  return {
    warnIfExpiringSoon: vi.fn(),
    listWorkflows: overrides?.listWorkflows ?? vi.fn().mockResolvedValue([]),
    getWorkflow: overrides?.getWorkflow ?? vi.fn().mockResolvedValue({ nodes: [], connections: {} }),
  };
}

function setupTwoClientMocks(sourceMock: MockClient, targetMock: MockClient) {
  MockN8nClient.mockImplementation(function(_env, envName) {
    return (envName === 'dev' ? sourceMock : targetMock) as never;
  });
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
    [`${PROJECT_DIR}/.chiral/envs.json`]: JSON.stringify({ version: 1, envs: { dev: 'dev', prod: 'prod' } }),
  });
}

// Pre-populate fingerprints so the fallback path is not triggered.
// Tests that assert 'modified' behaviour need source and target to have
// divergent content hashes; tests that assert 'unchanged' pass matching hashes.
function setupDivergentFingerprints(
  srcId: string,
  srcName: string,
  tgtId = srcId,
  tgtName = srcName,
) {
  vol.writeFileSync(
    `${PROJECT_DIR}/.chiral/fingerprints.json`,
    JSON.stringify({
      version: 1,
      envs: {
        dev: {
          [srcId]: {
            name: srcName,
            versionId: 'v1',
            contentHash: 'sha256:' + 'a'.repeat(64),
            structureHash: 'sha256:' + 'a'.repeat(64),
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
        prod: {
          [tgtId]: {
            name: tgtName,
            versionId: 'v2',
            contentHash: 'sha256:' + 'b'.repeat(64),
            structureHash: 'sha256:' + 'b'.repeat(64),
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      },
    }),
  );
}

// ── setup errors ──────────────────────────────────────────────────────────────

describe('runDiff - setup errors', () => {
  it('throws UserError when git user.email is not set', async () => {
    setupProject();
    mockExecSync.mockImplementation(() => { throw new Error('no email'); });
    await expect(
      runDiff({ source: 'dev', target: 'prod' }),
    ).rejects.toThrow(UserError);
  });

  it('throws UserError when config.json is missing', async () => {
    vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: INDEX });
    await expect(
      runDiff({ source: 'dev', target: 'prod' }),
    ).rejects.toThrow(UserError);
    await expect(
      runDiff({ source: 'dev', target: 'prod' }),
    ).rejects.toThrow('chiral environment add');
  });

  it('throws UserError when --source env is not in config', async () => {
    setupProject();
    await expect(
      runDiff({ source: 'staging', target: 'prod' }),
    ).rejects.toThrow(UserError);
    await expect(
      runDiff({ source: 'staging', target: 'prod' }),
    ).rejects.toThrow('Unknown environment "staging"');
  });

  it('throws UserError when --target env is not in config', async () => {
    setupProject();
    await expect(
      runDiff({ source: 'dev', target: 'staging' }),
    ).rejects.toThrow(UserError);
    await expect(
      runDiff({ source: 'dev', target: 'staging' }),
    ).rejects.toThrow('Unknown environment "staging"');
  });
});

// ── diff symbols ──────────────────────────────────────────────────────────────

describe('runDiff - diff symbols', () => {
  it('shows + for workflow in source not in target', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    expect(output.join('\n')).toContain('+');
    expect(output.join('\n')).toContain('Workflow Two');
    expect(output.join('\n')).toContain('wrong name?');
  });

  it('shows - for workflow in target not in source', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1, TGT_WF3]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    expect(output.join('\n')).toContain('-');
    expect(output.join('\n')).toContain('Workflow Three');
  });

  it('shows stat table for workflow with differing versionId', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    expect(joined).toContain('Workflow One');
    expect(joined).toContain('+0');
    expect(joined).toContain('~0');
    expect(joined).not.toContain('(logic changed)');
  });

  it('shows identical message when both envs match exactly', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    expect(output.join('\n')).toContain('identical');
    expect(output.join('\n')).not.toContain('+');
    expect(output.join('\n')).not.toMatch(/^\s*-\s+/m);
    expect(output.join('\n')).not.toContain('~');
  });

  it('shows warning when no workflows found in scope', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    expect(output.join('\n')).toContain('No workflows found in scope');
  });

  it('shows summary line with counts when differences exist', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED, TGT_WF3]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    // SRC_WF2 not in target → 1 added; TGT_WF3 not in source → 1 removed; SRC_WF1 has different versionId → 1 modified
    expect(joined).toContain('1 added');
    expect(joined).toContain('1 modified');
    expect(joined).toContain('1 removed');
  });
});

// ── --show-unchanged ──────────────────────────────────────────────────────────

describe('runDiff - --show-unchanged', () => {
  it('hides unchanged workflows by default', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1, TGT_WF3]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    // SRC_WF1 / TGT_WF1 are identical - should not appear in output
    expect(output.join('\n')).not.toContain('identical');
  });

  it('shows unchanged workflows with (identical) label when --show-unchanged is set', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1, TGT_WF3]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod', showUnchanged: true });

    expect(output.join('\n')).toContain('Workflow One');
    expect(output.join('\n')).toContain('identical');
  });

  it('shows unchanged in --show-unchanged when envs are identical', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod', showUnchanged: true });

    expect(output.join('\n')).toContain('Workflow One');
    expect(output.join('\n')).toContain('identical');
  });
});

// ── workflows.json name resolution ────────────────────────────────────────────

describe('runDiff - name resolution via workflows.json', () => {
  it('matches workflows by mapped name across environments', async () => {
    setupProject();
    vol.writeFileSync(
      '/project/.chiral/workflows.json',
      JSON.stringify({
        version: 1,
        workflows: {
          'order-processor': { dev: { name: 'Order Processor [DEV]' }, prod: { name: 'Order Processor' } },
        },
      }),
    );

    const srcWf = makeSummary({ id: 'src-op', name: 'Order Processor [DEV]', versionId: 'v1' });
    const tgtWf = makeSummary({ id: 'tgt-op', name: 'Order Processor', versionId: 'v1' });

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([srcWf]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([tgtWf]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    // Should resolve as identical, not as added/removed
    expect(output.join('\n')).toContain('identical');
    expect(output.join('\n')).not.toContain('+');
    expect(output.join('\n')).not.toMatch(/^\s*-\s+/m);
  });

  it('shows ~ when mapped workflow has a different versionId', async () => {
    setupProject();
    vol.writeFileSync(
      '/project/.chiral/workflows.json',
      JSON.stringify({
        version: 1,
        workflows: {
          'order-processor': { dev: { name: 'Order Processor [DEV]' }, prod: { name: 'Order Processor' } },
        },
      }),
    );
    // Source key = 'Order Processor [DEV]', target key = 'Order Processor' (mapped name)
    setupDivergentFingerprints('src-op', 'Order Processor [DEV]', 'tgt-op', 'Order Processor');

    const srcWf = makeSummary({ id: 'src-op', name: 'Order Processor [DEV]', versionId: 'v1' });
    const tgtWf = makeSummary({ id: 'tgt-op', name: 'Order Processor', versionId: 'v2' });

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([srcWf]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([tgtWf]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    expect(output.join('\n')).toContain('~');
    expect(output.join('\n')).toContain('Order Processor');
  });

  it('falls back to exact name when no mapping exists', async () => {
    setupProject();
    // workflows.json is absent - falls back to exact name matching
    const srcWf = makeSummary({ id: 'src-1', name: 'Workflow One', versionId: 'v1' });
    const tgtWf = makeSummary({ id: 'tgt-1', name: 'Workflow One', versionId: 'v1' });

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([srcWf]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([tgtWf]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    expect(output.join('\n')).toContain('identical');
  });
});

// ── --json output ─────────────────────────────────────────────────────────────

describe('runDiff - --json output', () => {
  it('emits a single JSON object and no human text', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    expect(logged).toHaveLength(1);
    const result = JSON.parse(logged[0]);
    expect(result.status).toBe('ok');
    expect(result.data.source).toBe('dev');
    expect(result.data.target).toBe('prod');
  });

  it('includes added/removed/modified arrays in JSON output', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED, TGT_WF3]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.data.modified.map((m: { name: string }) => m.name)).toContain('Workflow One');
    expect(result.data.added.map((a: { name: string }) => a.name)).toContain('Workflow Two');
    expect(result.data.removed.map((r: { name: string }) => r.name)).toContain('Workflow Three');
  });

  it('includes sourceVersionId and targetVersionId for modified workflows', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.data.modified[0].sourceVersionId).toBe('v1');
    expect(result.data.modified[0].targetVersionId).toBe('v2');
  });

  it('excludes unchanged from JSON by default', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.data.unchanged).toEqual([]);
  });

  it('includes unchanged in JSON when --show-unchanged is set', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true, showUnchanged: true });

    const result = JSON.parse(logged[0]);
    expect(result.data.unchanged.map((u: { name: string }) => u.name)).toContain('Workflow One');
  });
});

// ── --name-only output ────────────────────────────────────────────────────────

describe('runDiff - --name-only output', () => {
  it('prints only differing workflow names, one per line', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED, TGT_WF3]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', nameOnly: true });

    expect(logged).toContain('Workflow One');   // modified
    expect(logged).toContain('Workflow Two');   // added
    expect(logged).toContain('Workflow Three'); // removed
  });

  it('prints nothing when envs are identical', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', nameOnly: true });

    expect(logged).toHaveLength(0);
  });
});

// ── --tag filter ──────────────────────────────────────────────────────────────

describe('runDiff - --tag filter', () => {
  it('passes tag to listWorkflows on both source and target', async () => {
    setupProject();
    const srcList = vi.fn().mockResolvedValue([]);
    const tgtList = vi.fn().mockResolvedValue([]);
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: srcList }),
      makeClientMock({ listWorkflows: tgtList }),
    );

    await runDiff({ source: 'dev', target: 'prod', tag: 'production' });

    expect(srcList).toHaveBeenCalledWith({ tags: 'production' });
    expect(tgtList).toHaveBeenCalledWith({ tags: 'production' });
  });

  it('client-side filters out source workflows without the tag', async () => {
    setupProject();
    const taggedWf = makeSummary({ id: 'src-1', name: 'Tagged', tags: [{ id: 't1', name: 'production' }] });
    const untaggedWf = makeSummary({ id: 'src-2', name: 'Untagged', tags: [] });
    const tgtTagged = makeSummary({ id: 'tgt-1', name: 'Tagged', tags: [{ id: 't1', name: 'production' }] });

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([taggedWf, untaggedWf]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([tgtTagged]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', tag: 'production', nameOnly: true });

    // Only tagged wf is in scope; untagged should not appear as added
    expect(logged).not.toContain('Untagged');
  });
});

// ── --pattern filter ──────────────────────────────────────────────────────────

describe('runDiff - --pattern filter', () => {
  it('applies pattern to source workflow names only', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1, TGT_WF3]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    // Pattern matches only "Workflow One"
    await runDiff({ source: 'dev', target: 'prod', pattern: 'Workflow O*', nameOnly: true });

    // Only Workflow One is in scope from source - Workflow Two excluded by pattern
    // TGT_WF3 is in target but not matched by any scoped source → removed
    expect(logged).not.toContain('Workflow Two');
  });
});

// ── --exit-code ───────────────────────────────────────────────────────────────

describe('runDiff - --exit-code', () => {
  it('throws ControlledExit(1) when differences exist', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    const err = await runDiff(
      { source: 'dev', target: 'prod', exitCode: true },
      '/project',
    ).catch((e) => e);

    expect(err.name).toBe('ControlledExit');
    expect(err.code).toBe(1);
  });

  it('does not throw when envs are identical', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    await expect(
      runDiff({ source: 'dev', target: 'prod', exitCode: true }),
    ).resolves.toBeUndefined();
  });
});

// ── audit entries ─────────────────────────────────────────────────────────────

describe('runDiff - audit entries', () => {
  it('writes a success audit entry with source_env and target_env', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    await runDiff({ source: 'dev', target: 'prod' });

    const entry = JSON.parse(
      (vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string).trim(),
    );
    expect(entry.action).toBe('diff');
    expect(entry.result).toBe('success');
    expect(entry.source_env).toBe('dev');
    expect(entry.target_env).toBe('prod');
  });

  it('writes source workflow ids in the audit entry', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    await runDiff({ source: 'dev', target: 'prod' });

    const entry = JSON.parse(
      (vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string).trim(),
    );
    expect(entry.workflow_ids).toContain('src-1');
    expect(entry.workflow_ids).toContain('src-2');
  });

  it('writes a failure audit entry and re-throws on API error', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockRejectedValue(new UserError('API key for dev is invalid or expired')),
      }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([]) }),
    );

    await expect(
      runDiff({ source: 'dev', target: 'prod' }),
    ).rejects.toThrow('API key for dev is invalid or expired');

    const entry = JSON.parse(
      (vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string).trim(),
    );
    expect(entry.result).toBe('failure');
    expect(entry.error).toContain('API key for dev');
  });
});

// ── fingerprint-based change detection ───────────────────────────────────────

describe('runDiff - fingerprint-based change detection', () => {
  it('reports unchanged when fingerprints show identical content despite different versionId', async () => {
    setupProject();
    // Both envs have the SAME contentHash → identical despite versionId mismatch
    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/fingerprints.json`,
      JSON.stringify({
        version: 1,
        envs: {
          dev: { 'src-1': { name: 'Workflow One', versionId: 'v1', contentHash: 'sha256:' + 'a'.repeat(64), structureHash: 'sha256:' + 'a'.repeat(64), updatedAt: '2024-01-01T00:00:00.000Z' } },
          prod: { 'tgt-1': { name: 'Workflow One', versionId: 'v2', contentHash: 'sha256:' + 'a'.repeat(64), structureHash: 'sha256:' + 'a'.repeat(64), updatedAt: '2024-01-01T00:00:00.000Z' } },
        },
      }),
    );

    const srcGetWorkflow = vi.fn();
    const tgtGetWorkflow = vi.fn();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]), getWorkflow: srcGetWorkflow }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]), getWorkflow: tgtGetWorkflow }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    // Fingerprint fast path detected identical content - no API fetches
    expect(srcGetWorkflow).not.toHaveBeenCalled();
    expect(tgtGetWorkflow).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('identical');
    expect(output.join('\n')).not.toContain('~');
  });

  it('fetches full workflows via fallback when fingerprints are absent and detects real modification', async () => {
    setupProject(); // no fingerprints.json

    const srcFull = { ...SRC_WF1, nodes: [{ name: 'Node', type: 'n8n-nodes-base.httpRequest', parameters: {} }], connections: {}, settings: {} };
    const tgtFull = { ...TGT_WF1_UPDATED, nodes: [{ name: 'Node', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://changed.example.com' } }], connections: {}, settings: {} };

    const srcGetWorkflow = vi.fn().mockResolvedValue(srcFull);
    const tgtGetWorkflow = vi.fn().mockResolvedValue(tgtFull);
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]), getWorkflow: srcGetWorkflow }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]), getWorkflow: tgtGetWorkflow }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    // Fallback path triggered - both sides fetched, content differs → configuration changed
    expect(srcGetWorkflow).toHaveBeenCalledWith(SRC_WF1.id);
    expect(tgtGetWorkflow).toHaveBeenCalledWith(TGT_WF1_UPDATED.id);
    // Stat table is shown: modified node appears as ~1
    expect(output.join('\n')).toContain('~1');
    expect(output.join('\n')).toContain('Workflow One');
  });

  it('reports unchanged via fallback when full workflow content matches despite different versionId', async () => {
    setupProject(); // no fingerprints.json

    // Same content on both sides → fallback computes equal hashes → unchanged
    const sharedContent = { nodes: [{ name: 'Node', type: 'n8n-nodes-base.httpRequest', parameters: {} }], connections: {}, settings: {} };
    const srcFull = { ...SRC_WF1, ...sharedContent };
    const tgtFull = { ...TGT_WF1_UPDATED, ...sharedContent };

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]), getWorkflow: vi.fn().mockResolvedValue(srcFull) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]), getWorkflow: vi.fn().mockResolvedValue(tgtFull) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    // Content is the same → classified as unchanged (versionId bump was cosmetic)
    expect(output.join('\n')).toContain('identical');
    expect(output.join('\n')).not.toContain('~');
  });

  it('reports unchanged when logically identical workflows differ only by mapped credential name', async () => {
    setupProject();

    const baseWorkflow = {
      name: 'Workflow One',
      description: '',
      nodes: [
        {
          id: 'node-a',
          name: 'HTTP Request',
          type: 'n8n-nodes-base.httpRequest',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
          credentials: { httpHeaderAuth: { id: 'cred-id-dev', name: 'dev_stripe' } },
        },
      ],
      connections: {},
      settings: {},
    };
    const srcWorkflow = baseWorkflow;
    const tgtWorkflow = {
      ...baseWorkflow,
      nodes: [
        {
          ...baseWorkflow.nodes[0],
          credentials: { httpHeaderAuth: { id: 'cred-id-prod', name: 'prod_stripe' } },
        },
      ],
    };

    // Fingerprints are written from credential-map-normalized workflows (see
    // push.ts / diff.ts): mapped credential names collapse to the target name
    // before hashing, so the stored hashes match despite the raw name diff.
    const credentials = {
      version: 1 as const,
      credentials: { stripe: { dev: 'dev_stripe', prod: 'prod_stripe' } },
    };
    const credMap = buildCredentialMap(srcWorkflow.nodes, 'dev', 'prod', credentials);
    const srcNormalized = applyCredentialMap(srcWorkflow, credMap);
    const tgtNormalized = applyCredentialMap(tgtWorkflow, credMap);

    const srcContentHash = computeContentHash(srcNormalized);
    const tgtContentHash = computeContentHash(tgtNormalized);
    const srcStructureHash = computeStructureHash(srcWorkflow);
    const tgtStructureHash = computeStructureHash(tgtWorkflow);

    // Mapped credential name differences must not affect the content hash
    // once normalized through the credential map.
    expect(srcContentHash).toBe(tgtContentHash);

    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/credentials.json`,
      JSON.stringify(credentials),
    );

    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/fingerprints.json`,
      JSON.stringify({
        version: 1,
        envs: {
          dev: { 'src-1': { name: 'Workflow One', versionId: 'v1', contentHash: srcContentHash, structureHash: srcStructureHash, updatedAt: '2024-01-01T00:00:00.000Z' } },
          prod: { 'tgt-1': { name: 'Workflow One', versionId: 'v2', contentHash: tgtContentHash, structureHash: tgtStructureHash, updatedAt: '2024-01-01T00:00:00.000Z' } },
        },
      }),
    );

    const srcGetWorkflow = vi.fn();
    const tgtGetWorkflow = vi.fn();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]), getWorkflow: srcGetWorkflow }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]), getWorkflow: tgtGetWorkflow }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const printed = JSON.parse(output.join(''));
    expect(printed.data.unchanged).toEqual([]);
    expect(printed.data.modified).toEqual([]);

    // Re-run with --show-unchanged in JSON mode to confirm classification.
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('actor@example.com\n' as never);
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]), getWorkflow: srcGetWorkflow }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]), getWorkflow: tgtGetWorkflow }),
    );
    const output2: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output2.push(args.join(' ')));
    await runDiff({ source: 'dev', target: 'prod', json: true, showUnchanged: true });
    const printed2 = JSON.parse(output2.join(''));
    expect(printed2.data.unchanged.map((u: { name: string }) => u.name)).toContain('Workflow One');
    expect(printed2.data.modified).toEqual([]);

    expect(srcGetWorkflow).not.toHaveBeenCalled();
    expect(tgtGetWorkflow).not.toHaveBeenCalled();
  });

  it('reports a genuine logic change as modified even after the credential-name fix', async () => {
    setupProject();

    const srcWorkflow = {
      name: 'Workflow One',
      description: '',
      nodes: [
        {
          id: 'node-a',
          name: 'HTTP Request',
          type: 'n8n-nodes-base.httpRequest',
          typeVersion: 1,
          position: [0, 0],
          parameters: { url: 'https://example.com/a' },
          credentials: { httpHeaderAuth: { id: 'cred-id-dev', name: 'dev_stripe' } },
        },
      ],
      connections: {},
      settings: {},
    };
    const tgtWorkflow = {
      ...srcWorkflow,
      nodes: [
        {
          ...srcWorkflow.nodes[0],
          parameters: { url: 'https://example.com/b' },
          credentials: { httpHeaderAuth: { id: 'cred-id-prod', name: 'prod_stripe' } },
        },
      ],
    };

    const srcContentHash = computeContentHash(srcWorkflow);
    const tgtContentHash = computeContentHash(tgtWorkflow);
    const srcStructureHash = computeStructureHash(srcWorkflow);
    const tgtStructureHash = computeStructureHash(tgtWorkflow);

    expect(srcContentHash).not.toBe(tgtContentHash);

    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/fingerprints.json`,
      JSON.stringify({
        version: 1,
        envs: {
          dev: { 'src-1': { name: 'Workflow One', versionId: 'v1', contentHash: srcContentHash, structureHash: srcStructureHash, updatedAt: '2024-01-01T00:00:00.000Z' } },
          prod: { 'tgt-1': { name: 'Workflow One', versionId: 'v2', contentHash: tgtContentHash, structureHash: tgtStructureHash, updatedAt: '2024-01-01T00:00:00.000Z' } },
        },
      }),
    );

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]), getWorkflow: vi.fn().mockResolvedValue(srcWorkflow) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]), getWorkflow: vi.fn().mockResolvedValue(tgtWorkflow) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const printed = JSON.parse(output.join(''));
    expect(printed.data.modified.map((m: { name: string }) => m.name)).toContain('Workflow One');
    expect(printed.data.unchanged).toEqual([]);
  });
});

// ── + hint text ───────────────────────────────────────────────────────────────

describe('runDiff - + hint text for added workflows', () => {
  it('shows "will be created" for unmapped added workflow', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    expect(joined).toContain('will be created');
    expect(joined).toContain('wrong name? run: chiral workflow map');
    // Must NOT include the old "in dev, not in prod" prefix
    expect(joined).not.toContain('in dev, not in prod');
  });

  it('shows mapped hint without "in X, not in Y" prefix for mapped-but-not-found workflow', async () => {
    setupProject();
    vol.writeFileSync(
      '/project/.chiral/workflows.json',
      JSON.stringify({
        version: 1,
        workflows: {
          'invoice-sync': { dev: { name: 'Invoice Sync [DEV]' }, prod: { name: 'Invoice Sync' } },
        },
      }),
    );

    const srcWf = makeSummary({ id: 'src-inv', name: 'Invoice Sync [DEV]', versionId: 'v1' });
    // Target does NOT have 'Invoice Sync' → appears as added with mapped hint
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([srcWf]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    expect(joined).toContain('mapped to "Invoice Sync" in prod but not found - does it exist?');
    expect(joined).not.toContain('in dev, not in prod');
    expect(joined).not.toContain('run: chiral workflow map');
  });
});

// ── output mode ───────────────────────────────────────────────────────────────

describe('runDiff - output mode selection', () => {
  it('suppresses spinner and header when --json is set', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    // Only one line emitted: the JSON blob
    expect(logged).toHaveLength(1);
    expect(() => JSON.parse(logged[0])).not.toThrow();
  });

  it('suppresses spinner and header when --name-only is set', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', nameOnly: true });

    // Envs are identical → no names emitted, no header text
    expect(logged).toHaveLength(0);
  });
});

// ── Next: hint ────────────────────────────────────────────────────────────────

describe('runDiff - Next: hint', () => {
  it('shows push --dry-run hint when differences found', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    expect(output.join('\n')).toContain('chiral push --source dev --target prod --dry-run');
  });

  it('carries --tag filter into push hint', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    const taggedSrc = makeSummary({ id: 'src-1', name: 'Workflow One', tags: [{ id: 't1', name: 'production' }], versionId: 'v1' });
    const taggedTgt = makeSummary({ id: 'tgt-1', name: 'Workflow One', tags: [{ id: 't1', name: 'production' }], versionId: 'v2' });

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([taggedSrc]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([taggedTgt]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod', tag: 'production' });

    expect(output.join('\n')).toContain('--tag production');
    expect(output.join('\n')).toContain('--dry-run');
  });
});

// ── node diff in --json output ────────────────────────────────────────────────

describe('runDiff - node diff in --json output', () => {
  it('modified entries include nodes object with correct added/removed/modified/connections', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    // src has node-a only; tgt adds node-b and node-c.
    // node-a: matched by id, identical → unchanged
    // node-b, node-c: only in tgt, no match in src → 2 added
    // connections: src has one edge a→b, tgt has none (nodes added to dev)
    const srcFull = {
      nodes: [
        { id: 'node-a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' },
        { id: 'node-b', name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} },
        { id: 'node-c', name: 'Set Data', type: 'n8n-nodes-base.set', parameters: {} },
      ],
      connections: { Trigger: { main: [[{ node: 'Slack', type: 'main', index: 0 }]] } },
    };
    const tgtFull = {
      nodes: [
        { id: 'node-a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' },
      ],
      connections: {},
    };

    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]),
        getWorkflow: vi.fn().mockResolvedValue(srcFull),
      }),
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]),
        getWorkflow: vi.fn().mockResolvedValue(tgtFull),
      }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    const modified = result.data.modified[0];
    expect(modified.nodes).toBeDefined();
    expect(modified.nodes.added).toHaveLength(2);   // Slack + Set Data
    expect(modified.nodes.removed).toHaveLength(0);
    expect(modified.nodes.modified).toHaveLength(0);
    expect(modified.nodes.connections).toEqual({ added: 1, removed: 0 });
    expect(modified.nodes.counts).toEqual({ added: 2, modified: 0, removed: 0 });
  });

  it('modified entries include nodes.modified for parameter-only change', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    const srcFull = {
      nodes: [{ id: 'node-a', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://old.example.com' } }],
      connections: {},
    };
    const tgtFull = {
      nodes: [{ id: 'node-a', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://new.example.com' } }],
      connections: {},
    };

    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]),
        getWorkflow: vi.fn().mockResolvedValue(srcFull),
      }),
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]),
        getWorkflow: vi.fn().mockResolvedValue(tgtFull),
      }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    const modified = result.data.modified[0];
    expect(modified.nodes.modified).toHaveLength(1);
    expect(modified.nodes.modified[0].name).toBe('HTTP Request');
    expect(modified.nodes.modified[0].changed).toContain('parameters');
    expect(modified.nodes.added).toHaveLength(0);
    expect(modified.nodes.removed).toHaveLength(0);
  });

  it('added and removed workflow JSON shapes are untouched by node diff', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF3]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.data.added[0]).toEqual({
      name: 'Workflow Two',
      sourceName: 'Workflow Two',
      hint: 'wrong name?',
      lock: null,
    });
    expect(result.data.removed[0]).toEqual({ name: 'Workflow Three', lock: null });
    expect(result.data.added[0]).not.toHaveProperty('nodes');
    expect(result.data.removed[0]).not.toHaveProperty('nodes');
  });

  it('fetch error for a modified workflow surfaces as client error', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    const fetchError = new Error('API key for dev is invalid or expired');
    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]),
        getWorkflow: vi.fn().mockRejectedValue(fetchError),
      }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    await expect(
      runDiff({ source: 'dev', target: 'prod', json: true }),
    ).rejects.toThrow('API key for dev is invalid or expired');
  });
});

// ── stat table human output ───────────────────────────────────────────────────

describe('runDiff - stat table human output', () => {
  it('renders stat table with counts and churn bar for modified workflows', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    const srcFull = {
      nodes: [
        { id: 'a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' },
        { id: 'b', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', parameters: {} },
      ],
      connections: {},
    };
    const tgtFull = {
      nodes: [{ id: 'a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }],
      connections: {},
    };

    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]),
        getWorkflow: vi.fn().mockResolvedValue(srcFull),
      }),
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]),
        getWorkflow: vi.fn().mockResolvedValue(tgtFull),
      }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    // Stat table shows workflow name, +1 added, ~0 modified, -0 removed, and a bar
    expect(joined).toContain('Workflow One');
    expect(joined).toContain('+1');
    expect(joined).toContain('~0');
    expect(joined).toContain('-0');
    expect(joined).toMatch(/[█░]+/); // churn bar
    expect(joined).not.toContain('(logic changed)');
    expect(joined).not.toContain('(configuration changed)');
  });

  it('keeps + and - format for added and removed workflows', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED, TGT_WF3]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    // Added workflow still uses + prefix
    expect(joined).toContain('+');
    expect(joined).toContain('Workflow Two');
    // Removed workflow still uses - prefix
    expect(joined).toContain('-');
    expect(joined).toContain('Workflow Three');
  });

  it('still prints N added, M modified, K removed summary line', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED, TGT_WF3]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    expect(joined).toContain('1 added');
    expect(joined).toContain('1 modified');
    expect(joined).toContain('1 removed');
  });

  it('sorts modified workflows by churn descending in stat table', async () => {
    setupProject();
    // Two modified workflows: src-1 and src-2
    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/fingerprints.json`,
      JSON.stringify({
        version: 1,
        envs: {
          dev: {
            'src-1': { name: 'Workflow One', versionId: 'v1', contentHash: 'sha256:' + 'a'.repeat(64), structureHash: 'sha256:' + 'a'.repeat(64), updatedAt: '2024-01-01T00:00:00.000Z' },
            'src-2': { name: 'Workflow Two', versionId: 'v1', contentHash: 'sha256:' + 'c'.repeat(64), structureHash: 'sha256:' + 'c'.repeat(64), updatedAt: '2024-01-01T00:00:00.000Z' },
          },
          prod: {
            'tgt-1': { name: 'Workflow One', versionId: 'v2', contentHash: 'sha256:' + 'b'.repeat(64), structureHash: 'sha256:' + 'b'.repeat(64), updatedAt: '2024-01-01T00:00:00.000Z' },
            'tgt-2': { name: 'Workflow Two', versionId: 'v2', contentHash: 'sha256:' + 'd'.repeat(64), structureHash: 'sha256:' + 'd'.repeat(64), updatedAt: '2024-01-01T00:00:00.000Z' },
          },
        },
      }),
    );

    const WF2_SRC = makeSummary({ id: 'src-2', name: 'Workflow Two', versionId: 'v1' });
    const WF2_TGT = makeSummary({ id: 'tgt-2', name: 'Workflow Two', versionId: 'v2' });

    // Workflow One: 1 node on each side, 0 changes (same node) → 0 churn
    // Workflow Two: src has 0 nodes, tgt has 3 nodes → 3 added, higher churn
    const wf1Src = { nodes: [{ id: 'x', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }], connections: {} };
    const wf1Tgt = { nodes: [{ id: 'x', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }], connections: {} };
    const wf2Src = { nodes: [], connections: {} };
    const wf2Tgt = {
      nodes: [
        { id: 'a', name: 'N1', type: 'n8n-nodes-base.httpRequest', parameters: {} },
        { id: 'b', name: 'N2', type: 'n8n-nodes-base.set', parameters: {} },
        { id: 'c', name: 'N3', type: 'n8n-nodes-base.slack', parameters: {} },
      ],
      connections: {},
    };

    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, WF2_SRC]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          id === 'src-1' ? Promise.resolve(wf1Src) : Promise.resolve(wf2Src),
        ),
      }),
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED, WF2_TGT]),
        getWorkflow: vi.fn().mockImplementation((id: string) =>
          id === 'tgt-1' ? Promise.resolve(wf1Tgt) : Promise.resolve(wf2Tgt),
        ),
      }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    const wf1Pos = joined.indexOf('Workflow One');
    const wf2Pos = joined.indexOf('Workflow Two');
    // Workflow Two has higher churn → appears first in table
    expect(wf2Pos).toBeLessThan(wf1Pos);
  });
});

// ── --explain flag ────────────────────────────────────────────────────────────

describe('runDiff - --explain flag', () => {
  it('prints grouped named nodes for a known modified workflow', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Order Pipeline', 'tgt-1', 'Order Pipeline');

    const srcFull = {
      nodes: [
        { id: 'node-a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' },
      ],
      connections: {},
    };
    const tgtFull = {
      nodes: [
        { id: 'node-a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' },
        { id: 'node-b', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://example.com' } },
      ],
      connections: { Trigger: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
    };

    const srcWf = makeSummary({ id: 'src-1', name: 'Order Pipeline', versionId: 'v1' });
    const tgtWf = makeSummary({ id: 'tgt-1', name: 'Order Pipeline', versionId: 'v2' });

    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([srcWf]),
        getWorkflow: vi.fn().mockResolvedValue(srcFull),
      }),
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([tgtWf]),
        getWorkflow: vi.fn().mockResolvedValue(tgtFull),
      }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod', explain: 'Order Pipeline' });

    const joined = output.join('\n');
    expect(joined).toContain('Order Pipeline');
    expect(joined).toContain('Logic changed');
    expect(joined).toContain('HTTP Request');
    expect(joined).not.toContain('is not a modified workflow');
  });

  it('prints friendly hint when explain name does not match a modified workflow', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await expect(
      runDiff({ source: 'dev', target: 'prod', explain: 'Unknown Workflow' }),
    ).resolves.toBeUndefined();

    const joined = output.join('\n');
    expect(joined).toContain('"Unknown Workflow" is not a modified workflow');
    expect(joined).toContain('Modified: Workflow One');
  });

  it('prints no-modified hint when there are no modified workflows', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod', explain: 'Nonexistent' });

    const joined = output.join('\n');
    expect(joined).toContain('"Nonexistent" is not a modified workflow');
    expect(joined).toContain('No modified workflows');
  });
});

// ── --verbose flag ────────────────────────────────────────────────────────────

const mockPageOutput = vi.mocked(pageOutput);

describe('runDiff - --verbose flag', () => {
  it('expands every modified workflow named node changes through pageOutput', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    const srcFull = {
      nodes: [{ id: 'a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }],
      connections: {},
    };
    const tgtFull = {
      nodes: [
        { id: 'a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' },
        { id: 'b', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', parameters: {} },
      ],
      connections: { Trigger: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
    };

    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]),
        getWorkflow: vi.fn().mockResolvedValue(srcFull),
      }),
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]),
        getWorkflow: vi.fn().mockResolvedValue(tgtFull),
      }),
    );

    mockPageOutput.mockResolvedValue(undefined);

    await runDiff({ source: 'dev', target: 'prod', verbose: true });

    expect(mockPageOutput).toHaveBeenCalledOnce();
    const text = mockPageOutput.mock.calls[0]![0];
    expect(text).toContain('Workflow One');
    expect(text).toContain('Logic changed');
    expect(text).toContain('HTTP Request');
  });

  it('passes noPager: true to pageOutput when --no-pager is set', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    const srcFull = {
      nodes: [{ id: 'a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }],
      connections: {},
    };
    const tgtFull = {
      nodes: [
        { id: 'a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' },
        { id: 'b', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', parameters: {} },
      ],
      connections: { Trigger: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
    };

    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]),
        getWorkflow: vi.fn().mockResolvedValue(srcFull),
      }),
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]),
        getWorkflow: vi.fn().mockResolvedValue(tgtFull),
      }),
    );

    mockPageOutput.mockResolvedValue(undefined);

    await runDiff({ source: 'dev', target: 'prod', verbose: true, noPager: true });

    expect(mockPageOutput).toHaveBeenCalledWith(expect.any(String), { noPager: true });
  });

  it('prints output plainly to stdout when non-TTY (no pager spawned)', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');

    const srcFull = {
      nodes: [{ id: 'a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }],
      connections: {},
    };
    const tgtFull = {
      nodes: [
        { id: 'a', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' },
        { id: 'b', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', parameters: {} },
      ],
      connections: { Trigger: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
    };

    setupTwoClientMocks(
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]),
        getWorkflow: vi.fn().mockResolvedValue(srcFull),
      }),
      makeClientMock({
        listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]),
        getWorkflow: vi.fn().mockResolvedValue(tgtFull),
      }),
    );

    // Mock calls console.log with the text (default mock behavior)
    mockPageOutput.mockImplementation(async (text: string) => { console.log(text); });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod', verbose: true });

    const joined = output.join('\n');
    expect(joined).toContain('Workflow One');
    expect(joined).toContain('Logic changed');
    expect(joined).toContain('HTTP Request');
  });

  it('does not call pageOutput when there are no modified workflows', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    mockPageOutput.mockResolvedValue(undefined);

    await runDiff({ source: 'dev', target: 'prod', verbose: true });

    expect(mockPageOutput).not.toHaveBeenCalled();
  });
});

// ── lock badge annotations ────────────────────────────────────────────────────

describe('runDiff - lock badge annotations', () => {
  function writeLockFile(envId: string, workflowId: string, lock: object) {
    vol.mkdirSync(`/project/.chiral/locks/${envId}`, { recursive: true });
    vol.writeFileSync(
      `/project/.chiral/locks/${envId}/${workflowId}.lock`,
      JSON.stringify(lock),
    );
  }

  it('appends [LOCKED by ...] badge to a modified workflow in human output', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );
    writeLockFile('prod', 'tgt-1', {
      version: 1,
      actor: 'alice@example.com',
      timestamp: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      hostname: 'laptop',
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    expect(joined).toContain('LOCKED');
    expect(joined).toContain('alice@example.com');
    expect(joined).toContain('2h');
  });

  it('adds ⚠ indicator for stale lock (>24h) on modified workflow', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );
    writeLockFile('prod', 'tgt-1', {
      version: 1,
      actor: 'alice@example.com',
      timestamp: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
      hostname: 'laptop',
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    expect(joined).toContain('⚠');
    expect(joined).toContain('3 days');
  });

  it('appends [LOCKED by ...] badge to a removed workflow in human output', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1, TGT_WF3]) }),
    );
    writeLockFile('prod', 'tgt-3', {
      version: 1,
      actor: 'bob@example.com',
      timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      hostname: 'server',
    });

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    expect(joined).toContain('LOCKED');
    expect(joined).toContain('bob@example.com');
    expect(joined).toContain('Workflow Three');
  });

  it('shows no badge when no locks exist', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    expect(output.join('\n')).not.toContain('LOCKED');
  });

  it('adds lock field to JSON output for locked modified workflow', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );
    writeLockFile('prod', 'tgt-1', {
      version: 1,
      actor: 'alice@example.com',
      timestamp: new Date(Date.now() - 7200 * 1000).toISOString(),
      hostname: 'laptop',
    });

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    const mod = result.data.modified[0];
    expect(mod.lock).not.toBeNull();
    expect(mod.lock.actor).toBe('alice@example.com');
    expect(mod.lock.ageSeconds).toBeGreaterThanOrEqual(7200);
    expect(mod.lock).toHaveProperty('since');
  });

  it('adds lock: null to JSON output for unlocked modified workflow', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.data.modified[0].lock).toBeNull();
  });

  it('adds lock: null to JSON output for added workflows (no target)', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.data.added[0].lock).toBeNull();
  });

  it('treats listLocksByEnv error as no locks and renders no badge', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );
    // Write a corrupted lock file that will cause listLocksByEnv to throw
    vol.mkdirSync('/project/.chiral/locks/prod', { recursive: true });
    vol.writeFileSync('/project/.chiral/locks/prod/tgt-1.lock', 'not valid json');

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await expect(runDiff({ source: 'dev', target: 'prod' })).resolves.toBeUndefined();
    expect(output.join('\n')).not.toContain('LOCKED');
  });
});

// ── URL map differences ───────────────────────────────────────────────────────

describe('runDiff - URL map differences', () => {
  it('lists URL keys whose source and target values differ', async () => {
    setupProject();
    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/url-map.json`,
      JSON.stringify({
        version: 1,
        urls: {
          api_base: { values: { dev: 'https://api.dev.example.com', prod: 'https://api.example.com' } },
        },
      }),
    );
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    expect(joined).toContain('api_base');
    expect(joined).toContain('https://api.dev.example.com');
    expect(joined).toContain('https://api.example.com');
  });

  it('omits URL keys where source and target values are identical', async () => {
    setupProject();
    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/url-map.json`,
      JSON.stringify({
        version: 1,
        urls: {
          api_base: { values: { dev: 'https://api.example.com', prod: 'https://api.example.com' } },
          webhook: { values: { dev: 'https://hooks.dev.com', prod: 'https://hooks.prod.com' } },
        },
      }),
    );
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' });

    const joined = output.join('\n');
    expect(joined).not.toContain('api_base');
    expect(joined).toContain('webhook');
  });

  it('includes url_diffs in --json output, empty when nothing differs', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.data).toHaveProperty('url_diffs');
    expect(result.data.url_diffs).toEqual([]);
  });

  it('includes url_diffs entries in --json output when values differ', async () => {
    setupProject();
    vol.writeFileSync(
      `${PROJECT_DIR}/.chiral/url-map.json`,
      JSON.stringify({
        version: 1,
        urls: {
          api_base: { values: { dev: 'https://api.dev.example.com', prod: 'https://api.example.com' } },
        },
      }),
    );
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true });

    const result = JSON.parse(logged[0]);
    expect(result.data.url_diffs).toHaveLength(1);
    expect(result.data.url_diffs[0].logical_name).toBe('api_base');
    expect(result.data.url_diffs[0].source_value).toBe('https://api.dev.example.com');
    expect(result.data.url_diffs[0].target_value).toBe('https://api.example.com');
  });
});
