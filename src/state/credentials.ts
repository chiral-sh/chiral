import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';
import { writeJsonAtomic } from './atomic.js';
import {
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  type SnapshotWorkflow,
} from './snapshots.js';

export const CredentialsSchema = z.object({
  version: z.literal(1),
  credentials: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

export type Credentials = z.infer<typeof CredentialsSchema>;

export function loadCredentials(chiralDir: string): Credentials {
  const credPath = join(chiralDir, 'credentials.json');
  if (!existsSync(credPath)) {
    throw new UserError(
      "No .chiral/credentials.json found. Run 'chiral init' first.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(credPath, 'utf-8'));
  } catch {
    throw new UserError(`Could not read ${credPath} - is it valid JSON?`);
  }

  const result = CredentialsSchema.safeParse(raw);
  if (!result.success) {
    const firstError = result.error.issues[0];
    const field = firstError.path.join('.');
    throw new UserError(
      `Invalid credentials.json: ${field ? field + ': ' : ''}${firstError.message}`,
    );
  }

  return result.data;
}

export function writeCredentials(chiralDir: string, data: Credentials): void {
  const credPath = join(chiralDir, 'credentials.json');
  writeJsonAtomic(credPath, data);
}

// ── Credential remapping ───────────────────────────────────────────────────────

export interface CredentialMapEntry {
  /** The credential name as it appears in the source workflow nodes */
  sourceName: string;
  /** The name to use when pushing to target - equals sourceName when status is 'passthrough' */
  targetName: string;
  /** Key in credentials.json, or null when no mapping exists */
  logicalName: string | null;
  /**
   * 'mapped'      - credentials.json has an explicit source→target mapping
   * 'passthrough' - no mapping found; name is passed through unchanged (warn, not abort)
   */
  status: 'mapped' | 'passthrough';
}

/**
 * Extracts all credential names referenced across a set of workflow nodes and resolves
 * each against credentials.json.  Returns one deduplicated entry per unique source name.
 *
 * Used by:
 *   - push --dry-run  (display credential map + validate against target)
 *   - push live       (substitute names in workflow body before PUT/POST)
 */
export function buildCredentialMap(
  nodes: unknown[],
  sourceEnv: string,
  targetEnv: string,
  credentials: Credentials,
): CredentialMapEntry[] {
  // Collect all credential names referenced in any node
  const seen = new Map<string, CredentialMapEntry>();

  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const nodeObj = node as Record<string, unknown>;
    const creds = nodeObj['credentials'];
    if (typeof creds !== 'object' || creds === null) continue;

    for (const [, credValue] of Object.entries(creds as Record<string, unknown>)) {
      if (typeof credValue !== 'object' || credValue === null) continue;
      const cv = credValue as Record<string, unknown>;
      const name = cv['name'];
      if (typeof name !== 'string' || seen.has(name)) continue;

      // Look for a logical credential whose source-env value matches this name
      let resolved: CredentialMapEntry | null = null;
      for (const [logicalName, envMap] of Object.entries(credentials.credentials)) {
        if (envMap[sourceEnv] === name) {
          const targetName = envMap[targetEnv] ?? name; // fall back to source name if no target entry
          resolved = { sourceName: name, targetName, logicalName, status: 'mapped' };
          break;
        }
      }

      if (!resolved) {
        // No mapping found - pass the name through unchanged
        resolved = { sourceName: name, targetName: name, logicalName: null, status: 'passthrough' };
      }

      seen.set(name, resolved);
    }
  }

  return Array.from(seen.values());
}

// ── Credential discovery helpers ──────────────────────────────────────────────

const BUILTIN_ENV_TOKENS = ['dev', 'staging', 'prod', 'stg', 'test', 'qa', 'uat'];

/**
 * Strips leading `{env}_` or trailing `_{env}` from a credential name to produce a
 * suggested logical name.  Falls back to the original name if no env token is found.
 *
 * Pass `Object.keys(config.environments)` as configuredEnvNames when a config is available
 * so that non-standard env names (e.g. "production", "sandbox") are also stripped.
 */
export function deriveCredentialLogicalName(
  name: string,
  configuredEnvNames: string[] = [],
): string {
  const allTokens = [
    ...new Set([
      ...configuredEnvNames.map((e) => e.toLowerCase()),
      ...BUILTIN_ENV_TOKENS,
    ]),
  ];
  const lower = name.toLowerCase();
  for (const token of allTokens) {
    if (lower.startsWith(`${token}_`)) return name.slice(token.length + 1);
    if (lower.endsWith(`_${token}`)) return name.slice(0, -(token.length + 1));
  }
  return name;
}

export interface DiscoveredCredential {
  name: string;
  env: string;
  workflowNames: string[];
}

/**
 * Scans the latest snapshot for each env and returns every unique credential name found
 * in workflow nodes, along with which workflows use it.
 *
 * Skips envs with no snapshot, and skips corrupted snapshot files gracefully.
 */
export function extractCredentialsFromSnapshots(
  chiralDir: string,
  envs: string[],
): DiscoveredCredential[] {
  const discovered = new Map<string, DiscoveredCredential>();

  for (const env of envs) {
    let deploymentId: string | undefined;
    try {
      deploymentId = findLatestDeploymentForEnv(chiralDir, env);
    } catch {
      continue;
    }
    if (!deploymentId) continue;

    let workflows: SnapshotWorkflow[];
    try {
      workflows = readAllWorkflowsInDeployment(chiralDir, deploymentId).workflows;
    } catch {
      continue;
    }

    for (const workflow of workflows) {
      const nodes = (workflow as Record<string, unknown>)['nodes'];
      if (!Array.isArray(nodes)) continue;

      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue;
        const nodeObj = node as Record<string, unknown>;
        const creds = nodeObj['credentials'];
        if (typeof creds !== 'object' || creds === null) continue;

        for (const credValue of Object.values(creds as Record<string, unknown>)) {
          if (typeof credValue !== 'object' || credValue === null) continue;
          const cv = credValue as Record<string, unknown>;
          const credName = cv['name'];
          if (typeof credName !== 'string') continue;

          const key = `${env}::${credName}`;
          const existing = discovered.get(key);
          if (existing) {
            if (!existing.workflowNames.includes(workflow.name)) {
              existing.workflowNames.push(workflow.name);
            }
          } else {
            discovered.set(key, { name: credName, env, workflowNames: [workflow.name] });
          }
        }
      }
    }
  }

  return Array.from(discovered.values());
}

/**
 * Returns a deep copy of the workflow with all credential names substituted according to
 * the provided map.  Never mutates the input object.
 *
 * Used by push live to produce the workflow body sent to the target instance.
 */
export function applyCredentialMap(
  workflow: Record<string, unknown>,
  map: CredentialMapEntry[],
): Record<string, unknown> {
  if (map.length === 0) return { ...workflow };

  const remapBySource = new Map(map.map((e) => [e.sourceName, e.targetName]));

  // Deep-copy nodes array with credential names substituted
  const nodes = workflow['nodes'];
  if (!Array.isArray(nodes)) return { ...workflow };

  const remappedNodes = (nodes as unknown[]).map((node) => {
    if (typeof node !== 'object' || node === null) return node;
    const nodeObj = node as Record<string, unknown>;
    const creds = nodeObj['credentials'];
    if (typeof creds !== 'object' || creds === null) return { ...nodeObj };

    const remappedCreds: Record<string, unknown> = {};
    for (const [credType, credValue] of Object.entries(creds as Record<string, unknown>)) {
      if (typeof credValue !== 'object' || credValue === null) {
        remappedCreds[credType] = credValue;
        continue;
      }
      const cv = credValue as Record<string, unknown>;
      const name = cv['name'];
      const newName = typeof name === 'string' ? (remapBySource.get(name) ?? name) : name;
      remappedCreds[credType] = { ...cv, name: newName };
    }
    return { ...nodeObj, credentials: remappedCreds };
  });

  return { ...workflow, nodes: remappedNodes };
}

