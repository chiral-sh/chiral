import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import {
  generateDeploymentId,
  writeSnapshot,
  readSnapshot,
  listDeployments,
  listSnapshotWorkflows,
  pruneSnapshots,
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
};

const DEPLOYMENT_A = '20240101T100000Z-aaaaaaaa';
const DEPLOYMENT_B = '20240102T100000Z-bbbbbbbb';
const DEPLOYMENT_C = '20240103T100000Z-cccccccc';

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
    vol.fromJSON({});
    // write to a path where parent is a file, not a directory
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
    vol.fromJSON({
      [`/fd/snapshots/${DEPLOYMENT_A}/wf-bad.json`]: 'not { json',
    });
    expect(() => readSnapshot('/fd', DEPLOYMENT_A, 'wf-bad')).toThrow(UserError);
    expect(() => readSnapshot('/fd', DEPLOYMENT_A, 'wf-bad')).toThrow('corrupted');
  });

  it('throws UserError when snapshot is missing required fields', () => {
    vol.fromJSON({
      [`/fd/snapshots/${DEPLOYMENT_A}/wf-bad.json`]: JSON.stringify({ foo: 'bar' }),
    });
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
      '/fd/snapshots/random-folder/': null,
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
