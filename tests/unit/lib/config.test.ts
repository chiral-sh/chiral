import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { loadConfig, resolveEnv } from '../../../src/lib/config.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const GLOBAL_DIR = '/mock-global';
const PROJECT_DIR = '/project';
const INDEX = JSON.stringify({
  version: 1,
  projects: {
    'test-project': { path: PROJECT_DIR, createdAt: '2024-01-01T00:00:00.000Z' },
  },
});

const VALID_CONFIG = {
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://dev.example.com', apiKey: 'dev-key' },
    prod: { url: 'https://prod.example.com', apiKey: 'prod-key' },
  },
};

beforeEach(() => {
  vol.reset();
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'test-project';
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
});

function setupProject(config = VALID_CONFIG) {
  vol.fromJSON({
    [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
    [`${PROJECT_DIR}/.chiral/config.json`]: JSON.stringify(config),
  });
}

describe('loadConfig', () => {
  it('loads valid config from the active project', () => {
    setupProject();
    const config = loadConfig();
    expect(config.project).toBe('test-project');
    expect(config.version).toBe(1);
  });

  it('throws UserError when no config.json exists', () => {
    vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: INDEX });
    expect(() => loadConfig()).toThrow(UserError);
    expect(() => loadConfig()).toThrow('chiral environment add');
  });

  it('throws UserError when config.json is invalid JSON', () => {
    vol.fromJSON({
      [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
      [`${PROJECT_DIR}/.chiral/config.json`]: 'not json {{{',
    });
    expect(() => loadConfig()).toThrow(UserError);
    expect(() => loadConfig()).toThrow('Could not read');
  });

  it('throws UserError when version field is wrong', () => {
    const bad = { ...VALID_CONFIG, version: 2 };
    setupProject(bad as typeof VALID_CONFIG);
    expect(() => loadConfig()).toThrow(UserError);
    expect(() => loadConfig()).toThrow('Invalid config');
  });

  it('throws UserError when environments is empty', () => {
    const bad = { ...VALID_CONFIG, environments: {} };
    setupProject(bad as typeof VALID_CONFIG);
    expect(() => loadConfig()).toThrow(UserError);
  });

  it('throws UserError when environment url is not a valid URL', () => {
    const bad = {
      ...VALID_CONFIG,
      environments: { dev: { url: 'not-a-url', apiKey: 'key' } },
    };
    setupProject(bad as typeof VALID_CONFIG);
    expect(() => loadConfig()).toThrow(UserError);
    expect(() => loadConfig()).toThrow('Invalid config');
  });

  it('accepts optional licenseKey', () => {
    const cfg = { ...VALID_CONFIG, licenseKey: 'eyJhbGciOiJSUzI1NiJ9' };
    setupProject(cfg as typeof VALID_CONFIG);
    const config = loadConfig();
    expect(config.licenseKey).toBe('eyJhbGciOiJSUzI1NiJ9');
  });
});

describe('resolveEnv', () => {
  const config = { ...VALID_CONFIG };

  it('returns the environment config for a known env', () => {
    const env = resolveEnv(config, 'dev');
    expect(env.url).toBe('https://dev.example.com');
    expect(env.apiKey).toBe('dev-key');
  });

  it('throws UserError for an unknown env', () => {
    expect(() => resolveEnv(config, 'staging')).toThrow(UserError);
    expect(() => resolveEnv(config, 'staging')).toThrow(
      'Unknown environment "staging". Available: dev, prod',
    );
  });
});
