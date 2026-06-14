import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCli } from './helpers/cli.js';
import { makeRepo, type RepoHandle } from './helpers/repo.js';
import { getN8n } from './helpers/context.js';
import { assertNoMutation } from './helpers/no-mutation.js';
import { N8nClient, type WorkflowFull } from '../../src/lib/n8n-client.js';
import { loadConfigAndDir, writeConfig } from '../../src/lib/config.js';
import { registerProject } from '../../src/lib/projects.js';
import {
  writeSnapshot,
  writeSnapshotMeta,
  generateDeploymentId,
  type SnapshotWorkflow,
} from '../../src/state/snapshots.js';
import { RUN_ID_PREFIX } from './constants.js';

// resolveActiveProject() reads the global project registry, not cwd - register
// each temp repo as its own project in an isolated CHIRAL_PROJECTS_DIR and select
// it via CHIRAL_PROJECT so push operates on the temp repo, not the dev machine's
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

const noOpNode = {
  id: '1',
  name: 'Note',
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position: [0, 0] as [number, number],
  parameters: {},
};

// Writes a "dev" snapshot for push's --source to read from, mimicking the
// shape `pull` would have written (push only needs id/name/nodes/connections/settings).
function writeSourceSnapshot(chiralDir: string, env: string, workflows: SnapshotWorkflow[]): string {
  const deploymentId = generateDeploymentId();
  for (const wf of workflows) {
    writeSnapshot(chiralDir, deploymentId, wf);
  }
  writeSnapshotMeta(chiralDir, deploymentId, {
    deployment_id: deploymentId,
    env,
    command: 'pull',
    timestamp: new Date().toISOString(),
    workflow_count: workflows.length,
    filters: { tag: null, pattern: null, onlyActive: false, id: null },
  });
  return deploymentId;
}

async function deleteWorkflow(url: string, apiKey: string, id: string): Promise<void> {
  await fetch(`${url.replace(/\/$/, '')}/api/v1/workflows/${id}`, {
    method: 'DELETE',
    headers: { 'X-N8N-API-KEY': apiKey },
  });
}

describe('chiral push (integration)', () => {
  const { url, apiKey } = getN8n();
  const client = new N8nClient({ url, apiKey }, 'target');

  const createName = `${RUN_ID_PREFIX}-push-create`;
  const updateName = `${RUN_ID_PREFIX}-push-update`;
  const dryRunName = `${RUN_ID_PREFIX}-push-dryrun`;

  let updateWorkflowId: string;
  let updateOriginalVersionId: string;
  let createdWorkflowId: string | undefined;

  beforeAll(async () => {
    const created = await client.createWorkflow({
      name: updateName,
      nodes: [],
      connections: {},
      settings: {},
    } as unknown as WorkflowFull);
    updateWorkflowId = created.id;
    updateOriginalVersionId = created.versionId;
  });

  afterAll(async () => {
    await deleteWorkflow(url, apiKey, updateWorkflowId);
    if (createdWorkflowId) await deleteWorkflow(url, apiKey, createdWorkflowId);
  });

  it('creates a new workflow and updates an existing one, both with non-empty versionIds', async () => {
    const project = `${RUN_ID_PREFIX}-push-ok`;
    const repo: RepoHandle = makeRepo({ url, apiKey, envName: 'dev', project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const { config, chiralDir } = loadConfigAndDir(repo.dir);
      config.environments['target'] = { url, apiKey };
      writeConfig(chiralDir, config);

      writeSourceSnapshot(chiralDir, 'dev', [
        {
          id: `${RUN_ID_PREFIX}-push-create-fixture`,
          name: createName,
          nodes: [],
          connections: {},
          settings: {},
        } as unknown as SnapshotWorkflow,
        {
          id: updateWorkflowId,
          name: updateName,
          nodes: [noOpNode],
          connections: {},
          settings: {},
        } as unknown as SnapshotWorkflow,
      ]);

      const result = await runCli(['push', '--source', 'dev', '--target', 'target', '--yes'], {
        cwd: repo.dir,
        env,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Created');
      expect(result.stdout).toContain('Updated');

      const targetWorkflows = await client.listWorkflows();
      const createdSummary = targetWorkflows.find((w) => w.name === createName);
      expect(createdSummary).toBeDefined();
      createdWorkflowId = createdSummary!.id;

      const createdFull = await client.getWorkflow(createdSummary!.id);
      expect(createdFull.versionId).toBeTruthy();

      const updatedFull = await client.getWorkflow(updateWorkflowId);
      expect(updatedFull.versionId).toBeTruthy();
      expect(updatedFull.versionId).not.toBe(updateOriginalVersionId);

      // Live push writes a pre-push snapshot of the (pre-update) target workflows
      const deploymentDirs = readdirSync(join(chiralDir, 'snapshots'));
      const pushSnapshotDir = deploymentDirs.find((dir) => existsSync(join(chiralDir, 'snapshots', dir, `${updateWorkflowId}.json`)));
      expect(pushSnapshotDir).toBeDefined();
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it('--dry-run makes no mutations to the target', async () => {
    const project = `${RUN_ID_PREFIX}-push-dryrun`;
    const repo: RepoHandle = makeRepo({ url, apiKey, envName: 'dev', project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const { config, chiralDir } = loadConfigAndDir(repo.dir);
      config.environments['target'] = { url, apiKey };
      writeConfig(chiralDir, config);

      writeSourceSnapshot(chiralDir, 'dev', [
        {
          id: `${RUN_ID_PREFIX}-push-dryrun-fixture`,
          name: dryRunName,
          nodes: [],
          connections: {},
          settings: {},
        } as unknown as SnapshotWorkflow,
      ]);

      const result = await assertNoMutation(client, () =>
        runCli(['push', '--source', 'dev', '--target', 'target', '--dry-run'], {
          cwd: repo.dir,
          env,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain('dry run');

      const targetWorkflows = await client.listWorkflows();
      expect(targetWorkflows.find((w) => w.name === dryRunName)).toBeUndefined();
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when the target API key is invalid', async () => {
    const project = `${RUN_ID_PREFIX}-push-fail`;
    const repo: RepoHandle = makeRepo({ url, apiKey, envName: 'dev', project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const { config, chiralDir } = loadConfigAndDir(repo.dir);
      config.environments['target'] = { url, apiKey: `${apiKey}-invalid` };
      writeConfig(chiralDir, config);

      writeSourceSnapshot(chiralDir, 'dev', [
        {
          id: `${RUN_ID_PREFIX}-push-fail-fixture`,
          name: `${RUN_ID_PREFIX}-push-fail`,
          nodes: [],
          connections: {},
          settings: {},
        } as unknown as SnapshotWorkflow,
      ]);

      const result = await runCli(['push', '--source', 'dev', '--target', 'target', '--yes'], {
        cwd: repo.dir,
        env,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain('invalid');
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});
