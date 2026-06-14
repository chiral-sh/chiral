import { describe, it, expect } from 'vitest';
import { diffWorkflowNodes } from '../../../src/lib/workflow-diff.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'node-1',
    name: 'HTTP Request',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 1,
    position: [100, 200],
    parameters: { url: 'https://api.example.com', method: 'GET' },
    ...overrides,
  };
}

function wf(
  nodes: Record<string, unknown>[],
  connections: Record<string, unknown> = {},
): Record<string, unknown> {
  return { nodes, connections };
}

// ── diffWorkflowNodes ─────────────────────────────────────────────────────────

describe('diffWorkflowNodes', () => {
  it('returns all-empty for two identical single-node workflows', () => {
    const workflow = wf([makeNode()]);
    const result = diffWorkflowNodes(workflow, workflow);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.connections).toEqual({ added: 0, removed: 0 });
  });

  it('classifies a pure node add correctly', () => {
    const existing = makeNode({ id: 'n1', name: 'Set', type: 'n8n-nodes-base.set' });
    const newNode = makeNode({ id: 'n2', name: 'Postgres', type: 'n8n-nodes-base.postgres' });
    const result = diffWorkflowNodes(wf([existing]), wf([existing, newNode]));
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ name: 'Postgres', type: 'n8n-nodes-base.postgres' });
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
  });

  it('classifies a pure node remove correctly', () => {
    const kept = makeNode({ id: 'n1', name: 'Set', type: 'n8n-nodes-base.set' });
    const gone = makeNode({ id: 'n2', name: 'Postgres', type: 'n8n-nodes-base.postgres' });
    const result = diffWorkflowNodes(wf([kept, gone]), wf([kept]));
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatchObject({ name: 'Postgres', type: 'n8n-nodes-base.postgres' });
    expect(result.added).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
  });

  it('classifies a parameter-only modify correctly', () => {
    const nodeOld = makeNode({ id: 'n1', parameters: { url: 'https://old.example.com' } });
    const nodeNew = makeNode({ id: 'n1', parameters: { url: 'https://new.example.com' } });
    const result = diffWorkflowNodes(wf([nodeOld]), wf([nodeNew]));
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0]!.changed).toEqual(['parameters']);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('detects a rename as a single modified entry with previousName and changed:["name"]', () => {
    const nodeOld = makeNode({ id: 'n1', name: 'Fetch Orders', type: 'n8n-nodes-base.httpRequest' });
    const nodeNew = makeNode({ id: 'n1', name: 'Fetch Open Orders', type: 'n8n-nodes-base.httpRequest' });
    const result = diffWorkflowNodes(wf([nodeOld]), wf([nodeNew]));
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0]!.changed).toContain('name');
    expect(result.modified[0]!.previousName).toBe('Fetch Orders');
    expect(result.modified[0]!.name).toBe('Fetch Open Orders');
  });

  it('does not set previousName when the name is unchanged on a modified node', () => {
    const nodeOld = makeNode({ id: 'n1', parameters: { url: 'old' } });
    const nodeNew = makeNode({ id: 'n1', parameters: { url: 'new' } });
    const result = diffWorkflowNodes(wf([nodeOld]), wf([nodeNew]));
    expect(result.modified[0]).not.toHaveProperty('previousName');
  });

  it('falls back to name matching when node id is missing', () => {
    const nodeOld = { name: 'Set', type: 'n8n-nodes-base.set', parameters: { val: 'old' }, position: [0, 0] };
    const nodeNew = { name: 'Set', type: 'n8n-nodes-base.set', parameters: { val: 'new' }, position: [0, 0] };
    const result = diffWorkflowNodes(wf([nodeOld]), wf([nodeNew]));
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0]!.changed).toContain('parameters');
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('returns all-empty without throwing for workflows with no nodes or connections keys', () => {
    const result = diffWorkflowNodes({}, {});
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.connections).toEqual({ added: 0, removed: 0 });
    expect(result.oldNodeCount).toBe(0);
    expect(result.newNodeCount).toBe(0);
  });

  it('counts connection additions and removals for a rewired edge', () => {
    const source = makeNode({ id: 'n1', name: 'Source', type: 'n8n-nodes-base.start' });
    const targetA = makeNode({ id: 'n2', name: 'Target A', type: 'n8n-nodes-base.set' });
    const targetB = makeNode({ id: 'n3', name: 'Target B', type: 'n8n-nodes-base.set' });
    const connA = { Source: { main: [[{ node: 'Target A', type: 'main', index: 0 }]] } };
    const connB = { Source: { main: [[{ node: 'Target B', type: 'main', index: 0 }]] } };
    const result = diffWorkflowNodes(
      { nodes: [source, targetA, targetB], connections: connA },
      { nodes: [source, targetA, targetB], connections: connB },
    );
    expect(result.connections.added).toBe(1);
    expect(result.connections.removed).toBe(1);
  });

  it('counts object is consistent with the added/removed/modified arrays', () => {
    const nodeA = makeNode({ id: 'n1', name: 'A', type: 'n8n-nodes-base.set' });
    const nodeB = makeNode({ id: 'n2', name: 'B', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'old' } });
    const nodeBNew = makeNode({ id: 'n2', name: 'B', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'new' } });
    const nodeC = makeNode({ id: 'n3', name: 'C', type: 'n8n-nodes-base.postgres' });
    const result = diffWorkflowNodes(wf([nodeA, nodeB, nodeC]), wf([nodeA, nodeBNew]));
    expect(result.counts.added).toBe(result.added.length);
    expect(result.counts.modified).toBe(result.modified.length);
    expect(result.counts.removed).toBe(result.removed.length);
    expect(result.removed[0]?.name).toBe('C');
    expect(result.modified[0]?.name).toBe('B');
  });

  it('reports correct oldNodeCount and newNodeCount', () => {
    const a = wf([makeNode({ id: 'n1' }), makeNode({ id: 'n2' })]);
    const b = wf([makeNode({ id: 'n1' })]);
    const result = diffWorkflowNodes(a, b);
    expect(result.oldNodeCount).toBe(2);
    expect(result.newNodeCount).toBe(1);
  });

  it('ignores position and typeVersion changes (normalizeNode strips them)', () => {
    const nodeOld = makeNode({ id: 'n1', position: [100, 200], typeVersion: 1 });
    const nodeNew = makeNode({ id: 'n1', position: [999, 999], typeVersion: 3 });
    const result = diffWorkflowNodes(wf([nodeOld]), wf([nodeNew]));
    expect(result.modified).toHaveLength(0);
  });

  it('treats same-name node with different type as remove + add, not modify (phase 2)', () => {
    const nodeOld = makeNode({ id: 'n1', name: 'Processor', type: 'n8n-nodes-base.httpRequest' });
    const nodeNew = { id: 'n2', name: 'Processor', type: 'n8n-nodes-base.code', parameters: {}, position: [0, 0] };
    const result = diffWorkflowNodes(wf([nodeOld]), wf([nodeNew]));
    expect(result.modified).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatchObject({ name: 'Processor', type: 'n8n-nodes-base.httpRequest' });
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ name: 'Processor', type: 'n8n-nodes-base.code' });
  });

  it('marks orphaned replaced node correctly when the original had no connections', () => {
    const nodeOld = makeNode({ id: 'n1', name: 'Processor', type: 'n8n-nodes-base.httpRequest' });
    const nodeNew = { id: 'n2', name: 'Processor', type: 'n8n-nodes-base.code', parameters: {}, position: [0, 0] };
    const result = diffWorkflowNodes(wf([nodeOld]), wf([nodeNew]));
    expect(result.removed[0]?.orphaned).toBe(true);
  });

  it('does not mark replaced node as orphaned when the original had connections', () => {
    const nodeOld = makeNode({ id: 'n1', name: 'Processor', type: 'n8n-nodes-base.httpRequest' });
    const nodeNew = { id: 'n2', name: 'Processor', type: 'n8n-nodes-base.code', parameters: {}, position: [0, 0] };
    const connections = { Processor: { main: [[{ node: 'Target', type: 'main', index: 0 }]] } };
    const result = diffWorkflowNodes(wf([nodeOld], connections), wf([nodeNew]));
    expect(result.removed[0]?.orphaned).not.toBe(true);
  });

  it('marks a purely removed node as orphaned when it had no connections', () => {
    const kept = makeNode({ id: 'n1', name: 'Source', type: 'n8n-nodes-base.start' });
    const orphaned = makeNode({ id: 'n2', name: 'Orphan', type: 'n8n-nodes-base.set' });
    const connections = { Source: { main: [[{ node: 'DownstreamNode', type: 'main', index: 0 }]] } };
    const result = diffWorkflowNodes(wf([kept, orphaned], connections), wf([kept], connections));
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatchObject({ name: 'Orphan', orphaned: true });
  });

  it('does not mark a removed node as orphaned when it had connections', () => {
    const source = makeNode({ id: 'n1', name: 'Source', type: 'n8n-nodes-base.start' });
    const target = makeNode({ id: 'n2', name: 'Target', type: 'n8n-nodes-base.set' });
    const connections = { Source: { main: [[{ node: 'Target', type: 'main', index: 0 }]] } };
    const result = diffWorkflowNodes(wf([source, target], connections), wf([source], connections));
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]!.orphaned).not.toBe(true);
  });

  it('ignores credential id and name changes (env-specific, not workflow logic)', () => {
    const nodeOld = makeNode({
      id: 'n1',
      credentials: { httpBasicAuth: { id: 'cred-old', name: 'dev_key' } },
    });
    const nodeSameCredName = makeNode({
      id: 'n1',
      credentials: { httpBasicAuth: { id: 'cred-new', name: 'dev_key' } },
    });
    const nodeDiffCredName = makeNode({
      id: 'n1',
      credentials: { httpBasicAuth: { id: 'cred-old', name: 'prod_key' } },
    });
    expect(diffWorkflowNodes(wf([nodeOld]), wf([nodeSameCredName])).modified).toHaveLength(0);
    expect(diffWorkflowNodes(wf([nodeOld]), wf([nodeDiffCredName])).modified).toHaveLength(0);
  });
});
