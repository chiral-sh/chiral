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
import { RUN_ID_PREFIX } from './constants.js';

// resolveActiveProject() reads the global project registry, not cwd - register
// each temp repo as its own project in an isolated CHIRAL_PROJECTS_DIR and select
// it via CHIRAL_PROJECT so diff operates on the temp repo, not the dev machine's
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

describe('chiral diff (integration)', () => {
  const dev = getN8n();
  let prod: N8nHandle;
  let devClient: N8nClient;
  let prodClient: N8nClient;

  const modifiedName = `${RUN_ID_PREFIX}-diff-modified`;
  const cleanName = `${RUN_ID_PREFIX}-diff-clean`;
  const addedName = `${RUN_ID_PREFIX}-diff-added`;

  let devModifiedId: string;
  let prodModifiedId: string;
  let devCleanId: string;
  let prodCleanId: string;
  let devAddedId: string;

  beforeAll(async () => {
    prod = await startN8n();
  }, 120_000);

  beforeAll(async () => {
    devClient = new N8nClient(dev, 'dev');
    prodClient = new N8nClient(prod, 'prod');

    const devModified = await devClient.createWorkflow({
      name: modifiedName,
      nodes: [noOpNode],
      connections: {},
      settings: {},
    } as unknown as WorkflowFull);
    devModifiedId = devModified.id;

    const prodModified = await prodClient.createWorkflow({
      name: modifiedName,
      nodes: [],
      connections: {},
      settings: {},
    } as unknown as WorkflowFull);
    prodModifiedId = prodModified.id;

    const devClean = await devClient.createWorkflow({
      name: cleanName,
      nodes: [],
      connections: {},
      settings: {},
    } as unknown as WorkflowFull);
    devCleanId = devClean.id;

    const prodClean = await prodClient.createWorkflow({
      name: cleanName,
      nodes: [],
      connections: {},
      settings: {},
    } as unknown as WorkflowFull);
    prodCleanId = prodClean.id;

    const devAdded = await devClient.createWorkflow({
      name: addedName,
      nodes: [],
      connections: {},
      settings: {},
    } as unknown as WorkflowFull);
    devAddedId = devAdded.id;
  });

  afterAll(async () => {
    await Promise.all([
      deleteWorkflow(dev, devModifiedId),
      deleteWorkflow(prod, prodModifiedId),
      deleteWorkflow(dev, devCleanId),
      deleteWorkflow(prod, prodCleanId),
      deleteWorkflow(dev, devAddedId),
    ]);
    await prod.stop();
  }, 60_000);

  it('reports added and modified workflows, exits 1 with --exit-code, and emits a json envelope', async () => {
    const project = `${RUN_ID_PREFIX}-diff-ok`;
    const repo: RepoHandle = makeRepo({ url: dev.url, apiKey: dev.apiKey, envName: 'dev', project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const { config, chiralDir } = loadConfigAndDir(repo.dir);
      config.environments['prod'] = { url: prod.url, apiKey: prod.apiKey };
      writeConfig(chiralDir, config);

      const result = await runCli(['diff', '--from', 'dev', '--to', 'prod', '--json', '--exit-code'], {
        cwd: repo.dir,
        env,
      });

      expect(result.exitCode).toBe(1);

      const payload = JSON.parse(result.stdout) as {
        status: string;
        data: {
          added: Array<{ name: string }>;
          modified: Array<{ name: string }>;
          unchanged: Array<{ name: string }>;
        };
      };
      expect(payload.status).toBe('ok');
      expect(payload.data.added.map((w) => w.name)).toContain(addedName);
      expect(payload.data.modified.map((w) => w.name)).toContain(modifiedName);
      expect(payload.data.added.map((w) => w.name)).not.toContain(cleanName);
      expect(payload.data.modified.map((w) => w.name)).not.toContain(cleanName);
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it('exits 0 with --exit-code when source and target are identical', async () => {
    const project = `${RUN_ID_PREFIX}-diff-clean`;
    const repo: RepoHandle = makeRepo({ url: dev.url, apiKey: dev.apiKey, envName: 'dev', project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const { config, chiralDir } = loadConfigAndDir(repo.dir);
      config.environments['dev2'] = { url: dev.url, apiKey: dev.apiKey };
      writeConfig(chiralDir, config);

      const result = await runCli(['diff', '--from', 'dev', '--to', 'dev2', '--exit-code'], {
        cwd: repo.dir,
        env,
      });

      expect(result.exitCode).toBe(0);
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when the target environment is unreachable', async () => {
    const project = `${RUN_ID_PREFIX}-diff-fail`;
    const repo: RepoHandle = makeRepo({ url: dev.url, apiKey: dev.apiKey, envName: 'dev', project });
    const { projectsDir, env } = registerTempProject(repo, project);
    try {
      const { config, chiralDir } = loadConfigAndDir(repo.dir);
      config.environments['prod'] = { url: prod.url, apiKey: `${prod.apiKey}-invalid` };
      writeConfig(chiralDir, config);

      const result = await runCli(['diff', '--from', 'dev', '--to', 'prod'], { cwd: repo.dir, env });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain('invalid');
    } finally {
      repo.cleanup();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});
