import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { runClone } from '../../../src/commands/clone.js';
import { UserError, ControlledExit } from '../../../src/lib/errors.js';
import { N8nClient } from '../../../src/lib/n8n-client.js';

// ── Critical: mock node:fs with memfs ─────────────────────────────────────────
vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

// ── Mock child_process (exec async for git clone) ─────────────────────────────
type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn<[string, unknown, ExecCallback], void>(),
}));
vi.mock('node:child_process', () => ({
  exec: mockExec,
}));

// ── Mock N8nClient ────────────────────────────────────────────────────────────
vi.mock('../../../src/lib/n8n-client.js', () => ({
  N8nClient: vi.fn(),
}));

// ── Mock config lib (parseConfigExample, writeConfig) ────────────────────────
vi.mock('../../../src/lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/config.js')>();
  return {
    ...actual,
    parseConfigExample: vi.fn(),
    writeConfig: vi.fn(),
  };
});

// ── Mock projects lib ─────────────────────────────────────────────────────────
vi.mock('../../../src/lib/projects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/projects.js')>();
  return {
    ...actual,
    getProjectsDir: vi.fn(),
    registerProject: vi.fn(),
    writeSession: vi.fn(),
  };
});

// ── Mock audit state (readInitEvent) ─────────────────────────────────────────
vi.mock('../../../src/state/audit.js', () => ({
  readInitEvent: vi.fn().mockReturnValue(null),
}));

// ── Mock inquirer prompts ─────────────────────────────────────────────────────
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
}));

// ── Imports for mock control ──────────────────────────────────────────────────
import { parseConfigExample, writeConfig } from '../../../src/lib/config.js';
import { getProjectsDir, registerProject, writeSession } from '../../../src/lib/projects.js';
import { input, password, confirm } from '@inquirer/prompts';

// ── Test constants ─────────────────────────────────────────────────────────────

const REPO_URL = 'https://github.com/test/acme.git';
const PROJECTS_DIR = '/mock-projects';
const TARGET_DIR = `${PROJECTS_DIR}/acme`;
const CHIRAL_DIR = `${TARGET_DIR}/.chiral`;

