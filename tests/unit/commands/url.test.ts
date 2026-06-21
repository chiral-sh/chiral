import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../../src/lib/git-sync.js', () => ({
  syncToRemote: vi.fn().mockResolvedValue({ skipped: true }),
  formatSyncSuccess: vi.fn().mockReturnValue(''),
  formatSyncFailure: vi.fn().mockReturnValue([]),
  logSyncError: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../../src/state/snapshots.js', () => ({
  listDeployments: vi.fn().mockReturnValue([]),
  findLatestDeploymentForEnv: vi.fn(),
  readAllWorkflowsInDeployment: vi.fn().mockReturnValue({ workflows: [], corruptCount: 0 }),
}));

vi.mock('../../../src/state/url-map.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/state/url-map.js')>();
  return {
    ...mod,
    extractUrlsFromSnapshots: vi.fn().mockReturnValue([]),
  };
});

import { execSync } from 'node:child_process';
import { input, confirm } from '@inquirer/prompts';
import { listDeployments } from '../../../src/state/snapshots.js';
import * as urlMapState from '../../../src/state/url-map.js';
import { runUrlMap, runUrlList, runUrlUnmap } from '../../../src/commands/url.js';

const mockExecSync = vi.mocked(execSync);
const mockInput = vi.mocked(input);
const mockConfirm = vi.mocked(confirm);
const mockListDeployments = vi.mocked(listDeployments);
const mockExtractUrls = vi.mocked(urlMapState.extractUrlsFromSnapshots);

const GLOBAL_DIR = '/mock-global';
const PROJECT_DIR = '/project';
const INDEX = JSON.stringify({
  version: 1,
  projects: { 'test-project': { path: PROJECT_DIR, createdAt: '2024-01-01T00:00:00.000Z' } },
});

const VALID_CONFIG = JSON.stringify({
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'key-dev' },
    prod: { url: 'https://prod.n8n.example.com', apiKey: 'key-prod' },
  },
});

const EMPTY_URL_MAP = JSON.stringify({ version: 1, urls: {} });

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('actor@example.com\n' as never);
  mockExtractUrls.mockReturnValue([]);
  mockListDeployments.mockReturnValue([]);
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'test-project';
  vol.fromJSON({ [`${GLOBAL_DIR}/projects/index.json`]: INDEX });
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
});

function setupBase(urlMapContent = EMPTY_URL_MAP) {
  vol.fromJSON({
    [`${PROJECT_DIR}/.chiral/config.json`]: VALID_CONFIG,
    [`${PROJECT_DIR}/.chiral/url-map.json`]: urlMapContent,
    [`${PROJECT_DIR}/.chiral/audit.jsonl`]: '',
  });
}

// ── runUrlMap (non-interactive) ───────────────────────────────────────────────

