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
import { runDiff } from '../../../src/commands/diff.js';
import type { WorkflowSummary } from '../../../src/lib/n8n-client.js';

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
    getWorkflow: overrides?.getWorkflow ?? vi.fn(),
  };
}

function setupTwoClientMocks(sourceMock: MockClient, targetMock: MockClient) {
  MockN8nClient.mockImplementation((_env, envName) =>
    (envName === 'dev' ? sourceMock : targetMock) as never,
  );
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('actor@example.com\n' as never);
});

function setupProject(config = VALID_CONFIG) {
  vol.fromJSON({
    '/project/.chiral/config.json': config,
    '/project/.chiral/audit.jsonl': '',
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
    '/project/.chiral/fingerprints.json',
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

describe('runDiff — setup errors', () => {
  it('throws UserError when git user.email is not set', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('no email'); });
    await expect(
      runDiff({ source: 'dev', target: 'prod' }, '/project'),
    ).rejects.toThrow(UserError);
  });

  it('throws UserError when config.json is missing', async () => {
    vol.fromJSON({});
    await expect(
      runDiff({ source: 'dev', target: 'prod' }, '/project'),
    ).rejects.toThrow(UserError);
    await expect(
      runDiff({ source: 'dev', target: 'prod' }, '/project'),
    ).rejects.toThrow('chiral init');
  });

  it('throws UserError when --source env is not in config', async () => {
    setupProject();
    await expect(
      runDiff({ source: 'staging', target: 'prod' }, '/project'),
    ).rejects.toThrow(UserError);
    await expect(
      runDiff({ source: 'staging', target: 'prod' }, '/project'),
    ).rejects.toThrow('Unknown environment "staging"');
  });

  it('throws UserError when --target env is not in config', async () => {
    setupProject();
    await expect(
      runDiff({ source: 'dev', target: 'staging' }, '/project'),
    ).rejects.toThrow(UserError);
    await expect(
      runDiff({ source: 'dev', target: 'staging' }, '/project'),
    ).rejects.toThrow('Unknown environment "staging"');
  });
});

// ── diff symbols ──────────────────────────────────────────────────────────────

describe('runDiff — diff symbols', () => {
  it('shows + for workflow in source not in target', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

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

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    expect(output.join('\n')).toContain('-');
    expect(output.join('\n')).toContain('Workflow Three');
  });

  it('shows ~ for workflow with differing versionId', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    expect(output.join('\n')).toContain('~');
    expect(output.join('\n')).toContain('Workflow One');
    expect(output.join('\n')).toContain('(modified)');
  });

  it('shows identical message when both envs match exactly', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    expect(output.join('\n')).toContain('identical');
    expect(output.join('\n')).not.toContain('+');
    expect(output.join('\n')).not.toContain('-');
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

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

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

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    const joined = output.join('\n');
    // SRC_WF2 not in target → 1 added; TGT_WF3 not in source → 1 removed; SRC_WF1 has different versionId → 1 modified
    expect(joined).toContain('1 added');
    expect(joined).toContain('1 modified');
    expect(joined).toContain('1 removed');
  });
});

// ── --show-unchanged ──────────────────────────────────────────────────────────

describe('runDiff — --show-unchanged', () => {
  it('hides unchanged workflows by default', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1, TGT_WF3]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    // SRC_WF1 / TGT_WF1 are identical — should not appear in output
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

    await runDiff({ source: 'dev', target: 'prod', showUnchanged: true }, '/project');

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

    await runDiff({ source: 'dev', target: 'prod', showUnchanged: true }, '/project');

    expect(output.join('\n')).toContain('Workflow One');
    expect(output.join('\n')).toContain('identical');
  });
});

// ── workflows.json name resolution ────────────────────────────────────────────

describe('runDiff — name resolution via workflows.json', () => {
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

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    // Should resolve as identical, not as added/removed
    expect(output.join('\n')).toContain('identical');
    expect(output.join('\n')).not.toContain('+');
    expect(output.join('\n')).not.toContain('-');
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

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    expect(output.join('\n')).toContain('~');
    expect(output.join('\n')).toContain('Order Processor [DEV]');
  });

  it('falls back to exact name when no mapping exists', async () => {
    setupProject();
    // workflows.json is absent — falls back to exact name matching
    const srcWf = makeSummary({ id: 'src-1', name: 'Workflow One', versionId: 'v1' });
    const tgtWf = makeSummary({ id: 'tgt-1', name: 'Workflow One', versionId: 'v1' });

    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([srcWf]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([tgtWf]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    expect(output.join('\n')).toContain('identical');
  });
});

// ── --json output ─────────────────────────────────────────────────────────────

