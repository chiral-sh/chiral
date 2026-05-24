import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

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
    throw new UserError(`Could not read ${credPath} — is it valid JSON?`);
  }

  const result = CredentialsSchema.safeParse(raw);
  if (!result.success) {
    const firstError = result.error.errors[0];
    const field = firstError.path.join('.');
    throw new UserError(
      `Invalid credentials.json: ${field ? field + ': ' : ''}${firstError.message}`,
    );
  }

  return result.data;
}

export function writeCredentials(chiralDir: string, data: Credentials): void {
  const credPath = join(chiralDir, 'credentials.json');
  try {
    writeFileSync(credPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch {
    throw new UserError(`Could not write to ${credPath}`);
  }
}

// ── Credential remapping ───────────────────────────────────────────────────────

export interface CredentialMapEntry {
  /** The credential name as it appears in the source workflow nodes */
  sourceName: string;
  /** The name to use when pushing to target — equals sourceName when status is 'passthrough' */
  targetName: string;
  /** Key in credentials.json, or null when no mapping exists */
  logicalName: string | null;
  /**
   * 'mapped'      — credentials.json has an explicit source→target mapping
   * 'passthrough' — no mapping found; name is passed through unchanged (warn, not abort)
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
        // No mapping found — pass the name through unchanged
        resolved = { sourceName: name, targetName: name, logicalName: null, status: 'passthrough' };
      }

      seen.set(name, resolved);
    }
  }

  return Array.from(seen.values());
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

  const remappedNodes = nodes.map((node) => {
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

