import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import {
  loadUrlMap,
  writeUrlMap,
  validateUrlValue,
  buildUrlMap,
  applyUrlMap,
  deriveUrlLogicalName,
  extractUrlsFromSnapshots,
  UrlMap,
  UrlSubstitution,
} from '../../../src/state/url-map.js';
import { writeSnapshot, writeSnapshotMeta } from '../../../src/state/snapshots.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const EMPTY_MAP: UrlMap = { version: 1, urls: {} };

const FULL_MAP: UrlMap = {
  version: 1,
  urls: {
    api_base: {
      exact: false,
      values: {
        dev: 'https://api.dev.example.com',
        prod: 'https://api.example.com',
      },
    },
    webhook: {
      values: {
        dev: 'https://hooks.dev.example.com',
      },
    },
  },
};

beforeEach(() => vol.reset());

describe('loadUrlMap', () => {
  it('returns empty map when url-map.json absent', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    expect(loadUrlMap('/project/.chiral')).toEqual({ version: 1, urls: {} });
  });

  it('throws UserError containing "url-map.json" on corrupt JSON', () => {
    vol.fromJSON({ '/project/.chiral/url-map.json': 'not valid {{{' });
    expect(() => loadUrlMap('/project/.chiral')).toThrow(UserError);
    expect(() => loadUrlMap('/project/.chiral')).toThrow('url-map.json');
  });

  it('throws UserError on wrong version', () => {
    vol.fromJSON({
      '/project/.chiral/url-map.json': JSON.stringify({ version: 2, urls: {} }),
    });
    expect(() => loadUrlMap('/project/.chiral')).toThrow(UserError);
  });

  it('throws UserError on missing version field', () => {
    vol.fromJSON({
      '/project/.chiral/url-map.json': JSON.stringify({ urls: {} }),
    });
    expect(() => loadUrlMap('/project/.chiral')).toThrow(UserError);
  });

  it('loads full map correctly', () => {
    vol.fromJSON({ '/project/.chiral/url-map.json': JSON.stringify(FULL_MAP) });
    const result = loadUrlMap('/project/.chiral');
    expect(result.urls['api_base']?.values['dev']).toBe('https://api.dev.example.com');
    expect(result.urls['api_base']?.values['prod']).toBe('https://api.example.com');
    expect(result.urls['webhook']?.values['dev']).toBe('https://hooks.dev.example.com');
  });

  it('defaults urls to empty object when field omitted', () => {
    vol.fromJSON({ '/project/.chiral/url-map.json': JSON.stringify({ version: 1 }) });
    expect(loadUrlMap('/project/.chiral').urls).toEqual({});
  });
});

describe('writeUrlMap + loadUrlMap round-trip', () => {
  it('writes and reads back correctly', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeUrlMap('/project/.chiral', FULL_MAP);
    expect(loadUrlMap('/project/.chiral')).toEqual(FULL_MAP);
  });

  it('writes empty map and reads back', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeUrlMap('/project/.chiral', EMPTY_MAP);
    expect(loadUrlMap('/project/.chiral')).toEqual(EMPTY_MAP);
  });

  it('overwrites existing url-map.json', () => {
    vol.fromJSON({ '/project/.chiral/url-map.json': JSON.stringify(FULL_MAP) });
    writeUrlMap('/project/.chiral', EMPTY_MAP);
    expect(loadUrlMap('/project/.chiral').urls).toEqual({});
  });
});

describe('deriveUrlLogicalName', () => {
  it('converts hostname dots to hyphens', () => {
    expect(deriveUrlLogicalName('https://api.dev.example.com/v1')).toBe('api-dev-example-com');
  });

  it('handles simple hostname', () => {
    expect(deriveUrlLogicalName('https://example.com')).toBe('example-com');
  });
});

