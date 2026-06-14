import { describe, it, expect } from 'vitest';
import { N8nClient } from '../../src/lib/n8n-client.js';
import { getN8n } from './helpers/context.js';

describe('global setup', () => {
  it('provides a reachable n8n url and non-placeholder api key', async () => {
    const { url, apiKey } = getN8n();

    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(apiKey).toBeTruthy();
    expect(apiKey.startsWith('YOUR_')).toBe(false);

    const client = new N8nClient({ url, apiKey }, 'test');
    await expect(client.testConnection()).resolves.toEqual({ workflowCount: 0 });
  }, 120_000);
});
