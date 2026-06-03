import { describe, it, expect } from 'vitest';
import { buildCredentialMap, applyCredentialMap, type Credentials } from '../../../src/state/credentials.js';

const CREDS: Credentials = {
  version: 1,
  credentials: {
    postgres: { dev: 'dev_postgres', staging: 'staging_postgres', prod: 'prod_postgres' },
    sendgrid: { dev: 'dev_sendgrid', prod: 'prod_sendgrid' },
  },
};

const EMPTY_CREDS: Credentials = { version: 1, credentials: {} };

function makeNode(credName: string, credType = 'postgres'): unknown {
  return {
    id: 'node-1',
    name: 'My Node',
    type: 'n8n-nodes-base.postgres',
    credentials: { [credType]: { id: 'cred-id', name: credName } },
  };
}

// ── buildCredentialMap ────────────────────────────────────────────────────────

describe('buildCredentialMap', () => {
  it('returns empty array when no nodes have credentials', () => {
    const nodes = [
      { id: 'n1', name: 'HTTP', type: 'n8n-nodes-base.http' }, // no credentials field
    ];
    expect(buildCredentialMap(nodes, 'dev', 'prod', CREDS)).toEqual([]);
  });

  it('returns empty array for empty nodes list', () => {
    expect(buildCredentialMap([], 'dev', 'prod', CREDS)).toEqual([]);
  });

  it('maps a credential with exact source→target entry', () => {
    const map = buildCredentialMap([makeNode('dev_postgres')], 'dev', 'prod', CREDS);
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({
      sourceName: 'dev_postgres',
      targetName: 'prod_postgres',
      logicalName: 'postgres',
      status: 'mapped',
    });
  });

  it('maps sendgrid credential correctly', () => {
    const map = buildCredentialMap([makeNode('dev_sendgrid', 'sendgridEmail')], 'dev', 'prod', CREDS);
    expect(map[0]).toMatchObject({
      sourceName: 'dev_sendgrid',
      targetName: 'prod_sendgrid',
      logicalName: 'sendgrid',
      status: 'mapped',
    });
  });

  it('marks passthrough when no mapping found', () => {
    const map = buildCredentialMap([makeNode('shared_slack', 'slack')], 'dev', 'prod', CREDS);
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({
      sourceName: 'shared_slack',
      targetName: 'shared_slack', // unchanged
      logicalName: null,
      status: 'passthrough',
    });
  });

  it('falls back to source name when mapped credential has no target entry', () => {
    // sendgrid has no 'staging' entry in CREDS
    const map = buildCredentialMap([makeNode('dev_sendgrid', 'sendgridEmail')], 'dev', 'staging', CREDS);
    expect(map[0]).toMatchObject({
      sourceName: 'dev_sendgrid',
      targetName: 'dev_sendgrid', // no staging entry → fallback to source
      logicalName: 'sendgrid',
      status: 'mapped',
    });
  });

  it('deduplicates credentials referenced in multiple nodes', () => {
    const nodes = [makeNode('dev_postgres'), makeNode('dev_postgres', 'postgresAlt')];
    const map = buildCredentialMap(nodes, 'dev', 'prod', CREDS);
    // dev_postgres appears twice but should only produce one entry
    expect(map).toHaveLength(1);
    expect(map[0].sourceName).toBe('dev_postgres');
  });

  it('returns one entry per unique source credential name', () => {
    const nodes = [makeNode('dev_postgres'), makeNode('dev_sendgrid', 'sendgridEmail')];
    const map = buildCredentialMap(nodes, 'dev', 'prod', CREDS);
    expect(map).toHaveLength(2);
    const names = map.map((e) => e.sourceName);
    expect(names).toContain('dev_postgres');
    expect(names).toContain('dev_sendgrid');
  });

  it('handles nodes with no credentials object gracefully', () => {
    const nodes = [
      { id: 'n1', name: 'Start', type: 'n8n-nodes-base.start' }, // no credentials
      makeNode('dev_postgres'),
    ];
    const map = buildCredentialMap(nodes, 'dev', 'prod', CREDS);
    expect(map).toHaveLength(1);
    expect(map[0].sourceName).toBe('dev_postgres');
  });

  it('handles empty credentials registry - all passthrough', () => {
    const nodes = [makeNode('dev_postgres')];
    const map = buildCredentialMap(nodes, 'dev', 'prod', EMPTY_CREDS);
    expect(map[0].status).toBe('passthrough');
    expect(map[0].targetName).toBe('dev_postgres');
  });

  it('returns passthrough when credentials field value is not an object', () => {
    const nodes = [{ id: 'n1', name: 'Weird', credentials: { postgres: null } }];
    const map = buildCredentialMap(nodes, 'dev', 'prod', CREDS);
    expect(map).toEqual([]); // null credValue is skipped
  });
});

