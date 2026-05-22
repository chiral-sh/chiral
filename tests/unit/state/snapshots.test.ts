import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import {
  generateDeploymentId,
  writeSnapshot,
  readSnapshot,
  listDeployments,
  listSnapshotWorkflows,
  pruneSnapshots,
  writeSnapshotMeta,
  readSnapshotMeta,
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  SnapshotWorkflow,
} from '../../../src/state/snapshots.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const WORKFLOW: SnapshotWorkflow = {
  id: 'wf-abc123',
  name: 'My Workflow',
  active: true,
  nodes: [],
  connections: {},
  versionId: 'v1',
};

const DEPLOYMENT_A = '20240101T100000Z-aaaaaaaa';
const DEPLOYMENT_B = '20240102T100000Z-bbbbbbbb';
const DEPLOYMENT_C = '20240103T100000Z-cccccccc';

const BASE_META = {
  deployment_id: DEPLOYMENT_A,
  env: 'dev',
  command: 'pull' as const,
  timestamp: '2024-01-01T10:00:00.000Z',
  workflow_count: 1,
  filters: { tag: null, pattern: null, onlyActive: false },
};

beforeEach(() => vol.reset());

describe('generateDeploymentId', () => {
  it('matches the expected format YYYYMMDDTHHmmssZ-<8hex>', () => {
    const id = generateDeploymentId();
    expect(id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  });

  it('generates unique IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateDeploymentId()));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('writeSnapshot', () => {
  it('creates the deployment directory and writes workflow JSON', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    const raw = vol.readFileSync(`/fd/snapshots/${DEPLOYMENT_A}/wf-abc123.json`, 'utf-8') as string;
    expect(JSON.parse(raw)).toMatchObject({ id: 'wf-abc123', name: 'My Workflow' });
  });

  it('writes multiple workflows into the same deployment directory', () => {
    vol.fromJSON({ '/fd/': null });
    const wf2: SnapshotWorkflow = { id: 'wf-xyz', name: 'Another' };
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshot('/fd', DEPLOYMENT_A, wf2);
    expect(vol.existsSync(`/fd/snapshots/${DEPLOYMENT_A}/wf-abc123.json`)).toBe(true);
    expect(vol.existsSync(`/fd/snapshots/${DEPLOYMENT_A}/wf-xyz.json`)).toBe(true);
  });

  it('throws UserError when directory cannot be created', () => {
    vol.fromJSON({ '/fd/snapshots': 'I am a file, not a dir' });
    expect(() => writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW)).toThrow(UserError);
  });
});

describe('readSnapshot', () => {
  it('reads back the workflow written by writeSnapshot', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    const result = readSnapshot('/fd', DEPLOYMENT_A, 'wf-abc123');
    expect(result.id).toBe('wf-abc123');
    expect(result.name).toBe('My Workflow');
  });

  it('preserves extra fields on the workflow object', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    const result = readSnapshot('/fd', DEPLOYMENT_A, 'wf-abc123');
    expect(result).toMatchObject({ active: true, nodes: [], connections: {} });
  });

  it('throws UserError when snapshot file does not exist', () => {
    vol.fromJSON({ '/fd/': null });
    expect(() => readSnapshot('/fd', DEPLOYMENT_A, 'wf-missing')).toThrow(UserError);
    expect(() => readSnapshot('/fd', DEPLOYMENT_A, 'wf-missing')).toThrow('No snapshot found');
  });

  it('throws UserError when snapshot file contains invalid JSON', () => {
    vol.fromJSON({ [`/fd/snapshots/${DEPLOYMENT_A}/wf-bad.json`]: 'not { json' });
    expect(() => readSnapshot('/fd', DEPLOYMENT_A, 'wf-bad')).toThrow(UserError);
    expect(() => readSnapshot('/fd', DEPLOYMENT_A, 'wf-bad')).toThrow('corrupted');
  });

  it('throws UserError when snapshot is missing required fields', () => {
    vol.fromJSON({ [`/fd/snapshots/${DEPLOYMENT_A}/wf-bad.json`]: JSON.stringify({ foo: 'bar' }) });
    expect(() => readSnapshot('/fd', DEPLOYMENT_A, 'wf-bad')).toThrow(UserError);
    expect(() => readSnapshot('/fd', DEPLOYMENT_A, 'wf-bad')).toThrow('invalid structure');
  });
});

describe('listDeployments', () => {
  it('returns empty array when snapshots directory does not exist', () => {
    vol.fromJSON({ '/fd/': null });
    expect(listDeployments('/fd')).toEqual([]);
  });

  it('returns deployments sorted newest first', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshot('/fd', DEPLOYMENT_B, WORKFLOW);
    writeSnapshot('/fd', DEPLOYMENT_C, WORKFLOW);
    expect(listDeployments('/fd')).toEqual([DEPLOYMENT_C, DEPLOYMENT_B, DEPLOYMENT_A]);
  });

  it('ignores entries that do not match the deployment ID format', () => {
    vol.fromJSON({
      [`/fd/snapshots/${DEPLOYMENT_A}/wf.json`]: '{}',
      '/fd/snapshots/.DS_Store': '',
      '/fd/snapshots/random-folder/wf.json': '{}',
    });
    expect(listDeployments('/fd')).toEqual([DEPLOYMENT_A]);
  });
});

