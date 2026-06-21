import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { UserError, ControlledExit } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../../src/lib/n8n-client.js', () => ({
  N8nClient: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { N8nClient } from '../../../src/lib/n8n-client.js';
import { runDoctor } from '../../../src/commands/doctor.js';

const mockExecSync = vi.mocked(execSync);
const MockN8nClient = vi.mocked(N8nClient);

const PROJECT_DIR = '/project';
const CHIRAL_DIR = `${PROJECT_DIR}/.chiral`;

const VALID_CONFIG = JSON.stringify({
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'dev-key' },
    prod: { url: 'https://prod.n8n.example.com', apiKey: 'prod-key' },
  },
});

const SINGLE_ENV_CONFIG = JSON.stringify({
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'dev-key' },
  },
});

const DUPLICATE_URL_CONFIG = JSON.stringify({
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://shared.n8n.example.com', apiKey: 'dev-key' },
    staging: { url: 'https://shared.n8n.example.com', apiKey: 'staging-key' },
  },
});

const INVALID_CONFIG = JSON.stringify({ version: 2, project: 'test', environments: { dev: { url: 'https://x.com', apiKey: 'k' } } });
const BAD_JSON_CONFIG = '{ not json }';

function makeClientMock(testConnectionImpl: () => Promise<{ workflowCount: number; n8nVersion?: string }>) {
  MockN8nClient.mockImplementation(function() {
    return {
      testConnection: vi.fn().mockImplementation(testConnectionImpl),
      warnIfExpiringSoon: vi.fn(),
    };
  } as never);
}

function setupGitAndNode() {
  mockExecSync.mockImplementation((cmd: string) => {
    if ((cmd as string).startsWith('git --version')) return 'git version 2.43.0';
    if ((cmd as string).startsWith('git config user.email')) return 'alice@example.com\n';
    throw new Error(`unexpected execSync: ${cmd}`);
  });
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  setupGitAndNode();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── n8n-client testConnection n8nVersion tests ────────────────────────────────

describe('N8nClient.testConnection n8nVersion', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns n8nVersion string when x-n8n-version header present', async () => {
    const { N8nClient: RealClient } = await vi.importActual<typeof import('../../../src/lib/n8n-client.js')>('../../../src/lib/n8n-client.js');
    let call = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      call++;
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK',
        headers: { get: (name: string) => name === 'x-n8n-version' && call === 1 ? '1.5.0' : null },
        json: () => Promise.resolve({ data: [], nextCursor: null }),
      });
    }));
    const client = new RealClient({ url: 'https://n8n.example.com', apiKey: 'k' }, 'dev');
    const result = await client.testConnection();
    expect(result.n8nVersion).toBe('1.5.0');
  });

  it('returns undefined n8nVersion when x-n8n-version header absent', async () => {
    const { N8nClient: RealClient } = await vi.importActual<typeof import('../../../src/lib/n8n-client.js')>('../../../src/lib/n8n-client.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => null },
      json: () => Promise.resolve({ data: [], nextCursor: null }),
    }));
    const client = new RealClient({ url: 'https://n8n.example.com', apiKey: 'k' }, 'dev');
    const result = await client.testConnection();
    expect(result.n8nVersion).toBeUndefined();
  });
});

// ── git-installed check ───────────────────────────────────────────────────────

describe('git-installed check', () => {
  it('emits git-installed: fail when execSync throws', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 3 }));
    mockExecSync.mockImplementation((cmd: string) => {
      if ((cmd as string).startsWith('git --version')) throw new Error('not found');
      if ((cmd as string).startsWith('git config user.email')) return 'alice@example.com\n';
      throw new Error(`unexpected: ${cmd}`);
    });

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await expect(runDoctor({}, PROJECT_DIR)).rejects.toThrow(ControlledExit);
    expect(logs.some(l => l.includes('git not found') || l.includes('git installed'))).toBe(true);
  });

  it('emits git-installed: pass with version string', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 3 }));

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await runDoctor({}, PROJECT_DIR);
    expect(logs.some(l => l.includes('git version 2.43.0'))).toBe(true);
  });
});

// ── git-email check ───────────────────────────────────────────────────────────

