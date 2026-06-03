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

import { input } from '@inquirer/prompts';
import { runEnvironmentDelete } from '../../../src/commands/environment.js';

const mockInput = vi.mocked(input);

const GLOBAL_DIR = '/mock-global';
const PROJECTS_DIR = '/mock-global/projects';
const PROJECT_DIR = '/mock-global/projects/my-project';
const CHIRAL_DIR = `${PROJECT_DIR}/.chiral`;

const BASE_CONFIG = JSON.stringify({
  version: 1,
  project: 'my-project',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'dev-key' },
    prod: { url: 'https://prod.n8n.example.com', apiKey: 'prod-key' },
  },
});

const BASE_CONFIG_EXAMPLE = JSON.stringify({
  version: 1,
  project: 'my-project',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'YOUR_DEV_API_KEY' },
    prod: { url: 'https://prod.n8n.example.com', apiKey: 'YOUR_PROD_API_KEY' },
  },
});

const GLOBAL_INDEX = JSON.stringify({
  version: 1,
  projects: {
    'my-project': { path: PROJECT_DIR, createdAt: '2024-01-01T00:00:00.000Z' },
  },
});

const CREDENTIALS = JSON.stringify({
  version: 1,
  credentials: {
    postgres: { dev: 'dev_postgres', prod: 'prod_postgres' },
    sendgrid: { dev: 'dev_sendgrid', prod: 'prod_sendgrid' },
  },
});

const WORKFLOWS = JSON.stringify({
  version: 1,
  workflows: {
    'order-processor': {
      dev: { name: 'Order Processor [DEV]', id: 'abc123' },
      prod: { name: 'Order Processor', id: 'def456' },
    },
    'invoice-sync': {
      dev: { name: 'Invoice Sync', id: 'ghi789' },
    },
  },
});

const FINGERPRINTS = JSON.stringify({
  version: 1,
  envs: {
    dev: { 'wf-1': { name: 'My Workflow', versionId: 'v1', contentHash: 'sha256:abc', structureHash: 'sha256:def', updatedAt: '2024-01-01' } },
    prod: {
      'wf-2': { name: 'Order Processor', versionId: 'v2', contentHash: 'sha256:aaa', structureHash: 'sha256:bbb', updatedAt: '2024-01-01' },
      'wf-3': { name: 'Invoice Sync', versionId: 'v3', contentHash: 'sha256:ccc', structureHash: 'sha256:ddd', updatedAt: '2024-01-01' },
    },
  },
});

function setupFs(overrides: Record<string, string | null> = {}): void {
  const base: Record<string, string> = {
    [`${PROJECTS_DIR}/index.json`]: GLOBAL_INDEX,
    [`${CHIRAL_DIR}/config.json`]: BASE_CONFIG,
    [`${CHIRAL_DIR}/config.example.json`]: BASE_CONFIG_EXAMPLE,
    [`${CHIRAL_DIR}/credentials.json`]: CREDENTIALS,
    [`${CHIRAL_DIR}/workflows.json`]: WORKFLOWS,
    [`${CHIRAL_DIR}/fingerprints.json`]: FINGERPRINTS,
  };
  // Apply overrides: null means delete the key
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete base[k];
    else base[k] = v;
  }
  vol.fromJSON(base);
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'my-project';
  Object.assign(process.stdout, { isTTY: true });
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
});

