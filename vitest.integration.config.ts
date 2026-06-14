import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    timeout: 60_000,
    globalSetup: ['tests/integration/global-setup.ts'],
    // One shared n8n container for the whole run — files must not run
    // concurrently or they'll race against the same instance.
    fileParallelism: false,
  },
});
