import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadConfigAndDir } from '../../../src/lib/config.js';
import { makeRepo } from './repo.js';

describe('makeRepo', () => {
  it('scaffolds a git repo with a valid, non-placeholder config.json', () => {
    const repo = makeRepo({
      url: 'http://localhost:55678',
      apiKey: 'real-bootstrapped-api-key-1234',
    });

    try {
      const { config } = loadConfigAndDir(repo.dir);
      const env = config.environments['dev'];

      expect(env.url).toBe('http://localhost:55678');
      expect(env.apiKey).toBe('real-bootstrapped-api-key-1234');
      expect(env.apiKey.startsWith('YOUR_')).toBe(false);
      expect(existsSync(join(repo.dir, '.git'))).toBe(true);
    } finally {
      repo.cleanup();
    }

    expect(existsSync(repo.dir)).toBe(false);
  });
});
