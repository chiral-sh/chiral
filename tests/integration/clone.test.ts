import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { runCli } from './helpers/cli.js';
import { getN8n } from './helpers/context.js';
import { createChiralDirectory } from '../../src/state/init.js';
import { loadConfigAndDir } from '../../src/lib/config.js';
import { RUN_ID_PREFIX } from './constants.js';

// Builds a local bare git repo (no network) from a source working tree whose
// content is populated by `populate(dir)`, returning the bare repo's file path.
function buildBareRepo(populate: (dir: string) => void): { bareDir: string; cleanup: () => void } {
  const sourceDir = mkdtempSync(join(tmpdir(), 'chiral-it-clone-src-'));
  const bareDir = mkdtempSync(join(tmpdir(), 'chiral-it-clone-bare-'));

  execSync('git init -b main', { cwd: sourceDir, stdio: 'pipe' });
  execSync('git config user.email "integration-test@chiral.sh"', { cwd: sourceDir, stdio: 'pipe' });
  execSync('git config user.name "Chiral Integration Test"', { cwd: sourceDir, stdio: 'pipe' });

  populate(sourceDir);

  execSync('git add .', { cwd: sourceDir, stdio: 'pipe' });
  execSync('git commit -m "chore: scaffold" --quiet', { cwd: sourceDir, stdio: 'pipe' });

  execSync(`git init --bare "${bareDir}"`, { stdio: 'pipe' });
  // git init --bare defaults HEAD to refs/heads/master regardless of the
  // source branch name - point it at "main" so `git clone` checks out a tree.
  execSync('git symbolic-ref HEAD refs/heads/main', { cwd: bareDir, stdio: 'pipe' });
  execSync(`git remote add origin "${bareDir}"`, { cwd: sourceDir, stdio: 'pipe' });
  execSync('git push origin main', { cwd: sourceDir, stdio: 'pipe' });

  return {
    bareDir,
    cleanup: () => {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
    },
  };
}

function isolateProjectsDir(): { projectsDir: string; env: Record<string, string> } {
  const projectsDir = mkdtempSync(join(tmpdir(), 'chiral-it-clone-projects-'));
  return { projectsDir, env: { CHIRAL_PROJECTS_DIR: projectsDir } };
}

describe('chiral clone (integration)', () => {
  const { url, apiKey } = getN8n();

  it('clones a chiral project repo and writes a real config.json', async () => {
    const project = `${RUN_ID_PREFIX}-clone-ok`;
    const repo = buildBareRepo((dir) => {
      createChiralDirectory(join(dir, '.chiral'), project, undefined, 'integration-test@chiral.sh');
    });
    const { projectsDir, env } = isolateProjectsDir();
    const targetParent = mkdtempSync(join(tmpdir(), 'chiral-it-clone-target-'));
    const targetDir = join(targetParent, 'target');

    try {
      const result = await runCli(
        ['clone', repo.bareDir, '--dir', targetDir, '--json'],
        {
          env: {
            ...env,
            CHIRAL_URL_DEV: url,
            CHIRAL_API_KEY_DEV: apiKey,
            CHIRAL_URL_PROD: url,
            CHIRAL_API_KEY_PROD: apiKey,
          },
        },
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        status: string;
        data: { project: string; path: string; environments: string[]; workflows_found: number };
      };
      expect(parsed.status).toBe('ok');
      expect(parsed.data.project).toBe(project);
      expect(parsed.data.path).toBe(targetDir);
      expect(parsed.data.environments.sort()).toEqual(['dev', 'prod']);
      expect(parsed.data.workflows_found).toBe(0);

      expect(existsSync(join(targetDir, '.git'))).toBe(true);

      const { config } = loadConfigAndDir(targetDir);
      expect(config.project).toBe(project);
      expect(config.environments['dev'].url).toBe(url);
      expect(config.environments['dev'].apiKey).toBe(apiKey);
      expect(config.environments['dev'].apiKey.startsWith('YOUR_')).toBe(false);
    } finally {
      repo.cleanup();
      rmSync(targetParent, { recursive: true, force: true });
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when the repo has no .chiral/ directory', async () => {
    const repo = buildBareRepo((dir) => {
      writeFileSync(join(dir, 'README.md'), '# not a chiral project\n', 'utf-8');
    });
    const { projectsDir, env } = isolateProjectsDir();
    const targetParent = mkdtempSync(join(tmpdir(), 'chiral-it-clone-target-'));
    const targetDir = join(targetParent, 'target');

    try {
      const result = await runCli(['clone', repo.bareDir, '--dir', targetDir], { env });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain('chiral project');
      expect(existsSync(join(targetDir, '.chiral'))).toBe(false);
    } finally {
      repo.cleanup();
      rmSync(targetParent, { recursive: true, force: true });
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});