describe('buildUrlMap', () => {
  const urlMap: UrlMap = {
    version: 1,
    urls: {
      api_base: {
        values: { dev: 'https://api.dev.example.com', prod: 'https://api.example.com' },
      },
      exact_entry: {
        exact: true,
        values: {
          dev: 'https://exact.dev.example.com/specific/path',
          prod: 'https://exact.example.com/specific/path',
        },
      },
    },
  };

  const makeNodes = (params: Record<string, unknown>, name = 'Node A') => [
    { name, type: 'httpRequest', parameters: params },
  ];

  it('produces substitution for prefix-matched URL', () => {
    const { substitutions } = buildUrlMap(
      makeNodes({ url: 'https://api.dev.example.com/v1/orders' }),
      'dev',
      'prod',
      urlMap,
    );
    expect(substitutions).toHaveLength(1);
    expect(substitutions[0]).toMatchObject({
      logicalName: 'api_base',
      sourceValue: 'https://api.dev.example.com',
      targetValue: 'https://api.example.com',
      exact: false,
      affectedNodes: ['Node A'],
    });
  });

  it('host-boundary guard: does not match superdomain', () => {
    const { substitutions, warnings } = buildUrlMap(
      makeNodes({ url: 'https://api.dev.example.com.evil.com/v1' }),
      'dev',
      'prod',
      urlMap,
    );
    expect(substitutions).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it('exact entry matches only full literal', () => {
    const { substitutions: sub1 } = buildUrlMap(
      makeNodes({ url: 'https://exact.dev.example.com/specific/path/extra' }),
      'dev',
      'prod',
      urlMap,
    );
    expect(sub1).toHaveLength(0);

    const { substitutions: sub2 } = buildUrlMap(
      makeNodes({ url: 'https://exact.dev.example.com/specific/path' }),
      'dev',
      'prod',
      urlMap,
    );
    expect(sub2).toHaveLength(1);
    expect(sub2[0]?.exact).toBe(true);
  });

  it('produces deduped warnings for unmapped http URLs with accumulated node names', () => {
    const nodes = [
      { name: 'Node A', parameters: { url: 'https://unmapped.example.com/v1' } },
      { name: 'Node B', parameters: { url: 'https://unmapped.example.com/v1' } },
    ];
    const { warnings } = buildUrlMap(nodes, 'dev', 'prod', urlMap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.value).toBe('https://unmapped.example.com/v1');
    expect(warnings[0]?.affectedNodes).toEqual(['Node A', 'Node B']);
    expect(warnings[0]?.suggestedKey).toBe('unmapped-example-com');
  });

  it('non-URL strings produce no substitutions or warnings', () => {
    const { substitutions, warnings } = buildUrlMap(
      makeNodes({ description: 'just some text', count: 5 } as Record<string, unknown>),
      'dev',
      'prod',
      urlMap,
    );
    expect(substitutions).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('accumulates node names for same substitution across nodes', () => {
    const nodes = [
      { name: 'Node A', parameters: { url: 'https://api.dev.example.com/v1' } },
      { name: 'Node B', parameters: { url: 'https://api.dev.example.com/v2' } },
    ];
    const { substitutions } = buildUrlMap(nodes, 'dev', 'prod', urlMap);
    expect(substitutions).toHaveLength(1);
    expect(substitutions[0]?.affectedNodes).toEqual(['Node A', 'Node B']);
  });

  it('skips entries with no target env value', () => {
    const partialMap: UrlMap = {
      version: 1,
      urls: {
        api_base: { values: { dev: 'https://api.dev.example.com' } }, // no prod
      },
    };
    const { substitutions, warnings } = buildUrlMap(
      makeNodes({ url: 'https://api.dev.example.com/v1' }),
      'dev',
      'prod',
      partialMap,
    );
    expect(substitutions).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});

describe('applyUrlMap', () => {
  const substitutions: UrlSubstitution[] = [
    {
      logicalName: 'api_base',
      sourceValue: 'https://api.dev.example.com',
      targetValue: 'https://api.example.com',
      exact: false,
      affectedNodes: ['Node A'],
    },
  ];

  it('rewrites prefix URL and preserves path', () => {
    const workflow = {
      nodes: [{ name: 'Node A', parameters: { url: 'https://api.dev.example.com/v1/orders' } }],
    };
    const result = applyUrlMap(workflow, substitutions);
    const nodes = result['nodes'] as Array<{ parameters: { url: string } }>;
    expect(nodes[0]?.parameters.url).toBe('https://api.example.com/v1/orders');
  });

  it('does not mutate input workflow', () => {
    const workflow = {
      nodes: [{ name: 'Node A', parameters: { url: 'https://api.dev.example.com/v1' } }],
    };
    const original = JSON.stringify(workflow);
    applyUrlMap(workflow, substitutions);
    expect(JSON.stringify(workflow)).toBe(original);
  });

  it('exact substitution replaces full literal', () => {
    const exactSubs: UrlSubstitution[] = [
      {
        logicalName: 'exact_entry',
        sourceValue: 'https://exact.dev.example.com/specific/path',
        targetValue: 'https://exact.example.com/specific/path',
        exact: true,
        affectedNodes: ['Node A'],
      },
    ];
    const workflow = {
      nodes: [
        { name: 'Node A', parameters: { url: 'https://exact.dev.example.com/specific/path' } },
      ],
    };
    const result = applyUrlMap(workflow, exactSubs);
    const nodes = result['nodes'] as Array<{ parameters: { url: string } }>;
    expect(nodes[0]?.parameters.url).toBe('https://exact.example.com/specific/path');
  });

  it('exact substitution does not replace partial match', () => {
    const exactSubs: UrlSubstitution[] = [
      {
        logicalName: 'exact_entry',
        sourceValue: 'https://exact.dev.example.com/specific/path',
        targetValue: 'https://exact.example.com/specific/path',
        exact: true,
        affectedNodes: ['Node A'],
      },
    ];
    const workflow = {
      nodes: [
        {
          name: 'Node A',
          parameters: { url: 'https://exact.dev.example.com/specific/path/extra' },
        },
      ],
    };
    const result = applyUrlMap(workflow, exactSubs);
    const nodes = result['nodes'] as Array<{ parameters: { url: string } }>;
    expect(nodes[0]?.parameters.url).toBe('https://exact.dev.example.com/specific/path/extra');
  });

  it('returns spread copy when no substitutions', () => {
    const workflow = {
      nodes: [{ name: 'Node A', parameters: { url: 'https://api.dev.example.com/v1' } }],
    };
    const result = applyUrlMap(workflow, []);
    const nodes = result['nodes'] as Array<{ parameters: { url: string } }>;
    expect(nodes[0]?.parameters.url).toBe('https://api.dev.example.com/v1');
  });

  it('non-URL parameter strings are untouched', () => {
    const workflow = {
      nodes: [{ name: 'Node A', parameters: { description: 'just text' } }],
    };
    const result = applyUrlMap(workflow, substitutions);
    const nodes = result['nodes'] as Array<{ parameters: { description: string } }>;
    expect(nodes[0]?.parameters.description).toBe('just text');
  });

  it('rewrites URLs in nested parameters', () => {
    const workflow = {
      nodes: [{ name: 'Node A', parameters: { nested: { url: 'https://api.dev.example.com/v1' } } }],
    };
    const result = applyUrlMap(workflow, substitutions);
    const nodes = result['nodes'] as Array<{ parameters: { nested: { url: string } } }>;
    expect(nodes[0]?.parameters.nested.url).toBe('https://api.example.com/v1');
  });
});

describe('validateUrlValue', () => {
  it('accepts https URL with path', () => {
    expect(() => validateUrlValue('https://api.example.com/v1')).not.toThrow();
  });

  it('accepts http URL', () => {
    expect(() => validateUrlValue('http://internal.example.com')).not.toThrow();
  });

  it('accepts https URL with port', () => {
    expect(() => validateUrlValue('https://api.example.com:8443/v1')).not.toThrow();
  });

  it('rejects non-URL string', () => {
    expect(() => validateUrlValue('not-a-url')).toThrow(UserError);
  });

  it('rejects ftp:// scheme', () => {
    expect(() => validateUrlValue('ftp://example.com')).toThrow(UserError);
  });

  it('rejects URL with userinfo — user:pass — with a specific message', () => {
    expect(() => validateUrlValue('https://user:pass@host.example.com')).toThrow(UserError);
    expect(() => validateUrlValue('https://user:pass@host.example.com')).toThrow('credentials');
  });

  it('rejects URL with username only', () => {
    expect(() => validateUrlValue('https://token@host.example.com')).toThrow(UserError);
  });
});

describe('extractUrlsFromSnapshots', () => {
  const CHIRAL = '/project/.chiral';
  const deployId = '20240101T120000Z-abcd1234';

  function writeMeta(env: string) {
    writeSnapshotMeta(CHIRAL, deployId, {
      deployment_id: deployId,
      env,
      command: 'adopt',
      timestamp: '2024-01-01T12:00:00.000Z',
      workflow_count: 1,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
  }

  function makeWorkflowWithUrls(id: string, name: string, urls: string[]) {
    return {
      id,
      name,
      nodes: urls.map((url, i) => ({
        id: `node-${i}`,
        name: `Node ${i}`,
        type: 'n8n-nodes-base.httpRequest',
        parameters: { url },
      })),
    };
  }

  it('returns each unique URL once per env with its workflow names', () => {
    vol.fromJSON({ [`${CHIRAL}/`]: null });
    writeMeta('dev');
    writeSnapshot(CHIRAL, deployId, makeWorkflowWithUrls('wf-1', 'Billing', ['https://api.dev.example.com/v1']));
    writeSnapshot(CHIRAL, deployId, makeWorkflowWithUrls('wf-2', 'Invoice', ['https://api.dev.example.com/v1']));

    const result = extractUrlsFromSnapshots(CHIRAL, ['dev']);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      value: 'https://api.dev.example.com/v1',
      hostname: 'api.dev.example.com',
      env: 'dev',
    });
    expect(result[0]!.workflowNames).toEqual(expect.arrayContaining(['Billing', 'Invoice']));
  });

  it('returns distinct entries for distinct URLs', () => {
    vol.fromJSON({ [`${CHIRAL}/`]: null });
    writeMeta('dev');
    writeSnapshot(
      CHIRAL,
      deployId,
      makeWorkflowWithUrls('wf-1', 'Billing', [
        'https://api.dev.example.com/v1',
        'https://hooks.dev.example.com/webhook',
      ]),
    );

    const result = extractUrlsFromSnapshots(CHIRAL, ['dev']);
    expect(result).toHaveLength(2);
  });

  it('skips env with no deployment', () => {
    vol.fromJSON({ [`${CHIRAL}/`]: null });
    const result = extractUrlsFromSnapshots(CHIRAL, ['prod']);
    expect(result).toEqual([]);
  });

  it('skips corrupt snapshot file without throwing', () => {
    vol.fromJSON({
      [`${CHIRAL}/`]: null,
      [`${CHIRAL}/snapshots/${deployId}/meta.json`]: JSON.stringify({
        deployment_id: deployId,
        env: 'dev',
        command: 'adopt',
        timestamp: '2024-01-01T12:00:00.000Z',
        workflow_count: 1,
        filters: { tag: null, pattern: null, onlyActive: false, id: null },
      }),
      [`${CHIRAL}/snapshots/${deployId}/corrupt-wf.json`]: 'not valid json {{{',
    });
    expect(() => extractUrlsFromSnapshots(CHIRAL, ['dev'])).not.toThrow();
    const result = extractUrlsFromSnapshots(CHIRAL, ['dev']);
    expect(result).toEqual([]);
  });

  it('collects URLs from nested parameters', () => {
    vol.fromJSON({ [`${CHIRAL}/`]: null });
    writeMeta('dev');
    writeSnapshot(CHIRAL, deployId, {
      id: 'wf-1',
      name: 'Nested',
      nodes: [
        {
          id: 'n1',
          name: 'Node 0',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { options: { url: 'https://nested.dev.example.com/api' } },
        },
      ],
    });

    const result = extractUrlsFromSnapshots(CHIRAL, ['dev']);
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe('https://nested.dev.example.com/api');
  });
});
