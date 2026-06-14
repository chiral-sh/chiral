import type { TestProject } from 'vitest/node';
import { startN8n } from './helpers/n8n-harness.js';

declare module 'vitest' {
  export interface ProvidedContext {
    n8nUrl: string;
    n8nApiKey: string;
  }
}

// Starts one shared n8n container for the whole integration run and
// publishes its connection details to test files via Vitest's
// provide/inject mechanism. With CHIRAL_TEST_KEEP_N8N=1, teardown is
// skipped and the live URL + key are printed for manual debugging.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { url, apiKey, stop } = await startN8n();

  project.provide('n8nUrl', url);
  project.provide('n8nApiKey', apiKey);

  return async (): Promise<void> => {
    if (process.env.CHIRAL_TEST_KEEP_N8N === '1') {
      console.error(`CHIRAL_TEST_KEEP_N8N=1: leaving n8n container running at ${url} (apiKey: ${apiKey})`);
      return;
    }
    await stop();
  };
}