describe('git-email check', () => {
  it('does not emit git-email when git-installed failed', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 3 }));
    mockExecSync.mockImplementation((cmd: string) => {
      if ((cmd as string).startsWith('git --version')) throw new Error('not found');
      throw new Error(`unexpected: ${cmd}`);
    });

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await expect(runDoctor({}, PROJECT_DIR)).rejects.toThrow(ControlledExit);
    expect(logs.some(l => l.includes('git-email') || l.includes('git email'))).toBe(false);
  });
});

// ── node-version check ────────────────────────────────────────────────────────

describe('node-version check', () => {
  it('emits node-version: fail when Node major < 20', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 3 }));
    Object.defineProperty(process, 'version', { value: 'v18.0.0', configurable: true });

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await expect(runDoctor({}, PROJECT_DIR)).rejects.toThrow(ControlledExit);
    expect(logs.some(l => l.includes('v18.0.0'))).toBe(true);

    Object.defineProperty(process, 'version', { value: 'v22.0.0', configurable: true });
  });

  it('emits node-version: pass when Node major >= 20', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 3 }));
    Object.defineProperty(process, 'version', { value: 'v22.2.0', configurable: true });

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await runDoctor({}, PROJECT_DIR);
    expect(logs.some(l => l.includes('v22.2.0') && l.includes('required'))).toBe(true);
  });
});

// ── project-directory check ───────────────────────────────────────────────────

describe('project-directory check', () => {
  it('emits project-directory: warn when .chiral not found', async () => {
    // no memfs files — loadConfigAndDir throws "No .chiral/config.json found"
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await runDoctor({}, PROJECT_DIR);
    expect(logs.some(l => l.includes('project directory') || l.includes('project-directory'))).toBe(true);
    // warn doesn't throw ControlledExit, so we get here
  });

  it('emits config-valid: fail when config has Zod validation error', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: INVALID_CONFIG });

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await expect(runDoctor({}, PROJECT_DIR)).rejects.toThrow(ControlledExit);
    expect(logs.some(l => l.includes('config schema valid') || l.includes('config-valid'))).toBe(true);
  });

  it('emits config-json: fail when config.json is malformed JSON', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: BAD_JSON_CONFIG });

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await expect(runDoctor({}, PROJECT_DIR)).rejects.toThrow(ControlledExit);
    expect(logs.some(l => l.includes('config.json present') || l.includes('config-json'))).toBe(true);
  });
});

// ── connectivity check skipped when config not loaded ─────────────────────────

describe('connectivity checks', () => {
  it('skips connectivity checks when configLoaded is false', async () => {
    // no config file — connectivity should be skipped
    await runDoctor({}, PROJECT_DIR);
    expect(MockN8nClient).not.toHaveBeenCalled();
  });

  it('emits no-duplicate-urls: warn when two envs share the same URL', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: DUPLICATE_URL_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 5 }));

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await runDoctor({}, PROJECT_DIR);
    expect(logs.some(l => l.includes('no duplicate URLs') || l.includes('no-duplicate-urls'))).toBe(true);
    expect(logs.some(l => l.includes('share the same URL'))).toBe(true);
  });

  it('emits env-dev-reachable: fail and throws ControlledExit(5) on ECONNREFUSED', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    const networkErr = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    makeClientMock(() => Promise.reject(networkErr));

    await expect(runDoctor({}, PROJECT_DIR)).rejects.toMatchObject({ code: 5 });
  });

  it('throws ControlledExit(1) on auth failure (401)', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.reject(new UserError('API key for dev is invalid or expired')));

    await expect(runDoctor({}, PROJECT_DIR)).rejects.toMatchObject({ code: 1 });
  });

  it('emits env-dev-reachable: warn when n8nVersion below min', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 5, n8nVersion: '0.235.0' }));

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await runDoctor({}, PROJECT_DIR);
    expect(logs.some(l => l.includes('0.235.0'))).toBe(true);
    // warning doesn't cause ControlledExit
  });

  it('emits env-dev-reachable: pass when n8nVersion at or above min', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 5, n8nVersion: '1.5.0' }));

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await runDoctor({}, PROJECT_DIR);
    expect(logs.some(l => l.includes('5 workflows found') && !l.includes('below'))).toBe(true);
  });

  it('emits env-dev-reachable: pass when no n8nVersion in response', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 7 }));

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await runDoctor({}, PROJECT_DIR);
    expect(logs.some(l => l.includes('7 workflows found'))).toBe(true);
  });
});

