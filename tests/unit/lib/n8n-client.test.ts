import { describe, it, expect, vi, beforeEach } from 'vitest';
import { N8nClient } from '../../../src/lib/n8n-client.js';
import { UserError } from '../../../src/lib/errors.js';

const ENV = { url: 'https://n8n.example.com', apiKey: 'test-key' };
const ENV_NAME = 'dev';

function makeFetch(pages: object[]): ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const body = pages[call++] ?? { data: [], nextCursor: null };
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
    });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('N8nClient constructor', () => {
  it('strips trailing slash from env url', async () => {
    const fetchMock = makeFetch([{ data: [], nextCursor: null }]);
    vi.stubGlobal('fetch', fetchMock);

    const client = new N8nClient({ url: 'https://n8n.example.com/', apiKey: 'k' }, 'dev');
    await client.listWorkflows();

    expect(fetchMock.mock.calls[0][0]).toMatch('https://n8n.example.com/api/v1/');
  });
});

describe('N8nClient.listWorkflows', () => {
  it('returns empty array when no workflows exist', async () => {
    vi.stubGlobal('fetch', makeFetch([{ data: [], nextCursor: null }]));
    const client = new N8nClient(ENV, ENV_NAME);
    expect(await client.listWorkflows()).toEqual([]);
  });

  it('returns all workflows from a single page', async () => {
    const wf = { id: 'wf-1', name: 'My Workflow', active: true, createdAt: '', updatedAt: '', tags: [], versionId: 'v1' };
    vi.stubGlobal('fetch', makeFetch([{ data: [wf], nextCursor: null }]));
    const client = new N8nClient(ENV, ENV_NAME);
    expect(await client.listWorkflows()).toEqual([wf]);
  });

  it('paginates through multiple pages', async () => {
    const wf1 = { id: 'wf-1', name: 'WF1', active: true, createdAt: '', updatedAt: '', tags: [], versionId: 'v1' };
    const wf2 = { id: 'wf-2', name: 'WF2', active: false, createdAt: '', updatedAt: '', tags: [], versionId: 'v2' };
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { data: [wf1], nextCursor: 'cursor-abc' },
        { data: [wf2], nextCursor: null },
      ]),
    );
    const client = new N8nClient(ENV, ENV_NAME);
    expect(await client.listWorkflows()).toEqual([wf1, wf2]);
  });

  it('sends cursor in second request', async () => {
    const fetchMock = makeFetch([
      { data: [{ id: 'wf-1', name: 'WF1', active: true, createdAt: '', updatedAt: '', tags: [], versionId: 'v1' }], nextCursor: 'next-cursor' },
      { data: [], nextCursor: null },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nClient(ENV, ENV_NAME);
    await client.listWorkflows();
    expect(fetchMock.mock.calls[1][0]).toContain('cursor=next-cursor');
  });

  it('passes active=true param when filters.active is true', async () => {
    const fetchMock = makeFetch([{ data: [], nextCursor: null }]);
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nClient(ENV, ENV_NAME);
    await client.listWorkflows({ active: true });
    expect(fetchMock.mock.calls[0][0]).toContain('active=true');
  });

  it('passes tags param when filters.tags is set', async () => {
    const fetchMock = makeFetch([{ data: [], nextCursor: null }]);
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nClient(ENV, ENV_NAME);
    await client.listWorkflows({ tags: 'production' });
    expect(fetchMock.mock.calls[0][0]).toContain('tags=production');
  });

  it('does not include active param when filters.active is undefined', async () => {
    const fetchMock = makeFetch([{ data: [], nextCursor: null }]);
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nClient(ENV, ENV_NAME);
    await client.listWorkflows({});
    expect(fetchMock.mock.calls[0][0]).not.toContain('active=');
  });

  it('throws UserError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', json: () => Promise.resolve({}) }));
    const client = new N8nClient(ENV, ENV_NAME);
    await expect(client.listWorkflows()).rejects.toThrow('API key for dev is invalid or expired');
  });

  it('throws UserError on 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', json: () => Promise.resolve({}) }));
    const client = new N8nClient(ENV, ENV_NAME);
    await expect(client.listWorkflows()).rejects.toThrow(UserError);
    await expect(client.listWorkflows()).rejects.toThrow('missing scope: workflow:list');
  });

  it('throws UserError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const client = new N8nClient(ENV, ENV_NAME);
    await expect(client.listWorkflows()).rejects.toThrow(UserError);
    await expect(client.listWorkflows()).rejects.toThrow('Cannot reach dev');
  });

  it('throws UserError on unexpected HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error', json: () => Promise.resolve({}) }));
    const client = new N8nClient(ENV, ENV_NAME);
    await expect(client.listWorkflows()).rejects.toThrow(UserError);
  });
});

describe('N8nClient.getWorkflow', () => {
  it('returns full workflow object', async () => {
    const full = { id: 'wf-1', name: 'WF', active: true, nodes: [], connections: {}, settings: {}, tags: [], createdAt: '', updatedAt: '', versionId: 'v1' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(full) }));
    const client = new N8nClient(ENV, ENV_NAME);
    expect(await client.getWorkflow('wf-1')).toEqual(full);
  });

  it('includes workflow id in request url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve({ id: 'wf-42', name: 'X', active: false, nodes: [], connections: {}, settings: {}, tags: [], createdAt: '', updatedAt: '', versionId: 'v1' }) });
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nClient(ENV, ENV_NAME);
    await client.getWorkflow('wf-42');
    expect(fetchMock.mock.calls[0][0]).toContain('/workflows/wf-42');
  });
});

describe('N8nClient.listCredentials', () => {
  it('returns credential summaries without secret data', async () => {
    const cred = { id: 'cred-1', name: 'postgres', type: 'postgres' };
    vi.stubGlobal('fetch', makeFetch([{ data: [cred], nextCursor: null }]));
    const client = new N8nClient(ENV, ENV_NAME);
    expect(await client.listCredentials()).toEqual([cred]);
  });
});

describe('N8nClient.listTags', () => {
  it('returns tag list', async () => {
    const tag = { id: 'tag-1', name: 'production' };
    vi.stubGlobal('fetch', makeFetch([{ data: [tag], nextCursor: null }]));
    const client = new N8nClient(ENV, ENV_NAME);
    expect(await client.listTags()).toEqual([tag]);
  });
});