describe('listSnapshotWorkflows', () => {
  it('returns workflow IDs in a deployment', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshot('/fd', DEPLOYMENT_A, { id: 'wf-xyz', name: 'Other' });
    const ids = listSnapshotWorkflows('/fd', DEPLOYMENT_A);
    expect(ids.sort()).toEqual(['wf-abc123', 'wf-xyz']);
  });

  it('excludes meta.json from the returned list', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshotMeta('/fd', DEPLOYMENT_A, BASE_META);
    const ids = listSnapshotWorkflows('/fd', DEPLOYMENT_A);
    expect(ids).not.toContain('meta');
    expect(ids).toContain('wf-abc123');
  });

  it('throws UserError when deployment does not exist', () => {
    vol.fromJSON({ '/fd/': null });
    expect(() => listSnapshotWorkflows('/fd', DEPLOYMENT_A)).toThrow(UserError);
    expect(() => listSnapshotWorkflows('/fd', DEPLOYMENT_A)).toThrow('No deployment found');
  });
});

describe('pruneSnapshots', () => {
  it('removes oldest deployments beyond the keep count', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshot('/fd', DEPLOYMENT_B, WORKFLOW);
    writeSnapshot('/fd', DEPLOYMENT_C, WORKFLOW);
    const removed = pruneSnapshots('/fd', 2);
    expect(removed).toBe(1);
    expect(listDeployments('/fd')).toEqual([DEPLOYMENT_C, DEPLOYMENT_B]);
  });

  it('removes nothing when keep >= total deployments', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    expect(pruneSnapshots('/fd', 10)).toBe(0);
    expect(listDeployments('/fd')).toHaveLength(1);
  });

  it('removes all deployments when keep is 0', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshot('/fd', DEPLOYMENT_B, WORKFLOW);
    expect(pruneSnapshots('/fd', 0)).toBe(2);
    expect(listDeployments('/fd')).toHaveLength(0);
  });
});

describe('writeSnapshotMeta / readSnapshotMeta', () => {
  it('round-trips meta.json correctly', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshotMeta('/fd', DEPLOYMENT_A, BASE_META);
    const result = readSnapshotMeta('/fd', DEPLOYMENT_A);
    expect(result).toEqual(BASE_META);
  });

  it('returns null when meta.json does not exist', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    expect(readSnapshotMeta('/fd', DEPLOYMENT_A)).toBeNull();
  });

  it('returns null when meta.json contains invalid JSON', () => {
    vol.fromJSON({ [`/fd/snapshots/${DEPLOYMENT_A}/meta.json`]: 'not json' });
    expect(readSnapshotMeta('/fd', DEPLOYMENT_A)).toBeNull();
  });

  it('returns null when meta.json has wrong shape', () => {
    vol.fromJSON({
      [`/fd/snapshots/${DEPLOYMENT_A}/meta.json`]: JSON.stringify({ garbage: true }),
    });
    expect(readSnapshotMeta('/fd', DEPLOYMENT_A)).toBeNull();
  });
});

describe('findLatestDeploymentForEnv', () => {
  it('returns the most recent deployment for the given env', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshotMeta('/fd', DEPLOYMENT_A, { ...BASE_META, deployment_id: DEPLOYMENT_A, env: 'dev' });
    writeSnapshot('/fd', DEPLOYMENT_B, WORKFLOW);
    writeSnapshotMeta('/fd', DEPLOYMENT_B, { ...BASE_META, deployment_id: DEPLOYMENT_B, env: 'dev' });
    // B is newer (sorted newest-first), so it should be returned
    expect(findLatestDeploymentForEnv('/fd', 'dev')).toBe(DEPLOYMENT_B);
  });

  it('returns undefined when no deployment exists for the env', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshotMeta('/fd', DEPLOYMENT_A, { ...BASE_META, env: 'prod' });
    expect(findLatestDeploymentForEnv('/fd', 'dev')).toBeUndefined();
  });

  it('skips deployments with no meta.json', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW); // no meta
    writeSnapshot('/fd', DEPLOYMENT_B, WORKFLOW);
    writeSnapshotMeta('/fd', DEPLOYMENT_B, { ...BASE_META, deployment_id: DEPLOYMENT_B, env: 'dev' });
    expect(findLatestDeploymentForEnv('/fd', 'dev')).toBe(DEPLOYMENT_B);
  });

  it('ignores deployments for other envs', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshotMeta('/fd', DEPLOYMENT_A, { ...BASE_META, env: 'prod' });
    expect(findLatestDeploymentForEnv('/fd', 'dev')).toBeUndefined();
  });
});

describe('readAllWorkflowsInDeployment', () => {
  it('reads all workflow files from a deployment', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshot('/fd', DEPLOYMENT_A, { id: 'wf-2', name: 'Second' });
    const workflows = readAllWorkflowsInDeployment('/fd', DEPLOYMENT_A);
    expect(workflows).toHaveLength(2);
    expect(workflows.map((w) => w.id).sort()).toEqual(['wf-2', 'wf-abc123']);
  });

  it('excludes meta.json from results', () => {
    vol.fromJSON({ '/fd/': null });
    writeSnapshot('/fd', DEPLOYMENT_A, WORKFLOW);
    writeSnapshotMeta('/fd', DEPLOYMENT_A, BASE_META);
    const workflows = readAllWorkflowsInDeployment('/fd', DEPLOYMENT_A);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].id).toBe('wf-abc123');
  });

  it('returns empty array when deployment directory does not exist', () => {
    vol.fromJSON({ '/fd/': null });
    expect(readAllWorkflowsInDeployment('/fd', DEPLOYMENT_A)).toEqual([]);
  });

  it('skips corrupted workflow files silently', () => {
    vol.fromJSON({
      [`/fd/snapshots/${DEPLOYMENT_A}/wf-good.json`]: JSON.stringify({ id: 'wf-good', name: 'Good' }),
      [`/fd/snapshots/${DEPLOYMENT_A}/wf-bad.json`]: 'not json',
    });
    const workflows = readAllWorkflowsInDeployment('/fd', DEPLOYMENT_A);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].id).toBe('wf-good');
  });
});
