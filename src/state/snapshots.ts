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
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

export function pruneSnapshots(flightdeckDir: string, keep: number): number {
  const deployments = listDeployments(flightdeckDir);
  const toRemove = deployments.slice(keep);
  for (const id of toRemove) {
    rmSync(join(flightdeckDir, 'snapshots', id), { recursive: true });
  }
  return toRemove.length;
}
