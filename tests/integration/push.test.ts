import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
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
import { writeCredentials } from '../../src/state/credentials.js';
import { writeTableMap } from '../../src/state/tables.js';
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

// N8nClient has no credential-create/delete methods (not needed by any chiral
// command) - use the Public API directly, same pattern as deleteWorkflow.
async function createCredential(
  url: string,
  apiKey: string,
  name: string,
  type: string,
  data: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const response = await fetch(`${url.replace(/\/$/, '')}/api/v1/credentials`, {
    method: 'POST',
    headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, data }),
  });
  if (!response.ok) {
    throw new Error(`create credential failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<{ id: string; name: string }>;
}

async function deleteCredential(url: string, apiKey: string, id: string): Promise<void> {
  await fetch(`${url.replace(/\/$/, '')}/api/v1/credentials/${id}`, {
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

  it('live push with mapped credential AND mapped data table is a no-op on the second run', async () => {
    const project = `${RUN_ID_PREFIX}-push-maps`;
    const repo: RepoHandle = makeRepo({ url, apiKey, envName: 'dev', project });
    const { projectsDir, env } = registerTempProject(repo, project);
    const wfName = `${RUN_ID_PREFIX}-push-maps-wf`;

    let targetWorkflowId: string | undefined;
    let targetCred: { id: string; name: string } | undefined;
    let rotatedCred: { id: string; name: string } | undefined;

    try {
      const { config, chiralDir } = loadConfigAndDir(repo.dir);
      config.environments['target'] = { url, apiKey };
      writeConfig(chiralDir, config);

      const sourceCredName = `${RUN_ID_PREFIX}-cred-dev`;
      const targetCredName = `${RUN_ID_PREFIX}-cred-target`;

      // Only the target credential needs to exist - push validates the mapped
      // target name against the target instance's credential list.
      targetCred = await createCredential(url, apiKey, targetCredName, 'httpBasicAuth', {
        user: 'chiral',
        password: 'chiral-secret',
      });

      writeCredentials(chiralDir, {
        version: 1,
        credentials: { 'api-cred': { dev: sourceCredName, target: targetCredName } },
      });

      writeTableMap(chiralDir, {
        version: 1,
        tables: {
          'lookup-table': {
            dev: { id: 'src-table-1', name: 'Source Table' },
            target: { id: 'tgt-table-1', name: 'Target Table' },
          },
        },
      });

      const sourceNodes = [
        {
          id: '1',
          name: 'HTTP',
          type: 'n8n-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [0, 0] as [number, number],
          parameters: { url: 'https://example.com' },
          credentials: {
            httpBasicAuth: { id: 'src-cred-id', name: sourceCredName },
          },
        },
        {
          id: '2',
          name: 'Read Table',
          type: 'n8n-nodes-base.datatable',
          typeVersion: 1,
          position: [200, 0] as [number, number],
          parameters: {
            dataTableId: {
              __rl: true,
              value: 'src-table-1',
              mode: 'list',
              cachedResultName: 'Source Table',
              cachedResultUrl: 'https://dev.example/data-tables/src-table-1',
            },
          },
        },
      ];

      // Pre-create + activate the target workflow so the first push exercises
      // the deactivate -> update -> reactivate path.
      const created = await client.createWorkflow({
        name: wfName,
        nodes: [],
        connections: {},
        settings: {},
      } as unknown as WorkflowFull);
      targetWorkflowId = created.id;
      await client.activateWorkflow(targetWorkflowId);

      writeSourceSnapshot(chiralDir, 'dev', [
        {
          id: `${RUN_ID_PREFIX}-push-maps-fixture`,
          name: wfName,
          nodes: sourceNodes,
          connections: {},
          settings: {},
        } as unknown as SnapshotWorkflow,
      ]);

      const run1 = await runCli(['push', '--source', 'dev', '--target', 'target', '--yes'], {
        cwd: repo.dir,
        env,
      });
      expect(run1.exitCode).toBe(0);
      expect(run1.stdout).toContain('Updated');

      const afterRun1 = await client.getWorkflow(targetWorkflowId);
      expect(afterRun1.active).toBe(true);

      const nodesAfterRun1 = afterRun1.nodes as Array<Record<string, unknown>>;
      const httpNodeAfter = nodesAfterRun1.find((n) => n['type'] === 'n8n-nodes-base.httpRequest')!;
      const httpCreds = (httpNodeAfter['credentials'] as Record<string, { name: string }>)['httpBasicAuth'];
      expect(httpCreds.name).toBe(targetCredName);

      const dtNodeAfter = nodesAfterRun1.find((n) => n['type'] === 'n8n-nodes-base.datatable')!;
      const dtIdAfter = (dtNodeAfter['parameters'] as Record<string, unknown>)['dataTableId'] as Record<string, unknown>;
      expect(dtIdAfter['value']).toBe('tgt-table-1');
      expect(dtIdAfter['cachedResultUrl']).toBeUndefined();
      // S4: the source-env display name must not leak to the target.
      expect(dtIdAfter['cachedResultName']).toBe('Target Table');

      const versionAfterRun1 = afterRun1.versionId;

      const run2 = await runCli(['push', '--source', 'dev', '--target', 'target', '--yes'], {
        cwd: repo.dir,
        env,
      });
      expect(run2.exitCode).toBe(0);
      expect(run2.stdout).not.toContain('Updated');
      expect(run2.stdout.toLowerCase()).toContain('skipped');

      const afterRun2 = await client.getWorkflow(targetWorkflowId);
      expect(afterRun2.versionId).toBe(versionAfterRun1);
      expect(afterRun2.active).toBe(true);

      // S1: a genuine credential swap (same type, no map entry - passthrough)
      // must be detected as a real change, not skipped.
      const rotatedCredName = `${RUN_ID_PREFIX}-cred-rotated`;
      rotatedCred = await createCredential(url, apiKey, rotatedCredName, 'httpBasicAuth', {
        user: 'chiral',
        password: 'chiral-secret-2',
      });

      writeSourceSnapshot(chiralDir, 'dev', [
        {
          id: `${RUN_ID_PREFIX}-push-maps-fixture`,
          name: wfName,
          nodes: [
            { ...sourceNodes[0], credentials: { httpBasicAuth: { id: 'src-cred-id-2', name: rotatedCredName } } },
            sourceNodes[1],
          ],
          connections: {},
          settings: {},
        } as unknown as SnapshotWorkflow,
      ]);

      const run3 = await runCli(['push', '--source', 'dev', '--target', 'target', '--yes'], {
        cwd: repo.dir,
        env,
      });
      expect(run3.exitCode).toBe(0);
      expect(run3.stdout).toContain('Updated');

      const afterRun3 = await client.getWorkflow(targetWorkflowId);
      const httpNodeAfter3 = (afterRun3.nodes as Array<Record<string, unknown>>).find(
        (n) => n['type'] === 'n8n-nodes-base.httpRequest',
      )!;
      const httpCredsAfter3 = (httpNodeAfter3['credentials'] as Record<string, { name: string }>)['httpBasicAuth'];
      expect(httpCredsAfter3.name).toBe(rotatedCredName);
    } finally {
      if (targetWorkflowId) await deleteWorkflow(url, apiKey, targetWorkflowId);
      if (targetCred) await deleteCredential(url, apiKey, targetCred.id);
      if (rotatedCred) await deleteCredential(url, apiKey, rotatedCred.id);
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it('truncated snapshot file does not silently re-create or drop the workflow', async () => {
    const project = `${RUN_ID_PREFIX}-push-corrupt`;
    const repo: RepoHandle = makeRepo({ url, apiKey, envName: 'dev', project });
    const { projectsDir, env } = registerTempProject(repo, project);
    const okName = `${RUN_ID_PREFIX}-push-corrupt-ok`;
    const badName = `${RUN_ID_PREFIX}-push-corrupt-bad`;
    const badId = `${RUN_ID_PREFIX}-push-corrupt-bad-fixture`;

    let createdWorkflowIdForTest: string | undefined;

    try {
      const { config, chiralDir } = loadConfigAndDir(repo.dir);
      config.environments['target'] = { url, apiKey };
      writeConfig(chiralDir, config);

      const deploymentId = writeSourceSnapshot(chiralDir, 'dev', [
        {
          id: `${RUN_ID_PREFIX}-push-corrupt-ok-fixture`,
          name: okName,
          nodes: [],
          connections: {},
          settings: {},
        } as unknown as SnapshotWorkflow,
        {
          id: badId,
          name: badName,
          nodes: [],
          connections: {},
          settings: {},
        } as unknown as SnapshotWorkflow,
      ]);

      // Truncate the "bad" workflow's snapshot file to invalid JSON.
      const badSnapshotPath = join(chiralDir, 'snapshots', deploymentId, `${badId}.json`);
      writeFileSync(badSnapshotPath, '{"id": "truncated', 'utf-8');

      const result = await runCli(['push', '--source', 'dev', '--target', 'target', '--yes'], {
        cwd: repo.dir,
        env,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('1 snapshot file');
      expect(result.stderr).toContain('corrupted');
      expect(result.stderr).toContain(`chiral pull --env dev`);

      const targetWorkflows = await client.listWorkflows();
      const okSummary = targetWorkflows.find((w) => w.name === okName);
      expect(okSummary).toBeDefined();
      createdWorkflowIdForTest = okSummary!.id;

      expect(targetWorkflows.find((w) => w.name === badName)).toBeUndefined();
    } finally {
      if (createdWorkflowIdForTest) await deleteWorkflow(url, apiKey, createdWorkflowIdForTest);
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
