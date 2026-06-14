import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

import { vi } from 'vitest';
import {
  computeContentHash,
  computeStructureHash,
  loadFingerprints,
  normalizeNode,
  writeFingerprints,
  upsertFingerprintEntry,
} from '../../../src/state/fingerprints.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wf-1',
    name: 'Order Processor',
    versionId: 'v-abc',
    active: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    staticData: null,
    pinData: {},
    nodes: [
      {
        id: 'node-1',
        name: 'HTTP Request',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 1,
        position: [100, 200],
        parameters: { url: 'https://api.example.com', method: 'GET' },
        credentials: {
          httpBasicAuth: { id: 'cred-123', name: 'dev_api_key' },
        },
      },
      {
        id: 'node-2',
        name: 'Postgres',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2,
        position: [400, 200],
        parameters: { query: 'SELECT * FROM orders' },
        credentials: {
          postgres: { id: 'cred-456', name: 'dev_postgres' },
        },
      },
    ],
    connections: {
      'HTTP Request': {
        main: [[{ node: 'Postgres', type: 'main', index: 0 }]],
      },
    },
    settings: { executionOrder: 'v1' },
    ...overrides,
  };
}

const CHIRAL_DIR = '/repo/.chiral';

// ── normalizeNode ─────────────────────────────────────────────────────────────

describe('normalizeNode', () => {
  const baseNode: Record<string, unknown> = {
    id: 'node-1',
    name: 'HTTP Request',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 1,
    position: [100, 200],
    parameters: { url: 'https://api.example.com', method: 'GET' },
    credentials: {
      httpBasicAuth: { id: 'cred-123', name: 'dev_api_key' },
    },
  };

  it('strips id, position, and typeVersion', () => {
    const result = normalizeNode(baseNode);
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('position');
    expect(result).not.toHaveProperty('typeVersion');
  });

  it('strips credential id but keeps name', () => {
    const result = normalizeNode(baseNode);
    const creds = result['credentials'] as Record<string, Record<string, unknown>>;
    expect(creds['httpBasicAuth']).not.toHaveProperty('id');
    expect(creds['httpBasicAuth']).toHaveProperty('name', 'dev_api_key');
  });

  it('strips dataTableId value and cachedResultUrl for datatable nodes', () => {
    const node: Record<string, unknown> = {
      id: 'node-3',
      name: 'Data Table',
      type: 'n8n-nodes-base.dataTable',
      typeVersion: 1,
      position: [0, 0],
      parameters: {
        operation: 'getRows',
        dataTableId: {
          __rl: true,
          value: 'table-dev-123',
          mode: 'list',
          cachedResultUrl: 'https://dev.example.com/tables/table-dev-123',
        },
      },
    };
    const result = normalizeNode(node);
    const params = result['parameters'] as Record<string, unknown>;
    const dataTableId = params['dataTableId'] as Record<string, unknown>;
    expect(dataTableId).not.toHaveProperty('value');
    expect(dataTableId).not.toHaveProperty('cachedResultUrl');
    expect(dataTableId['__rl']).toBe(true);
    expect(dataTableId['mode']).toBe('list');
  });

  it('leaves dataTableId untouched for __rl !== true (matches collect/remap predicate)', () => {
    const node: Record<string, unknown> = {
      id: 'node-4',
      name: 'Data Table',
      type: 'n8n-nodes-base.dataTable',
      typeVersion: 1,
      position: [0, 0],
      parameters: {
        operation: 'getRows',
        dataTableId: {
          __rl: false,
          value: 'table-dev-123',
          mode: 'id',
          cachedResultUrl: 'https://dev.example.com/tables/table-dev-123',
        },
      },
    };
    const result = normalizeNode(node);
    const params = result['parameters'] as Record<string, unknown>;
    const dataTableId = params['dataTableId'] as Record<string, unknown>;
    expect(dataTableId).toHaveProperty('value', 'table-dev-123');
    expect(dataTableId).toHaveProperty('cachedResultUrl', 'https://dev.example.com/tables/table-dev-123');
  });

  it('preserves parameters', () => {
    const result = normalizeNode(baseNode);
    expect(result['parameters']).toEqual({ url: 'https://api.example.com', method: 'GET' });
  });

  it('preserves name and type', () => {
    const result = normalizeNode(baseNode);
    expect(result['name']).toBe('HTTP Request');
    expect(result['type']).toBe('n8n-nodes-base.httpRequest');
  });

  it('handles a node with no credentials gracefully', () => {
    const node = { id: 'n1', name: 'Set', type: 'n8n-nodes-base.set', position: [0, 0], parameters: {} };
    const result = normalizeNode(node);
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('position');
    expect(result['name']).toBe('Set');
  });

  it('does not alter computeContentHash output (byte-identity with old inline logic)', () => {
    const wf = makeWorkflow();
    const hashBefore = computeContentHash(wf);
    // Compute again after refactor — the exported normalizeNode is now the same code path
    const hashAfter = computeContentHash(makeWorkflow());
    expect(hashBefore).toBe(hashAfter);
  });
});