// ── applyCredentialMap ────────────────────────────────────────────────────────

describe('applyCredentialMap', () => {
  const wf: Record<string, unknown> = {
    id: 'wf-1',
    name: 'My Workflow',
    nodes: [
      {
        id: 'node-1',
        name: 'DB',
        credentials: { postgres: { id: 'old-id', name: 'dev_postgres' } },
      },
    ],
    connections: {},
  };

  it('returns a new object - does not mutate input', () => {
    const map = [{ sourceName: 'dev_postgres', targetName: 'prod_postgres', logicalName: 'postgres', status: 'mapped' as const }];
    const result = applyCredentialMap(wf, map);
    expect(result).not.toBe(wf); // different object reference
    // Original unchanged
    const origNode = (wf.nodes as Array<Record<string, unknown>>)[0];
    const origCred = (origNode.credentials as Record<string, Record<string, unknown>>).postgres;
    expect(origCred.name).toBe('dev_postgres');
  });

  it('substitutes credential names in nodes', () => {
    const map = [{ sourceName: 'dev_postgres', targetName: 'prod_postgres', logicalName: 'postgres', status: 'mapped' as const }];
    const result = applyCredentialMap(wf, map);
    const nodes = result.nodes as Array<Record<string, unknown>>;
    const cred = (nodes[0].credentials as Record<string, Record<string, unknown>>).postgres;
    expect(cred.name).toBe('prod_postgres');
  });

  it('preserves credential id and other fields when substituting name', () => {
    const map = [{ sourceName: 'dev_postgres', targetName: 'prod_postgres', logicalName: 'postgres', status: 'mapped' as const }];
    const result = applyCredentialMap(wf, map);
    const nodes = result.nodes as Array<Record<string, unknown>>;
    const cred = (nodes[0].credentials as Record<string, Record<string, unknown>>).postgres;
    expect(cred.id).toBe('old-id'); // preserved
    expect(cred.name).toBe('prod_postgres');
  });

  it('preserves passthrough credentials with their original name', () => {
    const map = [{ sourceName: 'dev_postgres', targetName: 'dev_postgres', logicalName: null, status: 'passthrough' as const }];
    const result = applyCredentialMap(wf, map);
    const nodes = result.nodes as Array<Record<string, unknown>>;
    const cred = (nodes[0].credentials as Record<string, Record<string, unknown>>).postgres;
    expect(cred.name).toBe('dev_postgres');
  });

  it('returns shallow copy unchanged when map is empty', () => {
    const result = applyCredentialMap(wf, []);
    expect(result).toEqual(wf);
    expect(result).not.toBe(wf);
  });

  it('handles workflow with no nodes array', () => {
    const noNodes: Record<string, unknown> = { id: 'wf-x', name: 'X', connections: {} };
    const map = [{ sourceName: 'dev_postgres', targetName: 'prod_postgres', logicalName: 'postgres', status: 'mapped' as const }];
    const result = applyCredentialMap(noNodes, map);
    expect(result).toEqual(noNodes);
  });

  it('handles multiple credentials across multiple nodes', () => {
    const multiNodeWf: Record<string, unknown> = {
      id: 'wf-2',
      name: 'Multi',
      nodes: [
        { id: 'n1', credentials: { postgres: { id: 'c1', name: 'dev_postgres' } } },
        { id: 'n2', credentials: { sendgridEmail: { id: 'c2', name: 'dev_sendgrid' } } },
      ],
    };
    const map = [
      { sourceName: 'dev_postgres', targetName: 'prod_postgres', logicalName: 'postgres', status: 'mapped' as const },
      { sourceName: 'dev_sendgrid', targetName: 'prod_sendgrid', logicalName: 'sendgrid', status: 'mapped' as const },
    ];
    const result = applyCredentialMap(multiNodeWf, map);
    const nodes = result.nodes as Array<Record<string, unknown>>;
    const pgCred = (nodes[0].credentials as Record<string, Record<string, unknown>>).postgres;
    const sgCred = (nodes[1].credentials as Record<string, Record<string, unknown>>).sendgridEmail;
    expect(pgCred.name).toBe('prod_postgres');
    expect(sgCred.name).toBe('prod_sendgrid');
  });
});
