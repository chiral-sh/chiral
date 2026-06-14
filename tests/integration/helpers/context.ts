import { inject } from 'vitest';

export interface N8nContext {
  url: string;
  apiKey: string;
}

// Returns the shared n8n container's connection details published by
// tests/integration/global-setup.ts via Vitest provide/inject.
export function getN8n(): N8nContext {
  return {
    url: inject('n8nUrl'),
    apiKey: inject('n8nApiKey'),
  };
}
