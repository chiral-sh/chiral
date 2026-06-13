import { describe, it, expect } from 'vitest';
import {
  normalizeWorkflowSnapshot,
  NORMALIZATION_VERSION,
  PIN_DATA_SIZE_LIMIT_BYTES,
} from '../../../src/lib/workflow-normalize.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wf-1',
    name: 'My Workflow',
    active: true,
    versionId: 'v-1',
    triggerCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    isArchived: false,
    meta: { instanceId: 'abc' },
    tags: [{ id: 't1', name: 'prod' }],
    nodes: [
      {
        id: 'node-1',
        name: 'Set',
        type: 'n8n-nodes-base.set',
        typeVersion: 1,
        position: [100, 200],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        parameters: {},
      },
    ],
    connections: {},
    settings: {
      saveExecutionProgress: true,
      timezone: 'UTC',
      foo: 'bar',
    },
    staticData: null,
    ...overrides,
  };
}

describe('normalizeWorkflowSnapshot', () => {
  it('exports NORMALIZATION_VERSION and PIN_DATA_SIZE_LIMIT_BYTES', () => {
    expect(NORMALIZATION_VERSION).toBe(1);
    expect(PIN_DATA_SIZE_LIMIT_BYTES).toBe(256 * 1024);
  });

  it('strips workflow-level read-only fields', () => {
    const { workflow } = normalizeWorkflowSnapshot(makeWorkflow(), { pinData: 'keep' });
    for (const field of [
      'id',
      'active',
      'versionId',
      'triggerCount',
      'createdAt',
      'updatedAt',
      'isArchived',
      'meta',
      'tags',
    ]) {
      expect(workflow).not.toHaveProperty(field);
    }
  });

  it('strips node-level createdAt/updatedAt while keeping id and position', () => {
    const { workflow } = normalizeWorkflowSnapshot(makeWorkflow(), { pinData: 'keep' });
    const nodes = workflow['nodes'] as Record<string, unknown>[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).not.toHaveProperty('createdAt');
    expect(nodes[0]).not.toHaveProperty('updatedAt');
    expect(nodes[0]['id']).toBe('node-1');
    expect(nodes[0]['position']).toEqual([100, 200]);
  });

  it('whitelists settings to the allowed keys and drops unknown keys', () => {
    const { workflow } = normalizeWorkflowSnapshot(makeWorkflow(), { pinData: 'keep' });
    expect(workflow['settings']).toEqual({
      saveExecutionProgress: true,
      timezone: 'UTC',
    });
  });

  it('recursively sorts object keys alphabetically', () => {
    const { workflow } = normalizeWorkflowSnapshot(makeWorkflow(), { pinData: 'keep' });
    const topKeys = Object.keys(workflow);
    expect(topKeys).toEqual([...topKeys].sort());

    const nodes = workflow['nodes'] as Record<string, unknown>[];
    const nodeKeys = Object.keys(nodes[0]);
    expect(nodeKeys).toEqual([...nodeKeys].sort());
  });

  it('keeps pinData under 256KB with pinData: keep', () => {
    const small = { node1: [{ json: { hello: 'world' } }] };
    const { workflow, pinDataStripped } = normalizeWorkflowSnapshot(
      makeWorkflow({ pinData: small }),
      { pinData: 'keep' },
    );
    expect(workflow['pinData']).toEqual(small);
    expect(pinDataStripped).toBe(false);
  });

  it('strips pinData over 256KB with pinData: keep', () => {
    const large = { node1: [{ json: { blob: 'x'.repeat(PIN_DATA_SIZE_LIMIT_BYTES + 1) } }] };
    const { workflow, pinDataStripped, pinDataSizeBytes } = normalizeWorkflowSnapshot(
      makeWorkflow({ pinData: large }),
      { pinData: 'keep' },
    );
    expect(workflow).not.toHaveProperty('pinData');
    expect(pinDataStripped).toBe(true);
    expect(pinDataSizeBytes).toBeGreaterThan(PIN_DATA_SIZE_LIMIT_BYTES);
  });

  it('strips pinData regardless of size with pinData: strip', () => {
    const small = { node1: [{ json: { hello: 'world' } }] };
    const { workflow, pinDataStripped } = normalizeWorkflowSnapshot(
      makeWorkflow({ pinData: small }),
      { pinData: 'strip' },
    );
    expect(workflow).not.toHaveProperty('pinData');
    expect(pinDataStripped).toBe(false);
  });

  it('retains oversized pinData with pinData: force-keep', () => {
    const large = { node1: [{ json: { blob: 'x'.repeat(PIN_DATA_SIZE_LIMIT_BYTES + 1) } }] };
    const { workflow, pinDataStripped } = normalizeWorkflowSnapshot(
      makeWorkflow({ pinData: large }),
      { pinData: 'force-keep' },
    );
    expect(workflow['pinData']).toEqual(large);
    expect(pinDataStripped).toBe(false);
  });

  it('is idempotent when run twice on its own output', () => {
    const once = normalizeWorkflowSnapshot(makeWorkflow(), { pinData: 'keep' });
    const twice = normalizeWorkflowSnapshot(once.workflow, { pinData: 'keep' });
    expect(twice.workflow).toEqual(once.workflow);
  });
});
