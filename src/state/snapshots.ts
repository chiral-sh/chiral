import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

// Minimal validation — snapshots store raw n8n workflow objects as-is
const SnapshotWorkflowSchema = z
  .object({ id: z.string(), name: z.string() })
  .passthrough();

// ── Snapshot metadata ─────────────────────────────────────────────────────────

const SnapshotMetaSchema = z.object({
  deployment_id: z.string(),
  env: z.string(),
  command: z.enum(['pull', 'adopt', 'push']),
  timestamp: z.string().datetime(),
  workflow_count: z.number().int(),
  filters: z.object({
    tag: z.string().nullable(),
    pattern: z.string().nullable(),
    onlyActive: z.boolean(),
    id: z.string().nullable().default(null),
  }),
});

export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

export type SnapshotWorkflow = z.infer<typeof SnapshotWorkflowSchema>;

const DEPLOYMENT_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

export function generateDeploymentId(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z'); // YYYYMMDDTHHmmssZ
  const hex = randomBytes(4).toString('hex');
  return `${ts}-${hex}`;
}

export function writeSnapshot(
  flightdeckDir: string,
  deploymentId: string,
  workflow: SnapshotWorkflow,
): void {
  const dir = join(flightdeckDir, 'snapshots', deploymentId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${workflow.id}.json`),
      JSON.stringify(workflow, null, 2),
      'utf-8',
    );
  } catch {
    throw new UserError(`Could not write snapshot for workflow "${workflow.id}"`);
  }
}

export function readSnapshot(
  flightdeckDir: string,
  deploymentId: string,
  workflowId: string,
): SnapshotWorkflow {
  const filePath = join(flightdeckDir, 'snapshots', deploymentId, `${workflowId}.json`);
  if (!existsSync(filePath)) {
    throw new UserError(
      `No snapshot found for workflow "${workflowId}" in deployment ${deploymentId}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    throw new UserError(`Snapshot file is corrupted: ${filePath}`);
  }
  const result = SnapshotWorkflowSchema.safeParse(raw);
  if (!result.success) {
    throw new UserError(`Snapshot file has invalid structure: ${filePath}`);
  }
  return result.data;
}

export function listDeployments(flightdeckDir: string): string[] {
  const snapshotsDir = join(flightdeckDir, 'snapshots');
  if (!existsSync(snapshotsDir)) return [];
  return readdirSync(snapshotsDir)
    .filter((name) => DEPLOYMENT_ID_RE.test(name))
    .sort()
    .reverse(); // newest first
}

export function listSnapshotWorkflows(
  flightdeckDir: string,
  deploymentId: string,
): string[] {
  const dir = join(flightdeckDir, 'snapshots', deploymentId);
  if (!existsSync(dir)) {
    throw new UserError(`No deployment found with ID "${deploymentId}"`);
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'meta.json')
    .map((f) => f.replace(/\.json$/, ''));
}

export function writeSnapshotMeta(
  flightdeckDir: string,
  deploymentId: string,
  meta: SnapshotMeta,
): void {
  const dir = join(flightdeckDir, 'snapshots', deploymentId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  } catch {
    // best-effort — don't block the command if meta write fails
  }
}

export function readSnapshotMeta(
  flightdeckDir: string,
  deploymentId: string,
): SnapshotMeta | null {
  const filePath = join(flightdeckDir, 'snapshots', deploymentId, 'meta.json');
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    const result = SnapshotMetaSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Scans deployments newest-first and returns the first one written for the given env.
export function findLatestDeploymentForEnv(
  flightdeckDir: string,
  env: string,
): string | undefined {
  for (const deploymentId of listDeployments(flightdeckDir)) {
    const meta = readSnapshotMeta(flightdeckDir, deploymentId);
    if (meta?.env === env) return deploymentId;
  }
  return undefined;
}

export function readAllWorkflowsInDeployment(
  flightdeckDir: string,
  deploymentId: string,
): SnapshotWorkflow[] {
  const dir = join(flightdeckDir, 'snapshots', deploymentId);
  if (!existsSync(dir)) return [];
  const workflows: SnapshotWorkflow[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'meta.json')) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      const result = SnapshotWorkflowSchema.safeParse(raw);
      if (result.success) workflows.push(result.data);
    } catch {
      // skip corrupted snapshot files — pull will overwrite them
    }
  }
  return workflows;
}

export function pruneSnapshots(flightdeckDir: string, keep: number): number {
  const deployments = listDeployments(flightdeckDir);
  const toRemove = deployments.slice(keep);
  for (const id of toRemove) {
    rmSync(join(flightdeckDir, 'snapshots', id), { recursive: true });
  }
  return toRemove.length;
}
