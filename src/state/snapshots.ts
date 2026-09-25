import {
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';
import { writeJsonAtomic } from './atomic.js';
import {
  normalizeWorkflowSnapshot,
  NORMALIZATION_VERSION,
  type PinDataMode,
} from '../lib/workflow-normalize.js';

// Minimal validation - snapshots store raw n8n workflow objects as-is
const SnapshotWorkflowSchema = z.looseObject({ id: z.string(), name: z.string() });

// ── Snapshot metadata ─────────────────────────────────────────────────────────

const SnapshotMetaSchema = z.object({
  deployment_id: z.string(),
  env: z.string(),
  command: z.enum(['pull', 'adopt', 'push']),
  timestamp: z.string().datetime(),
  workflow_count: z.number().int(),
  content_hash: z.string().optional(),
  filters: z.object({
    tag: z.string().nullable(),
    pattern: z.string().nullable(),
    onlyActive: z.boolean(),
    id: z.string().nullable().default(null),
  }),
  normalizationVersion: z.number().int().default(1),
});

export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

export type SnapshotWorkflow = z.infer<typeof SnapshotWorkflowSchema>;

const DEPLOYMENT_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

export function computeSnapshotContentHash(workflows: SnapshotWorkflow[]): string {
  const sorted = [...workflows].sort((a, b) => a.id.localeCompare(b.id));
  const str = sorted.map((w) => `${w.id}:${JSON.stringify(w)}`).join('\n');
  return createHash('sha1').update(str).digest('hex');
}

export function generateDeploymentId(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z'); // YYYYMMDDTHHmmssZ
  const hex = randomBytes(4).toString('hex');
  return `${ts}-${hex}`;
}

export function writeSnapshot(
  chiralDir: string,
  deploymentId: string,
  workflow: SnapshotWorkflow,
  pinData: PinDataMode = 'keep',
): { pinDataStripped: boolean; pinDataSizeBytes: number | null } {
  const dir = join(chiralDir, 'snapshots', deploymentId);
  const normalized = normalizeWorkflowSnapshot(workflow, { pinData });
  const output = { id: workflow.id, ...normalized.workflow };
  try {
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(join(dir, `${workflow.id}.json`), output);
  } catch {
    throw new UserError(`Could not write snapshot for workflow "${workflow.id}"`);
  }
  return { pinDataStripped: normalized.pinDataStripped, pinDataSizeBytes: normalized.pinDataSizeBytes };
}

export function readSnapshot(
  chiralDir: string,
  deploymentId: string,
  workflowId: string,
): SnapshotWorkflow {
  const filePath = join(chiralDir, 'snapshots', deploymentId, `${workflowId}.json`);
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

export function listDeployments(chiralDir: string): string[] {
  const snapshotsDir = join(chiralDir, 'snapshots');
  if (!existsSync(snapshotsDir)) return [];
  return readdirSync(snapshotsDir)
    .filter((name) => DEPLOYMENT_ID_RE.test(name))
    .sort()
    .reverse(); // newest first
}

export function listSnapshotWorkflows(
  chiralDir: string,
  deploymentId: string,
): string[] {
  const dir = join(chiralDir, 'snapshots', deploymentId);
  if (!existsSync(dir)) {
    throw new UserError(`No deployment found with ID "${deploymentId}"`);
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'meta.json')
    .map((f) => f.replace(/\.json$/, ''));
}

export function writeSnapshotMeta(
  chiralDir: string,
  deploymentId: string,
  meta: Omit<SnapshotMeta, 'normalizationVersion'>,
): void {
  const dir = join(chiralDir, 'snapshots', deploymentId);
  const fullMeta: SnapshotMeta = { ...meta, normalizationVersion: NORMALIZATION_VERSION };
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'meta.json'), fullMeta);
}

export function readSnapshotMeta(
  chiralDir: string,
  deploymentId: string,
): SnapshotMeta | null {
  const filePath = join(chiralDir, 'snapshots', deploymentId, 'meta.json');
  if (!existsSync(filePath)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    const result = SnapshotMetaSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Scans deployments newest-first and returns the first *full* snapshot (pull/adopt)
// written for the given env. Push-target snapshots only contain the in-scope subset
// of workflows that were touched by that push, so they're skipped here - treating one
// as "the latest deployment" would silently drop every workflow outside that subset.
export function findLatestDeploymentForEnv(
  chiralDir: string,
  env: string,
): string | undefined {
  for (const deploymentId of listDeployments(chiralDir)) {
    const meta = readSnapshotMeta(chiralDir, deploymentId);
    if (meta?.env === env && meta.command !== 'push') return deploymentId;
  }
  return undefined;
}

export interface ReadAllWorkflowsResult {
  workflows: SnapshotWorkflow[];
  corruptCount: number;
}

export function readAllWorkflowsInDeployment(
  chiralDir: string,
  deploymentId: string,
): ReadAllWorkflowsResult {
  const dir = join(chiralDir, 'snapshots', deploymentId);
  if (!existsSync(dir)) return { workflows: [], corruptCount: 0 };
  const workflows: SnapshotWorkflow[] = [];
  let corruptCount = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'meta.json')) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      const result = SnapshotWorkflowSchema.safeParse(raw);
      if (result.success) {
        workflows.push(result.data);
      } else {
        corruptCount++;
      }
    } catch {
      corruptCount++;
    }
  }
  return { workflows, corruptCount };
}

export interface PruneSnapshotsResult {
  removed: string[];
  freedBytes: number;
  keptCount: number;
}

function sumDirectoryBytes(dirPath: string): number {
  let total = 0;
  for (const file of readdirSync(dirPath)) {
    try {
      total += statSync(join(dirPath, file)).size;
    } catch {
      // ignore unreadable entries
    }
  }
  return total;
}

export function deleteSnapshots(
  chiralDir: string,
  ids: string[],
): { freedBytes: number } {
  if (ids.length === 0) return { freedBytes: 0 };
  const snapshotsDir = join(chiralDir, 'snapshots');
  let freedBytes = 0;
  for (const id of ids) {
    const dirPath = join(snapshotsDir, id);
    if (existsSync(dirPath)) {
      freedBytes += sumDirectoryBytes(dirPath);
    }
    rmSync(dirPath, { recursive: true, force: true });
  }
  return { freedBytes };
}

export function pruneSnapshots(
  chiralDir: string,
  keep: number,
  opts?: { dryRun?: boolean },
): PruneSnapshotsResult {
  const snapshotsDir = join(chiralDir, 'snapshots');
  if (!existsSync(snapshotsDir)) {
    return { removed: [], freedBytes: 0, keptCount: 0 };
  }
  const deployments = listDeployments(chiralDir);
  const toRemove = deployments.slice(keep);
  const freedBytes = toRemove.reduce(
    (sum, id) => sum + sumDirectoryBytes(join(snapshotsDir, id)),
    0,
  );
  if (!opts?.dryRun) {
    for (const id of toRemove) {
      rmSync(join(snapshotsDir, id), { recursive: true });
    }
  }
  return {
    removed: toRemove,
    freedBytes,
    keptCount: deployments.length - toRemove.length,
  };
}
