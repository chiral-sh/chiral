import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { parseConfigExample } from '../../../src/lib/config.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const CHIRAL_DIR = '/project/.chiral';

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${CHIRAL_DIR}/`]: null });
});

afterEach(() => {
  vol.reset();
});

const REAL_URL = 'https://n8n.acme.com';
const REAL_KEY = 'my-real-api-key';

function writeExample(obj: unknown): void {
  vol.writeFileSync(`${CHIRAL_DIR}/config.example.json`, JSON.stringify(obj));
}

describe('parseConfigExample', () => {
  it('returns non-placeholder URL as-is', () => {
    writeExample({
      project: 'acme',
      environments: { dev: { url: REAL_URL, apiKey: REAL_KEY } },
    });
    const result = parseConfigExample(CHIRAL_DIR);
    expect(result.project).toBe('acme');
    expect(result.envs['dev']?.url).toBe(REAL_URL);
  });

  it('returns undefined for URL containing "your-domain"', () => {
    writeExample({
      project: 'acme',
      environments: { dev: { url: 'https://your-domain.n8n.io', apiKey: REAL_KEY } },
    });
    const result = parseConfigExample(CHIRAL_DIR);
    expect(result.envs['dev']?.url).toBeUndefined();
  });

  it('returns undefined for URL containing "example.com"', () => {
    writeExample({
      project: 'acme',
      environments: { dev: { url: 'https://n8n.example.com', apiKey: REAL_KEY } },
    });
    const result = parseConfigExample(CHIRAL_DIR);
    expect(result.envs['dev']?.url).toBeUndefined();
  });

  it('returns undefined for URL containing "localhost"', () => {
    writeExample({
      project: 'acme',
      environments: { dev: { url: 'http://localhost:5678', apiKey: REAL_KEY } },
    });
    const result = parseConfigExample(CHIRAL_DIR);
    expect(result.envs['dev']?.url).toBeUndefined();
  });

  it('returns undefined for URL when apiKey starts with "YOUR_"', () => {
    writeExample({
      project: 'acme',
      environments: { dev: { url: REAL_URL, apiKey: 'YOUR_API_KEY_HERE' } },
    });
    const result = parseConfigExample(CHIRAL_DIR);
    expect(result.envs['dev']?.url).toBeUndefined();
  });

  it('passes through verbatim gitSync block', () => {
    const gitSync = { enabled: true, remote: 'origin', branch: 'main' };
    writeExample({
      project: 'acme',
      environments: { dev: { url: REAL_URL, apiKey: REAL_KEY } },
      gitSync,
    });
    const result = parseConfigExample(CHIRAL_DIR);
    expect(result.gitSync).toEqual(gitSync);
  });

  it('returns undefined gitSync when not present', () => {
    writeExample({
      project: 'acme',
      environments: { dev: { url: REAL_URL, apiKey: REAL_KEY } },
    });
    const result = parseConfigExample(CHIRAL_DIR);
    expect(result.gitSync).toBeUndefined();
  });

  it('throws UserError with exact message when config.example.json is missing', () => {
    // Do not write the file
    expect(() => parseConfigExample(CHIRAL_DIR)).toThrow(UserError);
    expect(() => parseConfigExample(CHIRAL_DIR)).toThrow(
      'Found .chiral/ but config.example.json is missing or invalid. Ask a teammate to share it.',
    );
  });

  it('throws UserError with exact message when config.example.json is invalid JSON', () => {
    vol.writeFileSync(`${CHIRAL_DIR}/config.example.json`, 'not-valid-json{{');
    expect(() => parseConfigExample(CHIRAL_DIR)).toThrow(UserError);
    expect(() => parseConfigExample(CHIRAL_DIR)).toThrow(
      'Found .chiral/ but config.example.json is missing or invalid. Ask a teammate to share it.',
    );
  });
});