describe('runUrlMap (non-interactive)', () => {
  it('writes both env values from positional env=url pairs', async () => {
    setupBase();
    await runUrlMap(
      ['api_base', 'dev=https://api.dev.example.com', 'prod=https://api.example.com'],
      {},
    );

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base'].values).toEqual({
      dev: 'https://api.dev.example.com',
      prod: 'https://api.example.com',
    });
  });

  it('sets exact flag when --exact passed', async () => {
    setupBase();
    await runUrlMap(
      ['api_base', 'dev=https://api.dev.example.com', 'prod=https://api.example.com'],
      { exact: true },
    );

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base'].exact).toBe(true);
  });

  it('does not set exact flag when --exact not passed', async () => {
    setupBase();
    await runUrlMap(['api_base', 'dev=https://api.dev.example.com'], {});

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base'].exact).toBeUndefined();
  });

  it('throws UserError for userinfo URL and writes nothing', async () => {
    setupBase();
    await expect(
      runUrlMap(['api_base', 'dev=https://user:pass@api.dev.example.com'], {}),
    ).rejects.toBeInstanceOf(UserError);

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls).toEqual({});
  });

  it('throws UserError for token-only userinfo URL and writes nothing', async () => {
    setupBase();
    await expect(
      runUrlMap(['webhook', 'dev=https://token@hooks.example.com'], {}),
    ).rejects.toBeInstanceOf(UserError);

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls).toEqual({});
  });

  it('prints warning but still writes when env absent from config', async () => {
    setupBase();
    const warnSpy = vi.spyOn(console, 'log');
    await runUrlMap(['api_base', 'staging=https://api.staging.example.com'], {});

    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('"staging"') && m.includes('not in config.json'))).toBe(true);

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base'].values['staging']).toBe('https://api.staging.example.com');
  });

  it('emits { status, data } JSON envelope with --json', async () => {
    setupBase();
    const logSpy = vi.spyOn(console, 'log');
    await runUrlMap(
      ['api_base', 'dev=https://api.dev.example.com', 'prod=https://api.example.com'],
      { json: true },
    );

    const jsonLine = logSpy.mock.calls.map((c) => String(c[0])).find((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.logical_name).toBe('api_base');
    expect(parsed.data.values).toEqual({
      dev: 'https://api.dev.example.com',
      prod: 'https://api.example.com',
    });
    expect(typeof parsed.data.exact).toBe('boolean');
  });

  it('upserts existing entry without overwriting other envs', async () => {
    setupBase(
      JSON.stringify({
        version: 1,
        urls: {
          api_base: { values: { dev: 'https://api.dev.example.com' } },
        },
      }),
    );
    await runUrlMap(['api_base', 'prod=https://api.example.com'], {});

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base'].values).toEqual({
      dev: 'https://api.dev.example.com',
      prod: 'https://api.example.com',
    });
  });

  it('throws UserError for --value without --env', async () => {
    setupBase();
    await expect(
      runUrlMap([], { value: 'https://api.example.com' }),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('throws UserError for --env without --value', async () => {
    setupBase();
    await expect(runUrlMap(['api_base'], { env: 'dev' })).rejects.toBeInstanceOf(UserError);
  });

  it('accepts single env via --env/--value flags', async () => {
    setupBase();
    await runUrlMap(['api_base'], { env: 'dev', value: 'https://api.dev.example.com' });

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base'].values['dev']).toBe('https://api.dev.example.com');
  });

  it('throws UserError when mixing positional pairs with --env/--value flags', async () => {
    setupBase();
    await expect(
      runUrlMap(['api_base', 'dev=https://api.dev.example.com'], {
        env: 'prod',
        value: 'https://api.example.com',
      }),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('writes an audit entry with action map', async () => {
    setupBase();
    await runUrlMap(['api_base', 'dev=https://api.dev.example.com'], {});

    const auditLine = (vol.readFileSync(`${PROJECT_DIR}/.chiral/audit.jsonl`, 'utf-8') as string)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.action === 'map');
    expect(auditLine).toBeDefined();
    expect(auditLine.action).toBe('map');
  });
});

// ── runUrlMap (interactive discovery) ─────────────────────────────────────────

describe('runUrlMap (interactive discovery)', () => {
  it('discovers unmapped URL and writes on confirmation', async () => {
    setupBase();
    mockExtractUrls.mockReturnValue([
      {
        value: 'https://api.dev.example.com',
        hostname: 'api.dev.example.com',
        env: 'dev',
        workflowNames: ['Workflow 1'],
      },
    ]);
    // Prompts: logical name, URL in dev (source), URL in prod (target)
    mockInput
      .mockResolvedValueOnce('api_base')
      .mockResolvedValueOnce('https://api.dev.example.com')
      .mockResolvedValueOnce('https://api.example.com');

    await runUrlMap([], {});

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base'].values).toEqual({
      dev: 'https://api.dev.example.com',
      prod: 'https://api.example.com',
    });
  });

  it('suggested key defaults to hostname slug when logical name prompt is empty', async () => {
    setupBase();
    mockExtractUrls.mockReturnValue([
      {
        value: 'https://api.dev.example.com/v1',
        hostname: 'api.dev.example.com',
        env: 'dev',
        workflowNames: ['WF'],
      },
    ]);
    // Empty logical name → falls back to hostname slug 'api_dev_example_com'
    mockInput
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('https://api.dev.example.com/v1')
      .mockResolvedValueOnce('');

    await runUrlMap([], {});

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_dev_example_com']).toBeDefined();
  });

  it('writes an audit entry after interactive mapping', async () => {
    setupBase();
    mockExtractUrls.mockReturnValue([
      {
        value: 'https://api.dev.example.com',
        hostname: 'api.dev.example.com',
        env: 'dev',
        workflowNames: ['WF'],
      },
    ]);
    mockInput
      .mockResolvedValueOnce('api_base')
      .mockResolvedValueOnce('https://api.dev.example.com')
      .mockResolvedValueOnce('https://api.example.com');

    await runUrlMap([], {});

    const auditLine = (vol.readFileSync(`${PROJECT_DIR}/.chiral/audit.jsonl`, 'utf-8') as string)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.action === 'map');
    expect(auditLine).toBeDefined();
    expect(auditLine.action).toBe('map');
  });

  it('prints adopt hint and writes nothing when no snapshots', async () => {
    setupBase();
    mockExtractUrls.mockReturnValue([]);
    mockListDeployments.mockReturnValue([]);
    const logSpy = vi.spyOn(console, 'log');

    await runUrlMap([], {});

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls).toEqual({});
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/adopt/);
  });

  it('emits candidates as JSON with --json without prompting', async () => {
    setupBase();
    mockExtractUrls.mockReturnValue([
      {
        value: 'https://api.dev.example.com',
        hostname: 'api.dev.example.com',
        env: 'dev',
        workflowNames: ['WF'],
      },
    ]);
    const logSpy = vi.spyOn(console, 'log');

    await runUrlMap([], { json: true });

    expect(mockInput).not.toHaveBeenCalled();
    const jsonLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => {
        try { JSON.parse(l); return true; } catch { return false; }
      });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.candidates).toHaveLength(1);
    expect(parsed.data.candidates[0].suggested_key).toBe('api_dev_example_com');
  });

  it('skips already-mapped URLs', async () => {
    setupBase(
      JSON.stringify({
        version: 1,
        urls: {
          api_base: { values: { dev: 'https://api.dev.example.com' } },
        },
      }),
    );
    mockExtractUrls.mockReturnValue([
      {
        value: 'https://api.dev.example.com',
        hostname: 'api.dev.example.com',
        env: 'dev',
        workflowNames: ['WF'],
      },
    ]);

    await runUrlMap([], {});

    // No prompts called because it's already mapped
    expect(mockInput).not.toHaveBeenCalled();
  });
});

