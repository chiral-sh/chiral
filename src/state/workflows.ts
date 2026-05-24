import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

export const WorkflowEntrySchema = z.object({
  name: z.string().min(1),
  id: z.string().optional(),
});

export type WorkflowEntry = z.infer<typeof WorkflowEntrySchema>;

export const WorkflowsSchema = z.object({
  version: z.literal(1),
  workflows: z.record(z.string(), z.record(z.string(), WorkflowEntrySchema)).default({}),
});

export type WorkflowMap = z.infer<typeof WorkflowsSchema>;

export function deriveLogicalName(workflowName: string): string {
  return workflowName
    .toLowerCase()
    .replace(/\[(dev|staging|prod|stg|test|qa|uat)\]/gi, '')
    .replace(/_(dev|staging|prod|stg|test|qa|uat)$/i, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function deriveSafeLogicalName(map: WorkflowMap, name: string): string {
  const base = deriveLogicalName(name);
  if (!map.workflows[base]) return base;
  let n = 2;
  while (map.workflows[`${base}-${n}`]) n++;
  return `${base}-${n}`;
}

export function loadWorkflowMap(flightdeckDir: string): WorkflowMap {
  const path = join(flightdeckDir, 'workflows.json');
  if (!existsSync(path)) return { version: 1, workflows: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new UserError('workflows.json is not valid JSON — fix it before running diff');
  }
  const result = WorkflowsSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new UserError(
      `workflows.json has an invalid structure:\n${issues}\n\nMake sure workflows.json is valid JSON with the correct format.`,
    );
  }
  return result.data;
}

export function loadWorkflowMapRequired(flightdeckDir: string): WorkflowMap {
  const path = join(flightdeckDir, 'workflows.json');
  if (!existsSync(path)) {
    throw new UserError(
      "No .flightdeck/workflows.json found. Run 'flightdeck init' first.",
    );
  }
  return loadWorkflowMap(flightdeckDir);
}

export function writeWorkflowMap(flightdeckDir: string, data: WorkflowMap): void {
  const path = join(flightdeckDir, 'workflows.json');
  try {
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch {
    throw new UserError(`Could not write to ${path}`);
  }
}

// Returns the workflow name in targetEnv for a workflow whose name in sourceEnv is sourceName.
// Falls back to sourceName if no mapping exists or the target env has no entry.
export function resolveTargetName(
  map: WorkflowMap,
  sourceEnv: string,
  targetEnv: string,
  sourceName: string,
): string {
  for (const logical of Object.values(map.workflows)) {
    if (logical[sourceEnv]?.name === sourceName) {
      return logical[targetEnv]?.name ?? sourceName;
    }
  }
  return sourceName;
}

// Find the logical name for a workflow by its env + display name.
export function findLogicalByEnvAndName(
  map: WorkflowMap,
  env: string,
  name: string,
): string | null {
  for (const [logical, envMap] of Object.entries(map.workflows)) {
    if (envMap[env]?.name === name) return logical;
  }
  return null;
}

// Find a map entry by its env + n8n workflow ID (used by pull to auto-heal renamed workflows).
export function findEntryByEnvId(
  map: WorkflowMap,
  env: string,
  id: string,
): { logicalName: string; entry: WorkflowEntry } | null {
  for (const [logical, envMap] of Object.entries(map.workflows)) {
    const entry = envMap[env];
    if (entry?.id === id) return { logicalName: logical, entry };
  }
  return null;
}

// Upsert a single env entry. Preserves existing id when name is unchanged and new entry has none.
export function upsertEnvEntry(
  map: WorkflowMap,
  logicalName: string,
  env: string,
  newEntry: WorkflowEntry,
): void {
  if (!map.workflows[logicalName]) map.workflows[logicalName] = {};
  const existing = map.workflows[logicalName]![env];
  const nameChanged = existing !== undefined && existing.name !== newEntry.name;
  map.workflows[logicalName]![env] = {
    name: newEntry.name,
    id: newEntry.id ?? (nameChanged ? undefined : existing?.id),
  };
}
