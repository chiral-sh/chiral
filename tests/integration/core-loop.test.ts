import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCli } from './helpers/cli.js';
import { makeRepo, type RepoHandle } from './helpers/repo.js';
import { getN8n } from './helpers/context.js';
import { startN8n, type N8nHandle } from './helpers/n8n-harness.js';
import { N8nClient, type WorkflowFull } from '../../src/lib/n8n-client.js';
import { loadConfigAndDir, writeConfig } from '../../src/lib/config.js';
import { registerProject } from '../../src/lib/projects.js';
import { loadWorkflowMap } from '../../src/state/workflows.js';
import { readAuditLog } from '../../src/state/audit.js';
import { RUN_ID_PREFIX } from './constants.js';

// resolveActiveProject() reads the global project registry, not cwd - register
// the temp repo as its own project in an isolated CHIRAL_PROJECTS_DIR and select
// it via CHIRAL_PROJECT so each CLI invocation operates on the temp repo, not the
// dev machine's real chiral projects.
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

async function deleteWorkflow(handle: N8nHandle, id: string): Promise<void> {
  await fetch(`${handle.url.replace(/\/$/, '')}/api/v1/workflows/${id}`, {
    method: 'DELETE',
    headers: { 'X-N8N-API-KEY': handle.apiKey },
  });
}

const noOpNode = {
  id: '1',
  name: 'Note',
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position: [0, 0] as [number, number],
  parameters: {},
};

describe('chiral core loop (integration)', () => {
  const dev = getN8n();
  let prod: N8nHandle;
  let devClient: N8nClient;
  let prodClient: N8nClient;

  const workflowName = `${RUN_ID_PREFIX}-core-loop-wf`;
  let devWorkflowId: string;
  let prodWorkflowId: string | undefined;

  beforeAll(async () => {
    prod = await startN8n();
  }, 120_000);

  afterAll(async () => {
    const deletions = [deleteWorkflow(dev, devWorkflowId)];
    if (prodWorkflowId) deletions.push(deleteWorkflow(prod, prodWorkflowId));
    await Promise.all(deletions);
    await prod.stop();
  }, 60_000);

  it('adopts dev, pulls, diffs against an empty prod, and pushes - creating + remapping the workflow', async () => {
    devClient = new N8nClient(dev, 'dev');
    prodClient = new N8nClient(prod, 'prod');

    const created = await devClient.createWorkflow({
      name: workflowName,
      nodes: [noOpNode],
      connections: {},
      settings: {},
    } as unknown as WorkflowFull);
    devWorkflowId = created.id;

    const project = `${RUN_ID_PREFIX}-core-loop`;
    const repo: RepoHandle = makeRepo({ url: dev.url, apiKey: dev.apiKey, envName: 'dev', project });
    const { projectsDir, env } = registerTempProject(repo, project);

    try {
      const { config, chiralDir } = loadConfigAndDir(repo.dir);
      config.environments['prod'] = { url: prod.url, apiKey: prod.apiKey };
      writeConfig(chiralDir, config);

      // prod starts empty - this is the promotion target
      expect(await prodClient.listWorkflows()).toHaveLength(0);

      // ── adopt dev ────────────────────────────────────────────────────────
      const adopt = await runCli(['adopt', 'dev'], { cwd: repo.dir, env });
      expect(adopt.exitCode).toBe(0);

      // ── pull dev ─────────────────────────────────────────────────────────
      const pull = await runCli(['pull', 'dev'], { cwd: repo.dir, env });
      expect(pull.exitCode).toBe(0);

      // ── diff dev -> prod (prod empty - the seeded workflow shows as added) ─
      const diff = await runCli(
        ['diff', '--from', 'dev', '--to', 'prod', '--json', '--exit-code'],
        { cwd: repo.dir, env },
      );
      expect(diff.exitCode).toBe(1);
      const diffPayload = JSON.parse(diff.stdout) as {
        status: string;
        data: { added: Array<{ name: string }> };
      };
      expect(diffPayload.status).toBe('ok');
      expect(diffPayload.data.added.map((w) => w.name)).toContain(workflowName);

      // ── push dev -> prod (create path - prod has no matching workflow) ────
      const push = await runCli(['push', '--from', 'dev', '--to', 'prod', '--yes'], {
        cwd: repo.dir,
        env,
      });
      expect(push.exitCode).toBe(0);
      expect(push.stdout).toContain('Created');

      const prodWorkflows = await prodClient.listWorkflows();
      expect(prodWorkflows).toHaveLength(1);
      const prodWorkflow = prodWorkflows.find((w) => w.name === workflowName);
      expect(prodWorkflow).toBeDefined();
      prodWorkflowId = prodWorkflow!.id;
      expect(prodWorkflowId).not.toBe(devWorkflowId);

      // ── workflow map records the dev/prod id remap ─────────────────────────
      const workflowMap = loadWorkflowMap(chiralDir);
      const logical = Object.values(workflowMap.workflows).find(
        (envMap) => envMap['dev']?.id === devWorkflowId,
      );
      expect(logical).toBeDefined();
      expect(logical?.['prod']?.id).toBe(prodWorkflowId);
      expect(logical?.['prod']?.name).toBe(workflowName);

      // ── audit log holds the ordered events ──────────────────────────────────
      // chiral init writes no audit event (see init.test.ts) - the sequence
      // starts at adopt.
      const audit = readAuditLog(chiralDir);
      const lastFour = audit.slice(-4).map((e) => e.action);
      expect(lastFour).toEqual(['adopt', 'pull', 'diff', 'push']);
      expect(audit.slice(-4).every((e) => e.result === 'success')).toBe(true);
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  }, 180_000);
});