// ── runUrlList ────────────────────────────────────────────────────────────────

const POPULATED_URL_MAP = JSON.stringify({
  version: 1,
  urls: {
    api_base: {
      exact: false,
      values: { dev: 'https://api.dev.example.com', prod: 'https://api.example.com' },
    },
    webhook: {
      values: { dev: 'https://hooks.dev.example.com' },
    },
  },
});

describe('runUrlList', () => {
  it('prints empty hint when no entries', async () => {
    setupBase();
    const logSpy = vi.spyOn(console, 'log');

    await runUrlList({});

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/No URL mappings/);
  });

  it('renders table with all logical names and env columns', async () => {
    setupBase(POPULATED_URL_MAP);
    const logSpy = vi.spyOn(console, 'log');

    await runUrlList({});

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/api_base/);
    expect(output).toMatch(/webhook/);
    expect(output).toMatch(/api\.dev\.example\.com/);
    expect(output).toMatch(/api\.example\.com/);
    expect(output).toMatch(/\(not set\)/);
  });

  it('--env prod filters to prod-bearing entries only', async () => {
    setupBase(POPULATED_URL_MAP);
    const logSpy = vi.spyOn(console, 'log');

    await runUrlList({ env: 'prod' });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/api_base/);
    // webhook has no prod value, so it should be filtered out
    expect(output).not.toMatch(/webhook/);
  });

  it('throws UserError for unknown --env', async () => {
    setupBase(POPULATED_URL_MAP);

    await expect(runUrlList({ env: 'staging' })).rejects.toBeInstanceOf(UserError);
  });

  it('--json emits { status, data: { urls } } envelope with exact field', async () => {
    setupBase(POPULATED_URL_MAP);
    const logSpy = vi.spyOn(console, 'log');

    await runUrlList({ json: true });

    const jsonLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => {
        try { JSON.parse(l); return true; } catch { return false; }
      });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.urls).toBeDefined();
    expect(parsed.data.urls['api_base'].exact).toBe(false);
    expect(parsed.data.urls['api_base'].values).toEqual({
      dev: 'https://api.dev.example.com',
      prod: 'https://api.example.com',
    });
  });

  it('--json with --env filters the output', async () => {
    setupBase(POPULATED_URL_MAP);
    const logSpy = vi.spyOn(console, 'log');

    await runUrlList({ env: 'prod', json: true });

    const jsonLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => {
        try { JSON.parse(l); return true; } catch { return false; }
      });
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.data.urls['api_base']).toBeDefined();
    expect(parsed.data.urls['webhook']).toBeUndefined();
  });
});