// ── exit codes ────────────────────────────────────────────────────────────────

describe('exit codes', () => {
  it('does not throw when all checks pass', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 5 }));

    await expect(runDoctor({}, PROJECT_DIR)).resolves.toBeUndefined();
  });

  it('does not throw when only warnings (version advisory)', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 5, n8nVersion: '0.235.0' }));

    await expect(runDoctor({}, PROJECT_DIR)).resolves.toBeUndefined();
  });

  it('throws ControlledExit(5) for network failure', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    makeClientMock(() => Promise.reject(err));

    await expect(runDoctor({}, PROJECT_DIR)).rejects.toMatchObject({ code: 5 });
  });

  it('throws ControlledExit(1) for required check failure without network', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.reject(new UserError('API key invalid')));

    await expect(runDoctor({}, PROJECT_DIR)).rejects.toMatchObject({ code: 1 });
  });
});

// ── --env flag ────────────────────────────────────────────────────────────────

describe('--env flag', () => {
  it('throws UserError before any checks when env not in config', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: VALID_CONFIG });

    await expect(runDoctor({ env: 'unknown' }, PROJECT_DIR)).rejects.toThrow(UserError);
    await expect(runDoctor({ env: 'unknown' }, PROJECT_DIR)).rejects.toThrow('Unknown environment "unknown"');
    expect(MockN8nClient).not.toHaveBeenCalled();
  });

  it('runs connectivity for only the specified env', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: VALID_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 5 }));

    await runDoctor({ env: 'dev' }, PROJECT_DIR);
    expect(MockN8nClient).toHaveBeenCalledTimes(1);
    expect(MockN8nClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://dev.n8n.example.com' }),
      'dev',
    );
  });
});

// ── --quiet flag ──────────────────────────────────────────────────────────────

describe('--quiet flag', () => {
  it('omits passing check lines but prints warn/fail and summary', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 5, n8nVersion: '0.235.0' }));

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logs.push(s); });

    await runDoctor({ quiet: true }, PROJECT_DIR);

    // warn line for n8n version is shown
    expect(logs.some(l => l.includes('0.235.0'))).toBe(true);
    // passing lines like "git installed" are suppressed
    expect(logs.some(l => l.includes('git version 2.43.0'))).toBe(false);
    // summary always shown
    expect(logs.some(l => l.includes('passed') && l.includes('warning'))).toBe(true);
  });
});

// ── --json flag ───────────────────────────────────────────────────────────────

describe('--json flag', () => {
  it('emits status:ok with checks array and summary', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 5 }));

    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logged.push(s); });

    await runDoctor({ json: true }, PROJECT_DIR);

    const output = JSON.parse(logged[0]) as { status: string; data: { checks: unknown[]; summary: { pass: number; warn: number; fail: number } } };
    expect(output.status).toBe('ok');
    expect(Array.isArray(output.data.checks)).toBe(true);
    expect(output.data.summary).toMatchObject({ fail: 0 });
    // _isNetworkError should not be in JSON output
    expect(JSON.stringify(output)).not.toContain('_isNetworkError');
  });

  it('emits status:ok even when checks fail', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    const err = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    makeClientMock(() => Promise.reject(err));

    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logged.push(s); });

    await expect(runDoctor({ json: true }, PROJECT_DIR)).rejects.toMatchObject({ code: 5 });

    const output = JSON.parse(logged[0]) as { status: string; data: { summary: { fail: number } } };
    expect(output.status).toBe('ok');
    expect(output.data.summary.fail).toBeGreaterThan(0);
  });

  it('ignores --quiet and always emits full checks array in JSON mode', async () => {
    vol.fromJSON({ [`${CHIRAL_DIR}/config.json`]: SINGLE_ENV_CONFIG });
    makeClientMock(() => Promise.resolve({ workflowCount: 5 }));

    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((s: unknown) => { if (typeof s === 'string') logged.push(s); });

    await runDoctor({ json: true, quiet: true }, PROJECT_DIR);

    const output = JSON.parse(logged[0]) as { data: { checks: unknown[] } };
    // all checks present, including passing ones
    expect(output.data.checks.length).toBeGreaterThan(3);
  });
});
