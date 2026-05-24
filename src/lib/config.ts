import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { UserError } from './errors.js';

export interface ConfigWithDir {
  config: Config;
  chiralDir: string;
}

const EnvironmentSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().min(1),
});

export const GitSyncSchema = z.object({
  enabled: z.boolean(),
  remote: z.string().min(1),
  branch: z.string().min(1).default('main'),
});

export const ConfigSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  environments: z
    .record(z.string(), EnvironmentSchema)
    .refine((envs) => Object.keys(envs).length >= 1, {
      message: 'At least one environment is required',
    }),
  licenseKey: z.string().optional(),
  gitSync: GitSyncSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type GitSync = z.infer<typeof GitSyncSchema>;

function findConfigPath(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const candidate = join(current, '.chiral', 'config.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadConfigAndDir(startDir: string = process.cwd()): ConfigWithDir {
  const configPath = findConfigPath(startDir);
  if (!configPath) {
    throw new UserError("No .chiral/config.json found. Run 'chiral init' first.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    throw new UserError(`Could not read ${configPath} — is it valid JSON?`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const firstError = result.error.errors[0];
    const field = firstError.path.join('.');
    throw new UserError(
      `Invalid config: ${field ? field + ': ' : ''}${firstError.message}`,
    );
  }

  return { config: result.data, chiralDir: dirname(configPath) };
}

export function loadConfig(startDir: string = process.cwd()): Config {
  return loadConfigAndDir(startDir).config;
}

export function findChiralDir(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const candidate = join(current, '.chiral');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function writeConfig(chiralDir: string, config: Config): void {
  const configPath = join(chiralDir, 'config.json');
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    throw new UserError('Could not write .chiral/config.json');
  }
}

export function readProjectNameFromExample(chiralDir: string): string {
  const examplePath = join(chiralDir, 'config.example.json');
  try {
    const raw = JSON.parse(readFileSync(examplePath, 'utf-8')) as { project?: unknown };
    return typeof raw.project === 'string' && raw.project ? raw.project : 'my-project';
  } catch {
    return 'my-project';
  }
}

export function resolveEnv(config: Config, envName: string): Environment {
  const env = config.environments[envName];
  if (!env) {
    const available = Object.keys(config.environments).join(', ');
    throw new UserError(`Unknown environment "${envName}". Available: ${available}`);
  }
  return env;
}