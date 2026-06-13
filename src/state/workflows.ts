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

const BUILTIN_ENV_TAGS = 'dev|development|staging|stg|prod|production|test|qa|uat|local|sandbox';

export function deriveLogicalName(workflowName: string, knownEnvs: string[] = []): string {
  const extra = knownEnvs.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const tags = extra ? `${BUILTIN_ENV_TAGS}|${extra}` : BUILTIN_ENV_TAGS;
  const t = `(${tags})`;
  return workflowName
    .toLowerCase()
    .replace(new RegExp(`\\[${t}\\]`, 'gi'), '')        // [DEV], [PROD]
    .replace(new RegExp(`\\(${t}\\)`, 'gi'), '')        // (dev), (prod)
    .replace(new RegExp(`\\s*[-–—]\\s*${t}$`, 'i'), '') // " - DEV", " — prod"
    .replace(new RegExp(`[_-]${t}$`, 'i'), '')          // _dev, -staging
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

export function loadWorkflowMap(chiralDir: string): WorkflowMap {
  const path = join(chiralDir, 'workflows.json');
  if (!existsSync(path)) return { version: 1, workflows: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new UserError('workflows.json is not valid JSON - fix it before running diff');
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

export function loadWorkflowMapRequired(chiralDir: string): WorkflowMap {
  const path = join(chiralDir, 'workflows.json');
  if (!existsSync(path)) {
    throw new UserError(
      "No .chiral/workflows.json found. Run 'chiral init' first.",
    );
  }
  return loadWorkflowMap(chiralDir);
}

export function writeWorkflowMap(chiralDir: string, data: WorkflowMap): void {
  const path = join(chiralDir, 'workflows.json');
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

// Detects two logical entries whose targetEnv name resolves to the same value (fan-in) — a
// push would silently overwrite one with the other. Entries missing either side of the env
// pair are ignored.
export function validateNoDuplicateTargets(
  map: WorkflowMap,
  sourceEnv: string,
  targetEnv: string,
): void {
  const seen = new Map<string, string>(); // targetName -> logicalKey
  for (const [logicalKey, envMap] of Object.entries(map.workflows)) {
    const source = envMap[sourceEnv];
    const target = envMap[targetEnv];
    if (!source || !target) continue;
    const existing = seen.get(target.name);
    if (existing) {
      throw new UserError(
        `Two source workflows resolve to the same target "${target.name}" in ${targetEnv}:\n` +
          `  - logical: ${existing}\n` +
          `  - logical: ${logicalKey}\n` +
          `Fix: chiral workflow map ${logicalKey} ${targetEnv}="<unique target name>"`,
      );
    }
    seen.set(target.name, logicalKey);
  }
}

// Detects a name that appears as both a source-env value and a target-env value across
// different logical entries (a cycle) — a push would try to overwrite both workflows with
// each other. Entries missing either side of the env pair are ignored.
export function validateNoCircularMapping(
  map: WorkflowMap,
  sourceEnv: string,
  targetEnv: string,
): void {
  const sourceToTarget = new Map<string, string>(); // sourceName -> logicalKey
  const targetToLogical = new Map<string, string>(); // targetName -> logicalKey
  for (const [logicalKey, envMap] of Object.entries(map.workflows)) {
    const source = envMap[sourceEnv];
    const target = envMap[targetEnv];
    if (!source || !target) continue;
    sourceToTarget.set(source.name, logicalKey);
    targetToLogical.set(target.name, logicalKey);
  }
  for (const [sourceName, sourceLogical] of sourceToTarget) {
    const targetLogical = targetToLogical.get(sourceName);
    if (targetLogical && targetLogical !== sourceLogical) {
      throw new UserError(
        `Circular mapping detected between ${sourceEnv} and ${targetEnv}:\n` +
          `  - logical "${sourceLogical}" (${sourceEnv}="${sourceName}") and ` +
          `logical "${targetLogical}" (${targetEnv}="${sourceName}") reference each other.\n` +
          `Fix: chiral workflow map ${sourceLogical} ${sourceEnv}="<unique name>" or ` +
          `chiral workflow map ${targetLogical} ${targetEnv}="<unique name>"`,
      );
    }
  }
}

// Upsert a single env entry. Preserves existing id when name is unchanged and new entry has none.
export function upsertEnvEntry(
  map: WorkflowMap,
  logicalName: string,
  env: string,
  newEntry: WorkflowEntry,
): void {
  if (!map.workflows[logicalName]) map.workflows[logicalName] = {};
  const existing = map.workflows[logicalName][env];
  const nameChanged = existing !== undefined && existing.name !== newEntry.name;
  map.workflows[logicalName][env] = {
    name: newEntry.name,
    id: newEntry.id ?? (nameChanged ? undefined : existing?.id),
  };
}
