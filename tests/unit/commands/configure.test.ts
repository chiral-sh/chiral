import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    yellow: (s: string) => s,
  },
}));

const mockSpinner = {
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
};
vi.mock('ora', () => ({ default: vi.fn(() => mockSpinner) }));

vi.mock('../../../src/lib/n8n-client.js', () => ({ N8nClient: vi.fn() }));

import { input, password, confirm } from '@inquirer/prompts';
import { N8nClient } from '../../../src/lib/n8n-client.js';
import { runConfigure } from '../../../src/commands/configure.js';

const mockInput = vi.mocked(input);
const mockPassword = vi.mocked(password);
const mockConfirm = vi.mocked(confirm);
const MockN8nClient = vi.mocked(N8nClient);

const VALID_CONFIG = JSON.stringify({
  version: 1,
  project: 'my-project',
  environments: { dev: { url: 'https://dev.n8n.example.com', apiKey: 'existing-key' } },
});

const EXAMPLE_CONFIG = JSON.stringify({
  version: 1,
  project: 'example-project',
  environments: {},
});

function makeClientMock(workflowCount = 5) {
  return { testConnection: vi.fn().mockResolvedValue({ workflowCount }) };
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockSpinner.start.mockReturnThis();
  mockSpinner.succeed.mockReturnThis();
  mockSpinner.fail.mockReturnThis();
});

