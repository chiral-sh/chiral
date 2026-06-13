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
import { confirm } from '@inquirer/prompts';
import { runWorkflowMatch } from '../../../src/commands/workflow.js';

const mockExecSync = vi.mocked(execSync);
const mockConfirm = vi.mocked(confirm);

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

function fpEntry(name: string, structureHash: string) {
  return {
    name,
    versionId: 'v1',
    contentHash: 'sha256:content',
    structureHash,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const FINGERPRINTS_EXACT = JSON.stringify({
  version: 1,
  envs: {
    dev: {
      'wf-1': fpEntry('Order Processor [DEV]', 'sha256:abc'),
    },
    prod: {
      'wf-2': fpEntry('Order Processor', 'sha256:abc'),
    },
  },
});

const FINGERPRINTS_AMBIGUOUS = JSON.stringify({
  version: 1,
  envs: {
    dev: {
      'wf-1': fpEntry('Shared', 'sha256:abc'),
    },
    prod: {
      'wf-2': fpEntry('Shared A', 'sha256:abc'),
      'wf-3': fpEntry('Shared B', 'sha256:abc'),
    },
  },
});

const FINGERPRINTS_NO_MATCH = JSON.stringify({
  version: 1,
  envs: {
    dev: {
      'wf-1': fpEntry('Lonely Source', 'sha256:src-only'),
    },
    prod: {
      'wf-2': fpEntry('Lonely Target', 'sha256:tgt-only'),
    },
  },
});

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('actor@example.com\n' as never);
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'test-project';
  vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: INDEX });
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
  Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
});

function setupBase(fingerprints: string, workflowsContent = EMPTY_WORKFLOWS) {
  vol.fromJSON({
    [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
    [`${PROJECT_DIR}/.chiral/workflows.json`]: workflowsContent,
    [`${PROJECT_DIR}/.chiral/fingerprints.json`]: fingerprints,
    [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
  });
}

describe('runWorkflowMatch', () => {
  it('throws UserError for unknown source env', async () => {
    setupBase(FINGERPRINTS_EXACT);
    await expect(
      runWorkflowMatch({ source: 'staging', target: 'prod' }),
    ).rejects.toThrow(UserError);
  });

  it('throws UserError when --source equals --target', async () => {
    setupBase(FINGERPRINTS_EXACT);
    await expect(
      runWorkflowMatch({ source: 'dev', target: 'dev' }),
    ).rejects.toThrow(UserError);
  });

  it('throws UserError with adopt hint when fingerprints missing for an env', async () => {
    vol.fromJSON({
      [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
      [`${PROJECT_DIR}/.chiral/workflows.json`]: EMPTY_WORKFLOWS,
      [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
    });
    await expect(
      runWorkflowMatch({ source: 'dev', target: 'prod' }),
    ).rejects.toThrow(/chiral adopt --env dev/);
  });

  it('--yes writes all exact matches and an audit entry with match_method exact', async () => {
    setupBase(FINGERPRINTS_EXACT);
    await runWorkflowMatch({ source: 'dev', target: 'prod', yes: true, json: true });

    const written = JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, 'utf-8') as string);
    expect(written.workflows['order-processor']).toEqual({
      dev: { name: 'Order Processor [DEV]' },
      prod: { name: 'Order Processor' },
    });

    const audit = vol.readFileSync(`${PROJECT_DIR}/.chiral/audit.jsonl`, 'utf-8') as string;
    const entry = JSON.parse(audit.trim().split('\n').pop()!);
    expect(entry.match_method).toBe('exact');
    expect(entry.match_score).toBeNull();
    expect(entry.action).toBe('map');
  });

  it('without --yes a declined batch confirm writes nothing', async () => {
    setupBase(FINGERPRINTS_EXACT);
    mockConfirm.mockResolvedValue(false);

    await runWorkflowMatch({ source: 'dev', target: 'prod' });

    const written = JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, 'utf-8') as string);
    expect(written.workflows).toEqual({});
  });

  it('ambiguous ties are reported and not written', async () => {
    setupBase(FINGERPRINTS_AMBIGUOUS);

    await runWorkflowMatch({ source: 'dev', target: 'prod', yes: true, json: true });

    const written = JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, 'utf-8') as string);
    expect(written.workflows).toEqual({});
  });

  it('a fan-in introduced by Pass 1 throws via the validator and leaves workflows.json unwritten', async () => {
    // Two source workflows share a structureHash, but only one target shares it -
    // both would map to the same target name, creating a fan-in.
    const fingerprintsWithFanIn = JSON.stringify({
      version: 1,
      envs: {
        dev: {
          'wf-1': fpEntry('Order A [DEV]', 'sha256:abc'),
          'wf-2': fpEntry('Order B [DEV]', 'sha256:abc'),
        },
        prod: {
          'wf-3': fpEntry('Shared Target', 'sha256:abc'),
        },
      },
    });
    setupBase(fingerprintsWithFanIn);

    await expect(
      runWorkflowMatch({ source: 'dev', target: 'prod', yes: true }),
    ).rejects.toThrow(UserError);

    const written = JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, 'utf-8') as string);
    expect(written.workflows).toEqual({});
  });

  it('--dry-run produces output but no file write/audit/sync', async () => {
    setupBase(FINGERPRINTS_EXACT);

    await runWorkflowMatch({ source: 'dev', target: 'prod', dryRun: true, json: true });

    const written = JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.chiral/workflows.json`, 'utf-8') as string);
    expect(written.workflows).toEqual({});

    const audit = vol.readFileSync(`${PROJECT_DIR}/.chiral/audit.jsonl`, 'utf-8') as string;
    expect(audit.trim()).toBe('');
  });

  it('--json emits candidates/unmatched_source/unmatched_target', async () => {
    setupBase(FINGERPRINTS_NO_MATCH);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWorkflowMatch({ source: 'dev', target: 'prod', json: true });

    const jsonCall = logSpy.mock.calls.find(([line]) => typeof line === 'string' && line.includes('"candidates"'));
    logSpy.mockRestore();
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0] as string);
    expect(parsed.data.candidates).toEqual([]);
    expect(parsed.data.unmatched_source).toEqual(['Lonely Source']);
    expect(parsed.data.unmatched_target).toEqual(['Lonely Target']);
  });

  it('already-mapped workflows are skipped', async () => {
    const mapWithEntry = JSON.stringify({
      version: 1,
      workflows: {
        'order-processor': {
          dev: { name: 'Order Processor [DEV]' },
          prod: { name: 'Order Processor' },
        },
      },
    });
    setupBase(FINGERPRINTS_EXACT, mapWithEntry);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWorkflowMatch({ source: 'dev', target: 'prod', yes: true, json: true });

    const jsonCall = logSpy.mock.calls.find(([line]) => typeof line === 'string' && line.includes('"candidates"'));
    logSpy.mockRestore();
    const parsed = JSON.parse(jsonCall![0] as string);
    expect(parsed.data.candidates).toEqual([]);
  });
});
