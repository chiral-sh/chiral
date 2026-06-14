import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCli } from './helpers/cli.js';
import { makeRepo, type RepoHandle } from './helpers/repo.js';
import { getN8n } from './helpers/context.js';
import { N8nClient, type WorkflowFull } from '../../src/lib/n8n-client.js';
import { readAuditLog } from '../../src/state/audit.js';
import { registerProject } from '../../src/lib/projects.js';
import { RUN_ID_PREFIX } from './constants.js';

// resolveActiveProject() reads the global project registry, not cwd - register
// each temp repo as its own project in an isolated CHIRAL_PROJECTS_DIR and select
// it via CHIRAL_PROJECT so pull operates on the temp repo, not the dev machine's
// real chiral projects.
function registerTempProject(repo: RepoHandle, project: string): { projectsDir: string; env: Record<string, string> } {
  const projectsDir = mkdtempSync(join(tmpdir(), 'chiral-it-projects-'));
  const prev = process.env['CHIRAL_PROJECTS_DIR'];
  process.env['CHIRAL_PROJECTS_DIR'] = projectsDir;
  try {
    registerProject(project, repo.dir);
  } finally {
    if (prev === undefined) delete process.env['CHIRAL_PROJECTS_DIR'];
    else process.env['CHIRAL_PROJECTS_DIR'] = prev;
  }
  return { projectsDir, env: { CHIRAL_PROJECTS_DIR: projectsDir, CHIRAL_PROJECT: project } };
}

function listDeploymentDirs(chiralDir: string): string[] {
  const snapshotsDir = join(chiralDir, 'snapshots');
  return readdirSync(snapshotsDir).sort();
}

describe('chiral pull (integration)', () => {
  const { url, apiKey } = getN8n();
  const client = new N8nClient({ url, apiKey }, 'dev');
  const workflowName = `${RUN_ID_PREFIX}-pull-wf`;
  let workflowId: string;

  beforeAll(async () => {
    const created = await client.createWorkflow({
      name: workflowName,
      nodes: [],
      connections: {},
      settings: {},
    } as unknown as WorkflowFull);
    workflowId = created.id;
  });

  afterAll(async () => {
    await fetch(`${url.replace(/\/$/, '')}/api/v1/workflows/${workflowId}`, {
      method: 'DELETE',
      headers: { 'X-N8N-API-KEY': apiKey },
    });
  });

  it('writes a snapshot + pull audit event, and is hash-stable on a second pull', async () => {
    const project = `${RUN_ID_PREFIX}-pull-ok`;
    const repo: RepoHandle = makeRepo({ url, apiKey, project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const first = await runCli(['pull', '--env', 'dev'], { cwd: repo.dir, env });
      expect(first.exitCode).toBe(0);

      const deploymentsAfterFirst = listDeploymentDirs(repo.chiralDir);
      expect(deploymentsAfterFirst.length).toBeGreaterThan(0);
      const firstDeployment = deploymentsAfterFirst[deploymentsAfterFirst.length - 1];
      const firstSnapshotPath = join(repo.chiralDir, 'snapshots', firstDeployment, `${workflowId}.json`);
      const firstSnapshot = readFileSync(firstSnapshotPath, 'utf-8');

      const audit = readAuditLog(repo.chiralDir);
      const pullEntry = audit.find((e) => e.action === 'pull');
      expect(pullEntry).toBeDefined();
      expect(pullEntry?.result).toBe('success');
      expect(pullEntry?.target_env).toBe('dev');
      expect(pullEntry?.workflow_ids).toContain(workflowId);

      const second = await runCli(['pull', '--env', 'dev'], { cwd: repo.dir, env });
      expect(second.exitCode).toBe(0);

      const deploymentsAfterSecond = listDeploymentDirs(repo.chiralDir);
      expect(deploymentsAfterSecond.length).toBe(deploymentsAfterFirst.length + 1);
      const secondDeployment = deploymentsAfterSecond[deploymentsAfterSecond.length - 1];
      const secondSnapshotPath = join(repo.chiralDir, 'snapshots', secondDeployment, `${workflowId}.json`);
      const secondSnapshot = readFileSync(secondSnapshotPath, 'utf-8');

      expect(secondSnapshot).toBe(firstSnapshot);
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when the n8n environment is unreachable', async () => {
    const project = `${RUN_ID_PREFIX}-pull-fail`;
    const repo: RepoHandle = makeRepo({ url, apiKey: `${apiKey}-invalid`, project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const result = await runCli(['pull', '--env', 'dev'], { cwd: repo.dir, env });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain('invalid');

      const audit = readAuditLog(repo.chiralDir);
      const pullEntry = audit.find((e) => e.action === 'pull');
      expect(pullEntry?.result).toBe('failure');
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});
