import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
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
// it via CHIRAL_PROJECT so adopt operates on the temp repo, not the dev machine's
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

describe('chiral adopt (integration)', () => {
  const { url, apiKey } = getN8n();
  const client = new N8nClient({ url, apiKey }, 'dev');
  const workflowName = `${RUN_ID_PREFIX}-adopt-wf`;
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

  it('imports a real workflow into snapshots and fingerprints, and writes an adopt audit event', async () => {
    const project = `${RUN_ID_PREFIX}-adopt-ok`;
    const repo: RepoHandle = makeRepo({ url, apiKey, project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const result = await runCli(['adopt', 'dev'], { cwd: repo.dir, env });

      expect(result.exitCode).toBe(0);

      const fingerprints = JSON.parse(
        readFileSync(join(repo.chiralDir, 'fingerprints.json'), 'utf-8'),
      ) as { envs: Record<string, Record<string, { name: string; versionId: string }>> };
      expect(fingerprints.envs.dev[workflowId]).toBeDefined();
      expect(fingerprints.envs.dev[workflowId].name).toBe(workflowName);

      const snapshotsDir = join(repo.chiralDir, 'snapshots');
      const deploymentDirs = readdirSync(snapshotsDir);
      expect(deploymentDirs.length).toBeGreaterThan(0);
      const snapshotFile = join(snapshotsDir, deploymentDirs[0], `${workflowId}.json`);
      expect(existsSync(snapshotFile)).toBe(true);

      const audit = readAuditLog(repo.chiralDir);
      const adoptEntry = audit.find((e) => e.action === 'adopt');
      expect(adoptEntry).toBeDefined();
      expect(adoptEntry?.result).toBe('success');
      expect(adoptEntry?.workflow_ids).toContain(workflowId);
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it('exits 1 with an invalid API key and writes a failure audit event', async () => {
    const project = `${RUN_ID_PREFIX}-adopt-fail`;
    const repo: RepoHandle = makeRepo({ url, apiKey: `${apiKey}-invalid`, project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const result = await runCli(['adopt', 'dev'], { cwd: repo.dir, env });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain('invalid');

      const audit = readAuditLog(repo.chiralDir);
      const adoptEntry = audit.find((e) => e.action === 'adopt');
      expect(adoptEntry?.result).toBe('failure');
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});
