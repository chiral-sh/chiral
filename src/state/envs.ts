import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const EnvsSchema = z.object({
  version: z.literal(1),
  envs: z.record(z.string(), z.string()).default({}),
});

export type EnvsRegistry = z.infer<typeof EnvsSchema>;

export function loadEnvs(chiralDir: string): EnvsRegistry {
  const filePath = join(chiralDir, 'envs.json');
  if (!existsSync(filePath)) return { version: 1, envs: {} };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    const result = EnvsSchema.safeParse(raw);
    return result.success ? result.data : { version: 1, envs: {} };
  } catch {
    return { version: 1, envs: {} };
  }
}

export function writeEnvs(chiralDir: string, registry: EnvsRegistry): void {
  const filePath = join(chiralDir, 'envs.json');
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);
}

export function generateEnvId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

// Resolves an env name to its stable ID, generating one lazily if the env
// has no ID yet (e.g. created before this feature existed).
export function resolveEnvId(chiralDir: string, envName: string): string {
  const registry = loadEnvs(chiralDir);
  if (registry.envs[envName]) return registry.envs[envName]!;
  const id = generateEnvId();
  registry.envs[envName] = id;
  writeEnvs(chiralDir, registry);
  return id;
}

// Read-only lookup - returns undefined if the env has no ID yet, without
// writing envs.json. Use this on read-only code paths (diff, push --check/--dry-run)
// where a missing entry means "no locks/state recorded for this env yet".
export function peekEnvId(chiralDir: string, envName: string): string | undefined {
  return loadEnvs(chiralDir).envs[envName];
}

// Returns envId → envName for display purposes.
export function buildEnvIdToNameMap(chiralDir: string): Map<string, string> {
  const registry = loadEnvs(chiralDir);
  return new Map(Object.entries(registry.envs).map(([name, id]) => [id, name]));
}
