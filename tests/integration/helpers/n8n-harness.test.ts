import { describe, it, expect, afterAll } from 'vitest';
import { N8nClient } from '../../../src/lib/n8n-client.js';
import { startN8n, type N8nHandle } from './n8n-harness.js';

describe('startN8n', () => {
  let handle: N8nHandle;

  afterAll(async () => {
    if (handle) await handle.stop();
  });

  it('boots a real n8n container and bootstraps a working API key', async () => {
    handle = await startN8n();

    expect(handle.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(handle.apiKey).toBeTruthy();
    expect(handle.apiKey.startsWith('YOUR_')).toBe(false);

    const client = new N8nClient({ url: handle.url, apiKey: handle.apiKey }, 'test');
    await expect(client.testConnection()).resolves.toEqual({ workflowCount: 0 });
  }, 120_000);
});
