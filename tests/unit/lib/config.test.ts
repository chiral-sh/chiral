import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { loadConfig, resolveEnv } from '../../../src/lib/config.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const VALID_CONFIG = {
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://dev.example.com', apiKey: 'dev-key' },
    prod: { url: 'https://prod.example.com', apiKey: 'prod-key' },
  },
  credentialMap: {},
};

beforeEach(() => vol.reset());

describe('loadConfig', () => {
  it('loads valid config from .flightdeck/config.json', () => {
    vol.fromJSON({ '/project/.flightdeck/config.json': JSON.stringify(VALID_CONFIG) });
    const config = loadConfig('/project');
    expect(config.project).toBe('test-project');
    expect(config.version).toBe(1);
  });

  it('resolves config by walking up from a subdirectory', () => {
    vol.fromJSON({ '/project/.flightdeck/config.json': JSON.stringify(VALID_CONFIG) });
    const config = loadConfig('/project/src/commands');
    expect(config.project).toBe('test-project');
  });

  it('throws UserError when no config.json exists', () => {
    vol.fromJSON({});
    expect(() => loadConfig('/no-config')).toThrow(UserError);
    expect(() => loadConfig('/no-config')).toThrow(
      "No .flightdeck/config.json found. Run 'flightdeck init' first.",
    );
  });

  it('throws UserError when config.json is invalid JSON', () => {
    vol.fromJSON({ '/project/.flightdeck/config.json': 'not json {{{' });
    expect(() => loadConfig('/project')).toThrow(UserError);
    expect(() => loadConfig('/project')).toThrow('Could not read');
  });

  it('throws UserError when version field is wrong', () => {
    const bad = { ...VALID_CONFIG, version: 2 };
    vol.fromJSON({ '/project/.flightdeck/config.json': JSON.stringify(bad) });
    expect(() => loadConfig('/project')).toThrow(UserError);
    expect(() => loadConfig('/project')).toThrow('Invalid config');
  });

  it('throws UserError when environments is empty', () => {
    const bad = { ...VALID_CONFIG, environments: {} };
    vol.fromJSON({ '/project/.flightdeck/config.json': JSON.stringify(bad) });
    expect(() => loadConfig('/project')).toThrow(UserError);
  });

  it('throws UserError when environment url is not a valid URL', () => {
    const bad = {
      ...VALID_CONFIG,
      environments: { dev: { url: 'not-a-url', apiKey: 'key' } },
    };
    vol.fromJSON({ '/project/.flightdeck/config.json': JSON.stringify(bad) });
    expect(() => loadConfig('/project')).toThrow(UserError);
    expect(() => loadConfig('/project')).toThrow('Invalid config');
  });

  it('defaults credentialMap to empty object when omitted', () => {
    const { credentialMap: _omitted, ...withoutMap } = VALID_CONFIG;
    vol.fromJSON({ '/project/.flightdeck/config.json': JSON.stringify(withoutMap) });
    const config = loadConfig('/project');
    expect(config.credentialMap).toEqual({});
  });

  it('preserves credentialMap entries', () => {
    const cfg = { ...VALID_CONFIG, credentialMap: { dev_db: 'prod_db' } };
    vol.fromJSON({ '/project/.flightdeck/config.json': JSON.stringify(cfg) });
    const config = loadConfig('/project');
    expect(config.credentialMap).toEqual({ dev_db: 'prod_db' });
  });

  it('accepts optional licenseKey', () => {
    const cfg = { ...VALID_CONFIG, licenseKey: 'eyJhbGciOiJSUzI1NiJ9' };
    vol.fromJSON({ '/project/.flightdeck/config.json': JSON.stringify(cfg) });
    const config = loadConfig('/project');
    expect(config.licenseKey).toBe('eyJhbGciOiJSUzI1NiJ9');
  });
});

describe('resolveEnv', () => {
  const config = {
    ...VALID_CONFIG,
    credentialMap: {},
  };

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