// ── runUrlUnmap ───────────────────────────────────────────────────────────────

const TWO_ENV_URL_MAP = JSON.stringify({
  version: 1,
  urls: {
    api_base: {
      values: { dev: 'https://api.dev.example.com', prod: 'https://api.example.com' },
    },
    webhook: {
      values: { dev: 'https://hooks.dev.example.com' },
    },
  },
});

describe('runUrlUnmap', () => {
  it('removes entire entry with --yes', async () => {
    setupBase(TWO_ENV_URL_MAP);
    await runUrlUnmap('api_base', { yes: true });

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base']).toBeUndefined();
    expect(written.urls['webhook']).toBeDefined();
  });

  it('removes only the specified --env and leaves sibling envs', async () => {
    setupBase(TWO_ENV_URL_MAP);
    await runUrlUnmap('api_base', { env: 'dev' });

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base'].values['dev']).toBeUndefined();
    expect(written.urls['api_base'].values['prod']).toBe('https://api.example.com');
  });

  it('prunes entry when --env removes the last env', async () => {
    setupBase(TWO_ENV_URL_MAP);
    await runUrlUnmap('webhook', { env: 'dev' });

    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['webhook']).toBeUndefined();
  });

  it('throws UserError for missing logical name', async () => {
    setupBase(TWO_ENV_URL_MAP);
    await expect(runUrlUnmap('nonexistent', { yes: true })).rejects.toBeInstanceOf(UserError);
  });

  it('throws UserError for missing --env within existing entry', async () => {
    setupBase(TWO_ENV_URL_MAP);
    await expect(runUrlUnmap('api_base', { env: 'staging' })).rejects.toBeInstanceOf(UserError);
  });

  it('skips confirmation prompt with --yes', async () => {
    setupBase(TWO_ENV_URL_MAP);
    await runUrlUnmap('api_base', { yes: true });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('prompts for confirmation without --yes and cancels on false', async () => {
    setupBase(TWO_ENV_URL_MAP);
    mockConfirm.mockResolvedValueOnce(false);

    await runUrlUnmap('api_base', {});

    expect(mockConfirm).toHaveBeenCalled();
    const written = JSON.parse(
      vol.readFileSync(`${PROJECT_DIR}/.chiral/url-map.json`, 'utf-8') as string,
    );
    expect(written.urls['api_base']).toBeDefined();
  });

  it('writes audit entry with action unmap', async () => {
    setupBase(TWO_ENV_URL_MAP);
    await runUrlUnmap('api_base', { yes: true });

    const auditLine = (vol.readFileSync(`${PROJECT_DIR}/.chiral/audit.jsonl`, 'utf-8') as string)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.action === 'unmap');
    expect(auditLine).toBeDefined();
    expect(auditLine.action).toBe('unmap');
  });

  it('--json emits { status, data: { logical_name, removed_envs } }', async () => {
    setupBase(TWO_ENV_URL_MAP);
    const logSpy = vi.spyOn(console, 'log');

    await runUrlUnmap('api_base', { yes: true, json: true });

    const jsonLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => {
        try { JSON.parse(l); return true; } catch { return false; }
      });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.logical_name).toBe('api_base');
    expect(parsed.data.removed_envs).toEqual(expect.arrayContaining(['dev', 'prod']));
  });
});