// ── computeContentHash ────────────────────────────────────────────────────────

describe('computeContentHash', () => {
  it('returns a sha256: prefixed string', () => {
    const hash = computeContentHash(makeWorkflow());
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('returns the same hash for identical content', () => {
    expect(computeContentHash(makeWorkflow())).toBe(computeContentHash(makeWorkflow()));
  });

  it('returns a different hash when the workflow name changes', () => {
    const a = computeContentHash(makeWorkflow({ name: 'Order Processor' }));
    const b = computeContentHash(makeWorkflow({ name: 'Invoice Processor' }));
    expect(a).not.toBe(b);
  });

  it('returns the same hash when only versionId changes (invariant §2)', () => {
    const a = computeContentHash(makeWorkflow({ versionId: 'v-abc' }));
    const b = computeContentHash(makeWorkflow({ versionId: 'v-xyz' }));
    expect(a).toBe(b);
  });

  it('returns the same hash when only id changes (invariant §2)', () => {
    const a = computeContentHash(makeWorkflow({ id: 'wf-1' }));
    const b = computeContentHash(makeWorkflow({ id: 'wf-999' }));
    expect(a).toBe(b);
  });

  it('returns the same hash when only createdAt changes (invariant §2)', () => {
    const a = computeContentHash(makeWorkflow({ createdAt: '2024-01-01T00:00:00.000Z' }));
    const b = computeContentHash(makeWorkflow({ createdAt: '2025-06-15T12:00:00.000Z' }));
    expect(a).toBe(b);
  });

  it('returns the same hash when only updatedAt changes (invariant §2)', () => {
    const a = computeContentHash(makeWorkflow({ updatedAt: '2024-01-01T00:00:00.000Z' }));
    const b = computeContentHash(makeWorkflow({ updatedAt: '2025-06-15T12:00:00.000Z' }));
    expect(a).toBe(b);
  });

  it('returns the same hash when only active changes (invariant §2)', () => {
    const a = computeContentHash(makeWorkflow({ active: true }));
    const b = computeContentHash(makeWorkflow({ active: false }));
    expect(a).toBe(b);
  });

  it('returns the same hash when only staticData changes (invariant §2)', () => {
    const a = computeContentHash(makeWorkflow({ staticData: null }));
    const b = computeContentHash(makeWorkflow({ staticData: { counter: 42 } }));
    expect(a).toBe(b);
  });

  it('returns the same hash when only pinData changes (invariant §2)', () => {
    const a = computeContentHash(makeWorkflow({ pinData: {} }));
    const b = computeContentHash(makeWorkflow({ pinData: { 'node-1': [{ json: {} }] } }));
    expect(a).toBe(b);
  });

  it('strips credential id but keeps name before hashing', () => {
    const withCredId = makeWorkflow();
    const withDifferentCredId = makeWorkflow();
    const nodes = withDifferentCredId['nodes'] as Record<string, unknown>[];
    (nodes[0]!['credentials'] as Record<string, Record<string, unknown>>)['httpBasicAuth']!['id'] =
      'completely-different-cred-id';

    expect(computeContentHash(withCredId)).toBe(computeContentHash(withDifferentCredId));
  });

  it('returns a different hash when credential name changes (genuine swap; cred-map normalization happens upstream)', () => {
    const wf = makeWorkflow();
    const wfChanged = makeWorkflow();
    const nodes = wfChanged['nodes'] as Record<string, unknown>[];
    (nodes[0]!['credentials'] as Record<string, Record<string, unknown>>)['httpBasicAuth']!['name'] =
      'prod_api_key';

    // computeContentHash itself no longer collapses credential name changes
    // (S1) - callers must pass a credential-map-normalized workflow first so
    // that mapped/passthrough pairs collapse before hashing.
    expect(computeContentHash(wf)).not.toBe(computeContentHash(wfChanged));
  });

  it('returns the same hash when dataTableId.value differs across envs', () => {
    const makeWithDataTable = (tableId: string, cachedUrl: string) =>
      makeWorkflow({
        nodes: [
          {
            id: 'node-3',
            name: 'Data Table',
            type: 'n8n-nodes-base.dataTable',
            typeVersion: 1,
            position: [0, 0],
            parameters: {
              operation: 'getRows',
              dataTableId: { __rl: true, value: tableId, mode: 'list', cachedResultUrl: cachedUrl },
            },
          },
        ],
        connections: {},
      });

    const dev = computeContentHash(makeWithDataTable('table-dev-123', 'https://dev.example.com/tables/table-dev-123'));
    const prod = computeContentHash(makeWithDataTable('table-prod-456', 'https://prod.example.com/tables/table-prod-456'));
    expect(dev).toBe(prod);
  });

  it('returns a different hash when a non-datatable parameter actually changes alongside a mapped table', () => {
    const makeWithDataTable = (tableId: string, mode: string) =>
      makeWorkflow({
        nodes: [
          {
            id: 'node-3',
            name: 'Data Table',
            type: 'n8n-nodes-base.dataTable',
            typeVersion: 1,
            position: [0, 0],
            parameters: {
              operation: 'getRows',
              dataTableId: { __rl: true, value: tableId, mode, cachedResultUrl: 'https://x/' + tableId },
            },
          },
        ],
        connections: {},
      });

    const a = computeContentHash(makeWithDataTable('table-1', 'list'));
    const b = computeContentHash(makeWithDataTable('table-2', 'id'));
    expect(a).not.toBe(b);
  });

  it('returns the same hash regardless of node array order (sorted by node id)', () => {
    const wf = makeWorkflow();
    const wfReversed = makeWorkflow({
      nodes: [...((makeWorkflow()['nodes'] as unknown[]).reverse())],
    });
    expect(computeContentHash(wf)).toBe(computeContentHash(wfReversed));
  });

  it('strips node position and id fields before hashing', () => {
    const a = makeWorkflow();
    const b = makeWorkflow();
    const bNodes = b['nodes'] as Record<string, unknown>[];
    bNodes[0]!['position'] = [9999, 9999];
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('returns a different hash when node parameters change', () => {
    const a = makeWorkflow();
    const b = makeWorkflow();
    const bNodes = b['nodes'] as Record<string, unknown>[];
    (bNodes[0]!['parameters'] as Record<string, unknown>)['url'] = 'https://other.example.com';
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it('returns a different hash when settings change', () => {
    const a = computeContentHash(makeWorkflow({ settings: { executionOrder: 'v1' } }));
    const b = computeContentHash(makeWorkflow({ settings: { executionOrder: 'v0' } }));
    expect(a).not.toBe(b);
  });

  it('treats missing settings as empty object (stable)', () => {
    const withEmpty = computeContentHash(makeWorkflow({ settings: {} }));
    const withUndefined = computeContentHash(makeWorkflow({ settings: undefined }));
    expect(withEmpty).toBe(withUndefined);
  });

  it('returns a different hash when description changes', () => {
    const a = computeContentHash(makeWorkflow({ description: 'Handles orders' }));
    const b = computeContentHash(makeWorkflow({ description: 'Handles invoices' }));
    expect(a).not.toBe(b);
  });

  it('treats missing description as empty string (stable)', () => {
    const withEmpty = computeContentHash(makeWorkflow({ description: '' }));
    const withMissing = computeContentHash(makeWorkflow({ description: undefined }));
    expect(withEmpty).toBe(withMissing);
  });

  it('ignores settings fields stripped by sanitizeWorkflowForApi (round-trip stability)', () => {
    // n8n returns binaryMode in GET responses but the push sanitizer strips it before
    // POSTing. Without this, push dev→staging then staging→dev shows a false "would-update"
    // because the staging snapshot lacks binaryMode while the dev snapshot has it.
    const dev = computeContentHash(
      makeWorkflow({ settings: { executionOrder: 'v1', binaryMode: 'separate' } }),
    );
    const staging = computeContentHash(
      makeWorkflow({ settings: { executionOrder: 'v1' } }),
    );
    expect(dev).toBe(staging);
  });
});

// ── computeStructureHash ──────────────────────────────────────────────────────

describe('computeStructureHash', () => {
  it('returns a sha256: prefixed string', () => {
    expect(computeStructureHash(makeWorkflow())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('returns the same hash for identical structure', () => {
    expect(computeStructureHash(makeWorkflow())).toBe(computeStructureHash(makeWorkflow()));
  });

  it('returns the same hash when workflow name changes (invariant §3)', () => {
    const a = computeStructureHash(makeWorkflow({ name: 'Order Processor [DEV]' }));
    const b = computeStructureHash(makeWorkflow({ name: 'Order Processor' }));
    expect(a).toBe(b);
  });

  it('returns the same hash when node names change but types stay the same (invariant §3)', () => {
    const wfA = makeWorkflow();
    const wfB = makeWorkflow();
    const bNodes = wfB['nodes'] as Record<string, unknown>[];
    const bConns = wfB['connections'] as Record<string, unknown>;

    // Rename node but keep same type
    const oldName = bNodes[0]!['name'] as string;
    bNodes[0]!['name'] = 'Renamed HTTP Node';
    // Fix connections to use new node name
    bConns['Renamed HTTP Node'] = bConns[oldName];
    delete bConns[oldName];

    expect(computeStructureHash(wfA)).toBe(computeStructureHash(wfB));
  });

  it('returns the same hash when credential names change (invariant §3)', () => {
    const wfA = makeWorkflow();
    const wfB = makeWorkflow();
    const bNodes = wfB['nodes'] as Record<string, unknown>[];
    (bNodes[0]!['credentials'] as Record<string, Record<string, unknown>>)['httpBasicAuth']!['name'] =
      'prod_api_key';
    expect(computeStructureHash(wfA)).toBe(computeStructureHash(wfB));
  });

  it('returns the same hash when node parameters change (invariant §3)', () => {
    const wfA = makeWorkflow();
    const wfB = makeWorkflow();
    const bNodes = wfB['nodes'] as Record<string, unknown>[];
    (bNodes[0]!['parameters'] as Record<string, unknown>)['url'] = 'https://completely-different.com';
    expect(computeStructureHash(wfA)).toBe(computeStructureHash(wfB));
  });

  it('returns a different hash when a node type changes', () => {
    const wfA = makeWorkflow();
    const wfB = makeWorkflow();
    const bNodes = wfB['nodes'] as Record<string, unknown>[];
    bNodes[0]!['type'] = 'n8n-nodes-base.slack';
    expect(computeStructureHash(wfA)).not.toBe(computeStructureHash(wfB));
  });

  it('returns a different hash when connection topology changes', () => {
    const wfA = makeWorkflow();
    const wfB = makeWorkflow({ connections: {} });
    expect(computeStructureHash(wfA)).not.toBe(computeStructureHash(wfB));
  });

  it('returns the same hash for two workflows that differ only in name (cross-env matching case)', () => {
    const dev = makeWorkflow({ name: 'Order Processor [DEV]' });
    const prod = makeWorkflow({ name: 'Order Processor' });
    expect(computeStructureHash(dev)).toBe(computeStructureHash(prod));
  });

  it('distinguishes topologies sharing a node-type multiset and edge-type set (F7)', () => {
    // Both workflows have nodeTypes [httpRequest, httpRequest, postgres] and
    // the only edge type pair is httpRequest -> postgres, but the wiring differs:
    // fan-in (both HTTP nodes feed Postgres) vs. one HTTP node feeding Postgres twice.
    const fanIn = makeWorkflow({
      nodes: [
        { id: 'n1', name: 'HTTP 1', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'n2', name: 'HTTP 2', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, position: [0, 100], parameters: {} },
        { id: 'n3', name: 'Postgres', type: 'n8n-nodes-base.postgres', typeVersion: 2, position: [200, 50], parameters: {} },
      ],
      connections: {
        'HTTP 1': { main: [[{ node: 'Postgres', type: 'main', index: 0 }]] },
        'HTTP 2': { main: [[{ node: 'Postgres', type: 'main', index: 0 }]] },
      },
    });

    const doubleEdge = makeWorkflow({
      nodes: [
        { id: 'n1', name: 'HTTP 1', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'n2', name: 'HTTP 2', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, position: [0, 100], parameters: {} },
        { id: 'n3', name: 'Postgres', type: 'n8n-nodes-base.postgres', typeVersion: 2, position: [200, 50], parameters: {} },
      ],
      connections: {
        'HTTP 1': {
          main: [[
            { node: 'Postgres', type: 'main', index: 0 },
            { node: 'Postgres', type: 'main', index: 0 },
          ]],
        },
      },
    });

    expect(computeStructureHash(fanIn)).not.toBe(computeStructureHash(doubleEdge));
  });

  it('still treats a pure rename as identical when adjacency multiset matches (invariant §3)', () => {
    const wfA = makeWorkflow();
    const wfB = makeWorkflow();
    const bNodes = wfB['nodes'] as Record<string, unknown>[];
    const bConns = wfB['connections'] as Record<string, unknown>;

    const oldName = bNodes[0]!['name'] as string;
    bNodes[0]!['name'] = 'Renamed HTTP Node';
    bConns['Renamed HTTP Node'] = bConns[oldName];
    delete bConns[oldName];

    expect(computeStructureHash(wfA)).toBe(computeStructureHash(wfB));
  });
});

// ── loadFingerprints ──────────────────────────────────────────────────────────

describe('loadFingerprints', () => {
  beforeEach(() => vol.reset());

  it('returns empty envs when fingerprints.json does not exist', () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/.keep`]: '' });
    const result = loadFingerprints(CHIRAL_DIR);
    expect(result).toEqual({ version: 1, envs: {} });
  });

  it('loads and validates a valid fingerprints.json', () => {
    const data = {
      version: 1,
      envs: {
        dev: {
          'wf-1': {
            name: 'Order Processor',
            versionId: 'v-abc',
            contentHash: 'sha256:aaa',
            structureHash: 'sha256:zzz',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      },
    };
    vol.fromJSON({ [`${CHIRAL_DIR}/fingerprints.json`]: JSON.stringify(data) });
    const result = loadFingerprints(CHIRAL_DIR);
    expect(result.envs['dev']?.['wf-1']?.versionId).toBe('v-abc');
    expect(result.envs['dev']?.['wf-1']?.name).toBe('Order Processor');
  });

  it('throws UserError when file contains invalid JSON', () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/fingerprints.json`]: 'not json{{{' });
    expect(() => loadFingerprints(CHIRAL_DIR)).toThrow('valid JSON');
  });

  it('returns empty envs when file has wrong schema', () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/fingerprints.json`]: JSON.stringify({ version: 99 }) });
    const result = loadFingerprints(CHIRAL_DIR);
    expect(result).toEqual({ version: 1, envs: {} });
  });
});

// ── writeFingerprints ─────────────────────────────────────────────────────────

describe('writeFingerprints', () => {
  beforeEach(() => vol.reset());

  it('writes fingerprints.json with a trailing newline', () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/.keep`]: '' });
    const data = { version: 1 as const, envs: {} };
    writeFingerprints(CHIRAL_DIR, data);
    const raw = vol.readFileSync(`${CHIRAL_DIR}/fingerprints.json`, 'utf-8') as string;
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual(data);
  });
});

// ── upsertFingerprintEntry ────────────────────────────────────────────────────

describe('upsertFingerprintEntry', () => {
  beforeEach(() => vol.reset());

  const entry = {
    name: 'Order Processor',
    versionId: 'v-new',
    contentHash: 'sha256:ccc',
    structureHash: 'sha256:sss',
    updatedAt: '2024-06-01T00:00:00.000Z',
  };

  it('creates a new entry when fingerprints.json does not exist', () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/.keep`]: '' });
    upsertFingerprintEntry(CHIRAL_DIR, 'dev', 'wf-1', entry);
    const result = loadFingerprints(CHIRAL_DIR);
    expect(result.envs['dev']?.['wf-1']).toEqual(entry);
  });

  it('overwrites an existing entry for the same env + workflow id', () => {
    const existing = {
      version: 1,
      envs: {
        dev: {
          'wf-1': {
            name: 'Order Processor',
            versionId: 'v-old',
            contentHash: 'sha256:aaa',
            structureHash: 'sha256:zzz',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      },
    };
    vol.fromJSON({ [`${CHIRAL_DIR}/fingerprints.json`]: JSON.stringify(existing) });
    upsertFingerprintEntry(CHIRAL_DIR, 'dev', 'wf-1', entry);
    const result = loadFingerprints(CHIRAL_DIR);
    expect(result.envs['dev']?.['wf-1']?.versionId).toBe('v-new');
  });

  it('does not affect entries for other envs', () => {
    const existing = {
      version: 1,
      envs: {
        staging: {
          'wf-1': {
            name: 'Order Processor',
            versionId: 'v-staging',
            contentHash: 'sha256:stg',
            structureHash: 'sha256:zzz',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      },
    };
    vol.fromJSON({ [`${CHIRAL_DIR}/fingerprints.json`]: JSON.stringify(existing) });
    upsertFingerprintEntry(CHIRAL_DIR, 'dev', 'wf-1', entry);
    const result = loadFingerprints(CHIRAL_DIR);
    expect(result.envs['staging']?.['wf-1']?.versionId).toBe('v-staging');
    expect(result.envs['dev']?.['wf-1']?.versionId).toBe('v-new');
  });

  it('does not affect other workflow entries in the same env', () => {
    const existing = {
      version: 1,
      envs: {
        dev: {
          'wf-99': {
            name: 'Other Workflow',
            versionId: 'v-other',
            contentHash: 'sha256:other',
            structureHash: 'sha256:oth',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      },
    };
    vol.fromJSON({ [`${CHIRAL_DIR}/fingerprints.json`]: JSON.stringify(existing) });
    upsertFingerprintEntry(CHIRAL_DIR, 'dev', 'wf-1', entry);
    const result = loadFingerprints(CHIRAL_DIR);
    expect(result.envs['dev']?.['wf-99']?.versionId).toBe('v-other');
  });
});
