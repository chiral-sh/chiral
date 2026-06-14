import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli } from './helpers/cli.js';
import { parseConfigExample } from '../../src/lib/config.js';
import { RUN_ID_PREFIX } from './constants.js';

describe('chiral init (integration)', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'chiral-it-projects-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('scaffolds .chiral/, registers the project, and exits 0 with --json', async () => {
    const projectName = `${RUN_ID_PREFIX}-init`;

    const result = await runCli(['init', projectName, '--json', '--no-install-completion'], {
      env: { CHIRAL_PROJECTS_DIR: projectsDir },
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as { status: string; data: { project: string; path: string; created: boolean } };
    expect(parsed.status).toBe('ok');
    expect(parsed.data.project).toBe(projectName);
    expect(parsed.data.created).toBe(true);

    const chiralDir = join(parsed.data.path, '.chiral');
    expect(existsSync(join(chiralDir, 'config.example.json'))).toBe(true);
    expect(existsSync(join(chiralDir, 'audit.jsonl'))).toBe(true);

    const example = parseConfigExample(chiralDir);
    expect(example.project).toBe(projectName);
    expect(Object.keys(example.envs)).toContain('dev');
  });

  it('exits 1 with no second project created when the project name already exists', async () => {
    const projectName = `${RUN_ID_PREFIX}-init-dup`;

    const first = await runCli(['init', projectName, '--json', '--no-install-completion'], {
      env: { CHIRAL_PROJECTS_DIR: projectsDir },
    });
    expect(first.exitCode).toBe(0);

    const second = await runCli(['init', projectName, '--json', '--no-install-completion'], {
      env: { CHIRAL_PROJECTS_DIR: projectsDir },
    });

    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('already exists');
    expect(second.stdout).toBe('');
  });
});