describe('runDiff — --json output', () => {
  it('emits a single JSON object and no human text', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true }, '/project');

    expect(logged).toHaveLength(1);
    const result = JSON.parse(logged[0]);
    expect(result.source).toBe('dev');
    expect(result.target).toBe('prod');
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

    await runDiff({ source: 'dev', target: 'prod', json: true }, '/project');

    const result = JSON.parse(logged[0]);
    expect(result.modified.map((m: { name: string }) => m.name)).toContain('Workflow One');
    expect(result.added.map((a: { name: string }) => a.name)).toContain('Workflow Two');
    expect(result.removed.map((r: { name: string }) => r.name)).toContain('Workflow Three');
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

    await runDiff({ source: 'dev', target: 'prod', json: true }, '/project');

    const result = JSON.parse(logged[0]);
    expect(result.modified[0].sourceVersionId).toBe('v1');
    expect(result.modified[0].targetVersionId).toBe('v2');
  });

  it('excludes unchanged from JSON by default', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true }, '/project');

    const result = JSON.parse(logged[0]);
    expect(result.unchanged).toEqual([]);
  });

  it('includes unchanged in JSON when --show-unchanged is set', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', json: true, showUnchanged: true }, '/project');

    const result = JSON.parse(logged[0]);
    expect(result.unchanged.map((u: { name: string }) => u.name)).toContain('Workflow One');
  });
});

// ── --name-only output ────────────────────────────────────────────────────────

describe('runDiff — --name-only output', () => {
  it('prints only differing workflow names, one per line', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED, TGT_WF3]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    await runDiff({ source: 'dev', target: 'prod', nameOnly: true }, '/project');

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

    await runDiff({ source: 'dev', target: 'prod', nameOnly: true }, '/project');

    expect(logged).toHaveLength(0);
  });
});

// ── --tag filter ──────────────────────────────────────────────────────────────

describe('runDiff — --tag filter', () => {
  it('passes tag to listWorkflows on both source and target', async () => {
    setupProject();
    const srcList = vi.fn().mockResolvedValue([]);
    const tgtList = vi.fn().mockResolvedValue([]);
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: srcList }),
      makeClientMock({ listWorkflows: tgtList }),
    );

    await runDiff({ source: 'dev', target: 'prod', tag: 'production' }, '/project');

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

    await runDiff({ source: 'dev', target: 'prod', tag: 'production', nameOnly: true }, '/project');

    // Only tagged wf is in scope; untagged should not appear as added
    expect(logged).not.toContain('Untagged');
  });
});

// ── --pattern filter ──────────────────────────────────────────────────────────

describe('runDiff — --pattern filter', () => {
  it('applies pattern to source workflow names only', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1, SRC_WF2]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1, TGT_WF3]) }),
    );

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    // Pattern matches only "Workflow One"
    await runDiff({ source: 'dev', target: 'prod', pattern: 'Workflow O*', nameOnly: true }, '/project');

    // Only Workflow One is in scope from source — Workflow Two excluded by pattern
    // TGT_WF3 is in target but not matched by any scoped source → removed
    expect(logged).not.toContain('Workflow Two');
  });
});

// ── --exit-code ───────────────────────────────────────────────────────────────

describe('runDiff — --exit-code', () => {
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
      runDiff({ source: 'dev', target: 'prod', exitCode: true }, '/project'),
    ).resolves.toBeUndefined();
  });
});

// ── audit entries ─────────────────────────────────────────────────────────────

describe('runDiff — audit entries', () => {
  it('writes a success audit entry with source_env and target_env', async () => {
    setupProject();
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1]) }),
    );

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

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

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

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
      runDiff({ source: 'dev', target: 'prod' }, '/project'),
    ).rejects.toThrow('API key for dev is invalid or expired');

    const entry = JSON.parse(
      (vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string).trim(),
    );
    expect(entry.result).toBe('failure');
    expect(entry.error).toContain('API key for dev');
  });
});

// ── fingerprint-based change detection ───────────────────────────────────────

describe('runDiff — fingerprint-based change detection', () => {
  it('reports unchanged when fingerprints show identical content despite different versionId', async () => {
    setupProject();
    // Both envs have the SAME contentHash → identical despite versionId mismatch
    vol.writeFileSync(
      '/project/.chiral/fingerprints.json',
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

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    // Fingerprint fast path detected identical content — no API fetches
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

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    // Fallback path triggered — both sides fetched, content differs → modified
    expect(srcGetWorkflow).toHaveBeenCalledWith(SRC_WF1.id);
    expect(tgtGetWorkflow).toHaveBeenCalledWith(TGT_WF1_UPDATED.id);
    expect(output.join('\n')).toContain('~');
    expect(output.join('\n')).toContain('(modified)');
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

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

    // Content is the same → classified as unchanged (versionId bump was cosmetic)
    expect(output.join('\n')).toContain('identical');
    expect(output.join('\n')).not.toContain('~');
  });
});

// ── Next: hint ────────────────────────────────────────────────────────────────

describe('runDiff — Next: hint', () => {
  it('shows push --dry-run hint when differences found', async () => {
    setupProject();
    setupDivergentFingerprints('src-1', 'Workflow One', 'tgt-1', 'Workflow One');
    setupTwoClientMocks(
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([SRC_WF1]) }),
      makeClientMock({ listWorkflows: vi.fn().mockResolvedValue([TGT_WF1_UPDATED]) }),
    );

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await runDiff({ source: 'dev', target: 'prod' }, '/project');

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

    await runDiff({ source: 'dev', target: 'prod', tag: 'production' }, '/project');

    expect(output.join('\n')).toContain('--tag production');
    expect(output.join('\n')).toContain('--dry-run');
  });
});