describe('runConfigure', () => {
  it('throws UserError when no .chiral/ directory exists', async () => {
    vol.fromJSON({});
    await expect(runConfigure({}, '/project')).rejects.toThrow(UserError);
    await expect(runConfigure({}, '/project')).rejects.toThrow('chiral init');
  });

  it('reads project name from config.example.json when config.json is absent', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://n8n.example.com');
    mockPassword.mockResolvedValueOnce('my-key');
    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    mockConfirm.mockResolvedValueOnce(false);

    await runConfigure({}, '/project');

    const written = vol.readFileSync('/project/.chiral/config.json', 'utf-8') as string;
    expect(JSON.parse(written).project).toBe('example-project');
  });

  it('falls back to my-project when config.example.json is also absent', async () => {
    vol.fromJSON({ '/project/.chiral/': null });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://n8n.example.com');
    mockPassword.mockResolvedValueOnce('my-key');
    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    mockConfirm.mockResolvedValueOnce(false);

    await runConfigure({}, '/project');

    const written = vol.readFileSync('/project/.chiral/config.json', 'utf-8') as string;
    expect(JSON.parse(written).project).toBe('my-project');
  });

  it('loads and displays existing config when config.json exists', async () => {
    vol.fromJSON({ '/project/.chiral/config.json': VALID_CONFIG });
    mockInput.mockResolvedValueOnce('prod').mockResolvedValueOnce('https://prod.n8n.example.com');
    mockPassword.mockResolvedValueOnce('prod-key');
    MockN8nClient.mockImplementation(() => makeClientMock(8) as never);
    mockConfirm.mockResolvedValueOnce(false);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => output.push(a.join(' ')));

    await runConfigure({}, '/project');

    vi.mocked(console.log).mockRestore();
    expect(output.some((l) => l.includes('dev'))).toBe(true);
  });

  it('writes config.json with new environment on success', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce('test-api-key');
    MockN8nClient.mockImplementation(() => makeClientMock(3) as never);
    mockConfirm.mockResolvedValueOnce(false);

    await runConfigure({}, '/project');

    const written = JSON.parse(vol.readFileSync('/project/.chiral/config.json', 'utf-8') as string);
    expect(written.environments.dev.url).toBe('https://dev.n8n.example.com');
    expect(written.environments.dev.apiKey).toBe('test-api-key');
    expect(written.version).toBe(1);
  });

  it('writes config.json with 0600 permissions', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce('test-key');
    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    mockConfirm.mockResolvedValueOnce(false);

    await runConfigure({}, '/project');

    const stat = vol.statSync('/project/.chiral/config.json');
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('uses --env flag to skip env name prompt', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput.mockResolvedValueOnce('https://staging.n8n.example.com');
    mockPassword.mockResolvedValueOnce('staging-key');
    MockN8nClient.mockImplementation(() => makeClientMock(2) as never);

    await runConfigure({ env: 'staging' }, '/project');

    const written = JSON.parse(vol.readFileSync('/project/.chiral/config.json', 'utf-8') as string);
    expect(written.environments.staging).toBeDefined();
    // input should only have been called once (for URL, not for env name)
    expect(mockInput).toHaveBeenCalledTimes(1);
  });

  it('keeps existing API key when password input is empty', async () => {
    vol.fromJSON({ '/project/.chiral/config.json': VALID_CONFIG });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce(''); // empty → keep existing
    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    mockConfirm.mockResolvedValueOnce(false);

    await runConfigure({}, '/project');

    const written = JSON.parse(vol.readFileSync('/project/.chiral/config.json', 'utf-8') as string);
    expect(written.environments.dev.apiKey).toBe('existing-key');
  });

  it('preserves licenseKey from existing config', async () => {
    const configWithLicense = JSON.stringify({
      version: 1,
      project: 'my-project',
      environments: { dev: { url: 'https://dev.n8n.example.com', apiKey: 'key' } },
      licenseKey: 'eyJhbGciOiJSUzI1NiJ9.test',
    });
    vol.fromJSON({ '/project/.chiral/config.json': configWithLicense });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce('key');
    MockN8nClient.mockImplementation(() => makeClientMock() as never);
    mockConfirm.mockResolvedValueOnce(false);

    await runConfigure({}, '/project');

    const written = JSON.parse(vol.readFileSync('/project/.chiral/config.json', 'utf-8') as string);
    expect(written.licenseKey).toBe('eyJhbGciOiJSUzI1NiJ9.test');
  });

  it('skips connection test when --skip-test is set', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce('key');
    mockConfirm.mockResolvedValueOnce(false);

    await runConfigure({ skipTest: true }, '/project');

    expect(MockN8nClient).not.toHaveBeenCalled();
    expect(mockSpinner.start).not.toHaveBeenCalled();
  });

  it('shows spinner and calls testConnection during connection test', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce('key');
    MockN8nClient.mockImplementation(() => makeClientMock(7) as never);
    mockConfirm.mockResolvedValueOnce(false);

    await runConfigure({}, '/project');

    expect(mockSpinner.start).toHaveBeenCalled();
    expect(mockSpinner.succeed).toHaveBeenCalled();
  });

  it('shows failure and asks to save anyway when connection test fails', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce('bad-key');
    MockN8nClient.mockImplementation(() => ({
      testConnection: vi.fn().mockRejectedValue(new UserError('API key for dev is invalid or expired')),
    }) as never);
    mockConfirm
      .mockResolvedValueOnce(true)  // save anyway
      .mockResolvedValueOnce(false); // add another

    await runConfigure({}, '/project');

    expect(mockSpinner.fail).toHaveBeenCalled();
    const written = JSON.parse(vol.readFileSync('/project/.chiral/config.json', 'utf-8') as string);
    expect(written.environments.dev).toBeDefined();
  });

  it('skips env and continues loop when connection fails and user declines save', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    // First env: fails, don't save
    mockInput
      .mockResolvedValueOnce('dev')
      .mockResolvedValueOnce('https://bad.n8n.example.com')
      // Second env
      .mockResolvedValueOnce('prod')
      .mockResolvedValueOnce('https://prod.n8n.example.com');
    mockPassword
      .mockResolvedValueOnce('bad-key')
      .mockResolvedValueOnce('good-key');
    MockN8nClient
      .mockImplementationOnce(() => ({
        testConnection: vi.fn().mockRejectedValue(new UserError('connection refused')),
      }) as never)
      .mockImplementationOnce(() => makeClientMock(4) as never);
    mockConfirm
      .mockResolvedValueOnce(false) // don't save failing env
      .mockResolvedValueOnce(true)  // add another
      .mockResolvedValueOnce(false); // done after prod

    await runConfigure({}, '/project');

    const written = JSON.parse(vol.readFileSync('/project/.chiral/config.json', 'utf-8') as string);
    expect(written.environments.dev).toBeUndefined();
    expect(written.environments.prod).toBeDefined();
  });

  it('loops for multiple environments when user confirms add another', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput
      .mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com')
      .mockResolvedValueOnce('prod').mockResolvedValueOnce('https://prod.n8n.example.com');
    mockPassword.mockResolvedValueOnce('dev-key').mockResolvedValueOnce('prod-key');
    MockN8nClient.mockImplementation(() => makeClientMock(3) as never);
    mockConfirm
      .mockResolvedValueOnce(true)  // add another after dev
      .mockResolvedValueOnce(false); // stop after prod

    await runConfigure({}, '/project');

    const written = JSON.parse(vol.readFileSync('/project/.chiral/config.json', 'utf-8') as string);
    expect(Object.keys(written.environments)).toEqual(['dev', 'prod']);
  });

  it('throws UserError when API key is empty and no existing key to fall back to', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce(''); // empty, no existing

    await expect(runConfigure({}, '/project')).rejects.toThrow(
      new UserError('API key is required'),
    );
  });

  it('shows connected status in summary when env is retried after a failed attempt', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    // First attempt: dev fails, user declines save, tries dev again and succeeds
    mockInput
      .mockResolvedValueOnce('dev').mockResolvedValueOnce('https://bad.n8n.example.com')
      .mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce('bad-key').mockResolvedValueOnce('good-key');
    MockN8nClient
      .mockImplementationOnce(() => ({
        testConnection: vi.fn().mockRejectedValue(new UserError('refused')),
      }) as never)
      .mockImplementationOnce(() => makeClientMock(5) as never);
    mockConfirm
      .mockResolvedValueOnce(false) // don't save failing attempt
      .mockResolvedValueOnce(true)  // add another
      .mockResolvedValueOnce(false); // done

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => output.push(a.join(' ')));
    await runConfigure({}, '/project');
    vi.mocked(console.log).mockRestore();

    // summary should show connected (5 workflows), not "not tested" from the skipped attempt
    expect(output.some((l) => l.includes('5 workflow'))).toBe(true);
  });

  it('does nothing and exits cleanly when all envs are skipped', async () => {
    vol.fromJSON({ '/project/.chiral/config.example.json': EXAMPLE_CONFIG });
    mockInput.mockResolvedValueOnce('dev').mockResolvedValueOnce('https://dev.n8n.example.com');
    mockPassword.mockResolvedValueOnce('bad-key');
    MockN8nClient.mockImplementation(() => ({
      testConnection: vi.fn().mockRejectedValue(new UserError('refused')),
    }) as never);
    mockConfirm
      .mockResolvedValueOnce(false) // don't save
      .mockResolvedValueOnce(false); // no more envs

    await runConfigure({}, '/project');

    expect(vol.existsSync('/project/.chiral/config.json')).toBe(false);
  });
});
