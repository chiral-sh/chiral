import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

vi.mock('../../../src/lib/n8n-client.js', () => ({
  N8nClient: vi.fn(),
}));

import { input, password } from '@inquirer/prompts';
import { N8nClient } from '../../../src/lib/n8n-client.js';
import { runEnvironmentConfigure } from '../../../src/commands/environment.js';

const mockInput = vi.mocked(input);
const mockPassword = vi.mocked(password);
const MockN8nClient = vi.mocked(N8nClient);

const GLOBAL_DIR = '/mock-global';
const PROJECTS_DIR = '/mock-global/projects';
const PROJECT_DIR = '/mock-global/projects/my-project';
const CHIRAL_DIR = `${PROJECT_DIR}/.chiral`;

const BASE_CONFIG = JSON.stringify({
  version: 1,
  project: 'my-project',
  environments: {
    deva: { url: 'http://10.255.255.254:5678', apiKey: 'old-key' },
    prod: { url: 'http://10.255.255.254:5679', apiKey: 'prod-key' },
  },
});

const BASE_CONFIG_EXAMPLE = JSON.stringify({
  version: 1,
  project: 'my-project',
  environments: {
    deva: { url: 'http://10.255.255.254:5678', apiKey: 'YOUR_DEVA_API_KEY' },
    prod: { url: 'http://10.255.255.254:5679', apiKey: 'YOUR_PROD_API_KEY' },
  },
});

const GLOBAL_INDEX = JSON.stringify({
  version: 1,
  projects: {
    'my-project': { path: PROJECT_DIR, createdAt: '2024-01-01T00:00:00.000Z' },
  },
});

function setupFs(): void {
  vol.fromJSON({
    [`${PROJECTS_DIR}/index.json`]: GLOBAL_INDEX,
    [`${CHIRAL_DIR}/config.json`]: BASE_CONFIG,
    [`${CHIRAL_DIR}/config.example.json`]: BASE_CONFIG_EXAMPLE,
  });
}

function readEnv(name: string): { url: string; apiKey: string } {
  const config = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/config.json`, 'utf-8') as string);
  return config.environments[name];
}

beforeEach(() => {
  setupFs();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'my-project';
  Object.assign(process.stdout, { isTTY: true });
});

afterEach(() => {
  vol.reset();
  vi.restoreAllMocks();
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
  delete process.env['CHIRAL_URL_DEVA'];
  delete process.env['CHIRAL_API_KEY_DEVA'];
});

describe('runEnvironmentConfigure', () => {
  it('throws when the environment does not exist', async () => {
    await expect(
      runEnvironmentConfigure('nope', { skipTest: true }),
    ).rejects.toThrow(UserError);
  });

  describe('targeted update (one field flag) does not prompt for the other', () => {
    it('updates only the api key when --api-key is passed', async () => {
      await runEnvironmentConfigure('deva', { apiKey: 'new-key', skipTest: true });

      expect(mockInput).not.toHaveBeenCalled();
      expect(mockPassword).not.toHaveBeenCalled();

      const env = readEnv('deva');
      expect(env.apiKey).toBe('new-key');
      expect(env.url).toBe('http://10.255.255.254:5678'); // unchanged
    });

    it('updates only the url when --url is passed', async () => {
      await runEnvironmentConfigure('deva', { url: 'http://10.255.255.254:9999', skipTest: true });

      expect(mockInput).not.toHaveBeenCalled();
      expect(mockPassword).not.toHaveBeenCalled();

      const env = readEnv('deva');
      expect(env.url).toBe('http://10.255.255.254:9999');
      expect(env.apiKey).toBe('old-key'); // unchanged
    });

    it('treats a CHIRAL_URL_* env var as a targeted update (no prompts)', async () => {
      process.env['CHIRAL_URL_DEVA'] = 'http://10.255.255.254:7000';
      await runEnvironmentConfigure('deva', { skipTest: true });

      expect(mockInput).not.toHaveBeenCalled();
      expect(mockPassword).not.toHaveBeenCalled();

      const env = readEnv('deva');
      expect(env.url).toBe('http://10.255.255.254:7000');
      expect(env.apiKey).toBe('old-key');
    });
  });

  describe('interactive update (no field flags) prompts for both', () => {
    it('prompts for url and api key and saves the entered values', async () => {
      mockInput.mockResolvedValue('http://10.255.255.254:8000');
      mockPassword.mockResolvedValue('prompted-key');

      await runEnvironmentConfigure('deva', { skipTest: true });

      expect(mockInput).toHaveBeenCalledOnce();
      expect(mockPassword).toHaveBeenCalledOnce();

      const env = readEnv('deva');
      expect(env.url).toBe('http://10.255.255.254:8000');
      expect(env.apiKey).toBe('prompted-key');
    });

    it('keeps the existing api key when the password prompt is left empty', async () => {
      mockInput.mockResolvedValue('http://10.255.255.254:8000');
      mockPassword.mockResolvedValue('');

      await runEnvironmentConfigure('deva', { skipTest: true });

      expect(readEnv('deva').apiKey).toBe('old-key');
    });
  });

  describe('json mode', () => {
    it('falls back to existing values without prompting', async () => {
      await runEnvironmentConfigure('deva', { apiKey: 'json-key', json: true, skipTest: true });

      expect(mockInput).not.toHaveBeenCalled();
      expect(mockPassword).not.toHaveBeenCalled();

      const env = readEnv('deva');
      expect(env.apiKey).toBe('json-key');
      expect(env.url).toBe('http://10.255.255.254:5678');
    });
  });

  describe('connection test', () => {
    it('tests the connection with the new key against the existing url', async () => {
      const testConnection = vi.fn().mockResolvedValue({ workflowCount: 3 });
      MockN8nClient.mockImplementation(() => ({ testConnection }) as never);

      await runEnvironmentConfigure('deva', { apiKey: 'new-key' });

      expect(MockN8nClient).toHaveBeenCalledWith(
        { url: 'http://10.255.255.254:5678', apiKey: 'new-key' },
        'deva',
      );
      expect(testConnection).toHaveBeenCalledOnce();
      expect(readEnv('deva').apiKey).toBe('new-key');
    });
  });
});
