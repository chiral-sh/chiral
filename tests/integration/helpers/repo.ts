import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createChiralDirectory } from '../../../src/state/init.js';
import { writeConfig, type Config } from '../../../src/lib/config.js';
import { RUN_ID_PREFIX } from '../constants.js';

export interface MakeRepoOptions {
  url: string;
  apiKey: string;
  envName?: string;
  project?: string;
}

export interface RepoHandle {
  dir: string;
  chiralDir: string;
  cleanup: () => void;
}

const OWNER_EMAIL = 'integration-test@chiral.sh';

/**
 * Creates a temp dir with a real git repo and a scaffolded `.chiral/`
 * directory whose config.json points at a real (non-placeholder) n8n
 * instance, ready to be passed to runCli / loadConfigAndDir.
 */
export function makeRepo(opts: MakeRepoOptions): RepoHandle {
  const envName = opts.envName ?? 'dev';
  const project = opts.project ?? `${RUN_ID_PREFIX}-repo`;

  const dir = mkdtempSync(join(tmpdir(), 'chiral-it-'));

  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "integration-test@chiral.sh"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Chiral Integration Test"', { cwd: dir, stdio: 'pipe' });

  const chiralDir = join(dir, '.chiral');
  createChiralDirectory(chiralDir, project, undefined, OWNER_EMAIL);

  const config: Config = {
    version: 1,
    project,
    environments: {
      [envName]: {
        url: opts.url,
        apiKey: opts.apiKey,
      },
    },
  };
  writeConfig(chiralDir, config);

  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "chore: scaffold chiral project" --quiet', { cwd: dir, stdio: 'pipe' });

  return {
    dir,
    chiralDir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