const PARSED_EXAMPLE = {
  project: 'acme',
  envs: {
    dev: { url: 'https://dev.n8n.io' },
    prod: { url: undefined },
  },
  gitSync: undefined,
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function setupCloneFs(opts: { chiralDir?: boolean; configJson?: boolean } = {}) {
  const files: Record<string, string | null> = {};
  if (opts.chiralDir !== false) {
    files[`${CHIRAL_DIR}/`] = null;
  }
  if (opts.configJson) {
    files[`${CHIRAL_DIR}/config.json`] = JSON.stringify({ version: 1, project: 'acme', environments: {} });
  }
  vol.fromJSON(files);
}

function mockGitCloneSuccess() {
  mockExec.mockImplementation((cmd: string, _opts: unknown, callback: ExecCallback) => {
    if (cmd.startsWith('git clone')) {
      vol.mkdirSync(CHIRAL_DIR, { recursive: true });
    }
    callback(null, '', '');
  });
}

function mockClientMock(overrides: Partial<{ testConnection: () => Promise<{ workflowCount: number }> }> = {}) {
  return {
    testConnection: vi.fn().mockResolvedValue({ workflowCount: 3 }),
    warnIfExpiringSoon: vi.fn(),
    ...overrides,
  } as unknown as InstanceType<typeof N8nClient>;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();

  vi.mocked(getProjectsDir).mockReturnValue(PROJECTS_DIR);
  vi.mocked(parseConfigExample).mockReturnValue(PARSED_EXAMPLE);
  vi.mocked(writeConfig).mockReturnValue(undefined);
  vi.mocked(registerProject).mockReturnValue(undefined);
  vi.mocked(writeSession).mockReturnValue(undefined);

  const clientMock = mockClientMock();
  vi.mocked(N8nClient).mockImplementation(() => clientMock);

  vi.mocked(input).mockResolvedValue('https://dev.n8n.io');
  vi.mocked(password).mockResolvedValue('test-api-key');

  // Default: process.ppid is truthy (mock it)
  Object.defineProperty(process, 'ppid', { value: 12345, writable: true, configurable: true });
  // Force human mode for most tests
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('runClone', () => {

  describe('git clone invocation', () => {
    it('calls exec with git clone <repoUrl> <targetDir>', async () => {
      mockGitCloneSuccess();

      await runClone(REPO_URL, { skipTest: true, json: false });

      expect(mockExec).toHaveBeenCalledWith(
        `git clone ${REPO_URL} ${TARGET_DIR}`,
        expect.objectContaining({ cwd: expect.any(String) }),
        expect.any(Function),
      );
    });
  });

  describe('directory collision', () => {
    it('throws UserError when target directory already exists before cloning', async () => {
      vol.fromJSON({ [`${TARGET_DIR}/`]: null });

      const err = await runClone(REPO_URL, { skipTest: true }).catch(e => e);
      expect(err).toBeInstanceOf(UserError);
      expect(err.message).toContain('already exists');
    });
  });

  describe('git clone failure', () => {
    it('throws UserError containing guidance when git fails', async () => {
      mockExec.mockImplementation((_cmd: string, _opts: unknown, callback: ExecCallback) => {
        callback(new Error('repository not found'), '', '');
      });

      const err = await runClone(REPO_URL, { skipTest: true }).catch(e => e);
      expect(err).toBeInstanceOf(UserError);
      expect(err.message).toContain(
        'Check that you have access to the repository and the URL is correct.',
      );
    });
  });

  describe('missing .chiral/ directory', () => {
    it('throws UserError with exact message when .chiral/ is absent', async () => {
      mockExec.mockImplementation((_cmd: string, _opts: unknown, callback: ExecCallback) => {
        // Clone succeeds but no .chiral/ is created
        vol.mkdirSync(TARGET_DIR, { recursive: true });
        callback(null, '', '');
      });

      const err = await runClone(REPO_URL, { skipTest: true }).catch(e => e);
      expect(err).toBeInstanceOf(UserError);
      expect(err.message).toContain(
        "This repo doesn't appear to be a chiral project.",
      );
    });
  });

  describe('missing config.example.json', () => {
    it('propagates UserError from parseConfigExample', async () => {
      mockGitCloneSuccess();
      vi.mocked(parseConfigExample).mockImplementation(() => {
        throw new UserError(
          'Found .chiral/ but config.example.json is missing or invalid. Ask a teammate to share it.',
        );
      });

      const err = await runClone(REPO_URL, { skipTest: true }).catch(e => e);
      expect(err).toBeInstanceOf(UserError);
      expect(err.message).toContain(
        'config.example.json is missing or invalid',
      );
    });
  });

  describe('idempotency: config.json already exists', () => {
    it('calls registerProject but skips writeConfig and prompts', async () => {
      mockGitCloneSuccess();
      // After clone, config.json already exists (idempotency scenario)
      mockExec.mockImplementation((_cmd: string, _opts: unknown, callback: ExecCallback) => {
        vol.mkdirSync(CHIRAL_DIR, { recursive: true });
        vol.writeFileSync(
          `${CHIRAL_DIR}/config.json`,
          JSON.stringify({ version: 1, project: 'acme', environments: {} }),
        );
        callback(null, '', '');
      });

      await runClone(REPO_URL, { skipTest: true });

      expect(registerProject).toHaveBeenCalledWith('acme', TARGET_DIR);
      expect(writeConfig).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
    });
  });

  describe('env vars suppress prompts', () => {
    beforeEach(() => {
      mockGitCloneSuccess();
      process.env['CHIRAL_URL_DEV'] = 'https://dev.n8n.io';
      process.env['CHIRAL_API_KEY_DEV'] = 'dev-api-key';
      process.env['CHIRAL_URL_PROD'] = 'https://prod.n8n.io';
      process.env['CHIRAL_API_KEY_PROD'] = 'prod-api-key';
    });

    afterEach(() => {
      delete process.env['CHIRAL_URL_DEV'];
      delete process.env['CHIRAL_API_KEY_DEV'];
      delete process.env['CHIRAL_URL_PROD'];
      delete process.env['CHIRAL_API_KEY_PROD'];
    });

    it('skips prompts and calls writeConfig with env var values when both env vars are set', async () => {
      await runClone(REPO_URL, { skipTest: true });

      expect(input).not.toHaveBeenCalled();
      expect(password).not.toHaveBeenCalled();
      expect(writeConfig).toHaveBeenCalledWith(
        CHIRAL_DIR,
        expect.objectContaining({
          environments: expect.objectContaining({
            dev: { url: 'https://dev.n8n.io', apiKey: 'dev-api-key' },
            prod: { url: 'https://prod.n8n.io', apiKey: 'prod-api-key' },
          }),
        }),
      );
    });
  });

  describe('--json mode with env vars', () => {
    beforeEach(() => {
      mockGitCloneSuccess();
      process.env['CHIRAL_URL_DEV'] = 'https://dev.n8n.io';
      process.env['CHIRAL_API_KEY_DEV'] = 'dev-api-key';
      process.env['CHIRAL_URL_PROD'] = 'https://prod.n8n.io';
      process.env['CHIRAL_API_KEY_PROD'] = 'prod-api-key';
    });

    afterEach(() => {
      delete process.env['CHIRAL_URL_DEV'];
      delete process.env['CHIRAL_API_KEY_DEV'];
      delete process.env['CHIRAL_URL_PROD'];
      delete process.env['CHIRAL_API_KEY_PROD'];
    });

    it('calls writeConfig and outputs JSON envelope with correct fields', async () => {
      const logged: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => logged.push(args.join(' ')));

      await runClone(REPO_URL, { json: true, skipTest: true });

      expect(writeConfig).toHaveBeenCalled();
      const result = JSON.parse(logged.find((l) => l.startsWith('{')) ?? '{}');
      expect(result.status).toBe('ok');
      expect(result.data.project).toBe('acme');
      expect(result.data.path).toBe(TARGET_DIR);
      expect(result.data.environments).toEqual(['dev', 'prod']);
    });
  });

  describe('--json mode with missing env vars', () => {
    it('throws UserError before any prompt when env vars are missing', async () => {
      mockGitCloneSuccess();
      // No CHIRAL_URL_DEV or CHIRAL_API_KEY_DEV set

      const err = await runClone(REPO_URL, { json: true }).catch(e => e);
      expect(err).toBeInstanceOf(UserError);
      expect(err.message).toContain('--json mode requires');
      expect(input).not.toHaveBeenCalled();
    });
  });

  describe('--skip-test', () => {
    it('suppresses the connection test call', async () => {
      mockGitCloneSuccess();
      vi.mocked(input).mockResolvedValue('https://dev.n8n.io');
      vi.mocked(password).mockResolvedValue('my-key');

      await runClone(REPO_URL, { skipTest: true });

      expect(N8nClient).not.toHaveBeenCalled();
    });
  });

  describe('gitSync passthrough', () => {
    it('calls writeConfig with gitSync block from parseConfigExample when present', async () => {
      mockGitCloneSuccess();
      const gitSync = { enabled: true, remote: 'origin', branch: 'main' };
      vi.mocked(parseConfigExample).mockReturnValue({
        ...PARSED_EXAMPLE,
        gitSync,
      });
      process.env['CHIRAL_URL_DEV'] = 'https://dev.n8n.io';
      process.env['CHIRAL_API_KEY_DEV'] = 'dev-api-key';
      process.env['CHIRAL_URL_PROD'] = 'https://prod.n8n.io';
      process.env['CHIRAL_API_KEY_PROD'] = 'prod-api-key';

      await runClone(REPO_URL, { skipTest: true });

      expect(writeConfig).toHaveBeenCalledWith(
        CHIRAL_DIR,
        expect.objectContaining({ gitSync }),
      );

      delete process.env['CHIRAL_URL_DEV'];
      delete process.env['CHIRAL_API_KEY_DEV'];
      delete process.env['CHIRAL_URL_PROD'];
      delete process.env['CHIRAL_API_KEY_PROD'];
    });
  });

  describe('registration on success', () => {
    it('calls registerProject and writeSession with correct project name and path', async () => {
      mockGitCloneSuccess();
      process.env['CHIRAL_URL_DEV'] = 'https://dev.n8n.io';
      process.env['CHIRAL_API_KEY_DEV'] = 'dev-api-key';
      process.env['CHIRAL_URL_PROD'] = 'https://prod.n8n.io';
      process.env['CHIRAL_API_KEY_PROD'] = 'prod-api-key';

      await runClone(REPO_URL, { skipTest: true });

      expect(registerProject).toHaveBeenCalledWith('acme', TARGET_DIR);
      expect(writeSession).toHaveBeenCalledWith(process.ppid, 'acme');

      delete process.env['CHIRAL_URL_DEV'];
      delete process.env['CHIRAL_API_KEY_DEV'];
      delete process.env['CHIRAL_URL_PROD'];
      delete process.env['CHIRAL_API_KEY_PROD'];
    });
  });

  describe('exit codes', () => {
    it('resolves (exit 0) on success', async () => {
      mockGitCloneSuccess();
      process.env['CHIRAL_URL_DEV'] = 'https://dev.n8n.io';
      process.env['CHIRAL_API_KEY_DEV'] = 'dev-api-key';
      process.env['CHIRAL_URL_PROD'] = 'https://prod.n8n.io';
      process.env['CHIRAL_API_KEY_PROD'] = 'prod-api-key';

      await expect(runClone(REPO_URL, { skipTest: true })).resolves.toBeUndefined();

      delete process.env['CHIRAL_URL_DEV'];
      delete process.env['CHIRAL_API_KEY_DEV'];
      delete process.env['CHIRAL_URL_PROD'];
      delete process.env['CHIRAL_API_KEY_PROD'];
    });

    it('throws UserError (exit 1) on git failure', async () => {
      mockExec.mockImplementation((_cmd: string, _opts: unknown, callback: ExecCallback) => {
        callback(new Error('permission denied'), '', '');
      });

      const err = await runClone(REPO_URL, { skipTest: true }).catch(e => e);
      expect(err).toBeInstanceOf(UserError);
    });

    it('throws UserError (exit 1) on missing .chiral/', async () => {
      mockExec.mockImplementation((_cmd: string, _opts: unknown, callback: ExecCallback) => {
        vol.mkdirSync(TARGET_DIR, { recursive: true });
        callback(null, '', '');
      });

      const err = await runClone(REPO_URL, { skipTest: true }).catch(e => e);
      expect(err).toBeInstanceOf(UserError);
    });

    it('throws UserError (exit 1) on missing config.example.json', async () => {
      mockGitCloneSuccess();
      vi.mocked(parseConfigExample).mockImplementation(() => {
        throw new UserError(
          'Found .chiral/ but config.example.json is missing or invalid. Ask a teammate to share it.',
        );
      });

      const err = await runClone(REPO_URL, { skipTest: true }).catch(e => e);
      expect(err).toBeInstanceOf(UserError);
    });

    it('throws ControlledExit (exit 0) when user declines connection test', async () => {
      mockGitCloneSuccess();
      const failingClient = mockClientMock({
        testConnection: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      vi.mocked(N8nClient).mockImplementation(() => failingClient);
      vi.mocked(confirm).mockResolvedValue(false);

      // Use single-env example so only one confirm fires
      vi.mocked(parseConfigExample).mockReturnValue({
        project: 'acme',
        envs: { dev: { url: 'https://dev.n8n.io' } },
        gitSync: undefined,
      });
      vi.mocked(input).mockResolvedValue('https://dev.n8n.io');
      vi.mocked(password).mockResolvedValue('test-key');

      await expect(runClone(REPO_URL, { skipTest: false })).rejects.toThrow(ControlledExit);
    });
  });
});