describe('runEnvironmentDelete', () => {
  describe('validation', () => {
    it('throws when environment does not exist', async () => {
      setupFs();
      await expect(
        runEnvironmentDelete('nonexistent', { yes: true }),
      ).rejects.toThrow(UserError);
    });

    it('throws in json mode without --yes on actual delete', async () => {
      setupFs();
      await expect(
        runEnvironmentDelete('prod', { json: true }),
      ).rejects.toThrow('Pass --yes');
    });
  });

  describe('--dry-run', () => {
    it('returns without modifying any files', async () => {
      setupFs();
      await runEnvironmentDelete('prod', { dryRun: true });

      const config = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/config.json`, 'utf-8') as string);
      expect(config.environments).toHaveProperty('prod');

      const creds = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/credentials.json`, 'utf-8') as string);
      expect(creds.credentials['postgres']).toHaveProperty('prod');
    });

    it('emits json with credential_mappings and workflow_entries lists', async () => {
      setupFs();
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(msg));

      await runEnvironmentDelete('prod', { dryRun: true, json: true });

      const result = JSON.parse(logs[0]);
      expect(result.status).toBe('ok');
      expect(result.data.would_delete).toBe(true);
      expect(result.data.credential_mappings).toEqual(expect.arrayContaining(['postgres', 'sendgrid']));
      expect(result.data.workflow_entries).toEqual(['order-processor']);
      expect(result.data.fingerprints).toBe(2);
    });

    it('reports zero impact when state files have no entries for env', async () => {
      setupFs({
        [`${CHIRAL_DIR}/credentials.json`]: JSON.stringify({ version: 1, credentials: { postgres: { dev: 'dev_postgres' } } }),
        [`${CHIRAL_DIR}/workflows.json`]: JSON.stringify({ version: 1, workflows: { 'order-processor': { dev: { name: 'Order Processor [DEV]' } } } }),
        [`${CHIRAL_DIR}/fingerprints.json`]: JSON.stringify({ version: 1, envs: { dev: {} } }),
      });
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(msg));

      await runEnvironmentDelete('prod', { dryRun: true, json: true });

      const result = JSON.parse(logs[0]);
      expect(result.data.credential_mappings).toHaveLength(0);
      expect(result.data.workflow_entries).toHaveLength(0);
      expect(result.data.fingerprints).toBe(0);
    });
  });

  describe('actual delete', () => {
    it('removes env from config.json with --yes', async () => {
      setupFs();
      await runEnvironmentDelete('prod', { yes: true });

      const config = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/config.json`, 'utf-8') as string);
      expect(config.environments).not.toHaveProperty('prod');
      expect(config.environments).toHaveProperty('dev');
    });

    it('removes env mappings from credentials.json', async () => {
      setupFs();
      await runEnvironmentDelete('prod', { yes: true });

      const creds = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/credentials.json`, 'utf-8') as string);
      expect(creds.credentials['postgres']).not.toHaveProperty('prod');
      expect(creds.credentials['postgres']).toHaveProperty('dev');
      expect(creds.credentials['sendgrid']).not.toHaveProperty('prod');
    });

    it('removes env entries from workflows.json', async () => {
      setupFs();
      await runEnvironmentDelete('prod', { yes: true });

      const wf = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/workflows.json`, 'utf-8') as string);
      expect(wf.workflows['order-processor']).not.toHaveProperty('prod');
      expect(wf.workflows['order-processor']).toHaveProperty('dev');
      expect(wf.workflows['invoice-sync']).toHaveProperty('dev');
    });

    it('removes env block from fingerprints.json', async () => {
      setupFs();
      await runEnvironmentDelete('prod', { yes: true });

      const fp = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/fingerprints.json`, 'utf-8') as string);
      expect(fp.envs).not.toHaveProperty('prod');
      expect(fp.envs).toHaveProperty('dev');
    });

    it('prompts for confirmation without --yes', async () => {
      setupFs();
      mockInput.mockResolvedValue('prod');
      await runEnvironmentDelete('prod', {});

      expect(mockInput).toHaveBeenCalledOnce();
      const config = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/config.json`, 'utf-8') as string);
      expect(config.environments).not.toHaveProperty('prod');
    });

    it('proceeds gracefully when state files are missing', async () => {
      setupFs({
        [`${CHIRAL_DIR}/credentials.json`]: null,
        [`${CHIRAL_DIR}/workflows.json`]: null,
        [`${CHIRAL_DIR}/fingerprints.json`]: null,
      });
      await expect(runEnvironmentDelete('prod', { yes: true })).resolves.toBeUndefined();

      const config = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/config.json`, 'utf-8') as string);
      expect(config.environments).not.toHaveProperty('prod');
    });

    it('emits json confirmation when --json --yes', async () => {
      setupFs();
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(msg));

      await runEnvironmentDelete('prod', { yes: true, json: true });

      const result = JSON.parse(logs[0]);
      expect(result).toEqual({ status: 'ok', data: { env: 'prod', deleted: true } });
    });
  });
});
