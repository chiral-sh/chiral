import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from './errors.js';
import { resolveActiveProject, type ResolvedProject } from './projects.js';

export interface ConfigWithDir {
  config: Config;
  chiralDir: string;
  projectName: string;
}

const EnvironmentSchema = z.object({
  url: z.url(),
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

export function loadConfigAndDir(cwdOrResolved?: string | ResolvedProject): ConfigWithDir {
  let chiralDir: string;
  let projectName: string;

  if (typeof cwdOrResolved === 'string') {
    chiralDir = join(cwdOrResolved, '.chiral');
    projectName = ''; // resolved from config.json below
  } else {
    const active = cwdOrResolved ?? resolveActiveProject();
    chiralDir = active.chiralDir;
    projectName = active.name;
  }

  const configPath = join(chiralDir, 'config.json');

  if (!existsSync(configPath)) {
    throw new UserError("No .chiral/config.json found. Run 'chiral environment add <env>' to set up an environment.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    throw new UserError(`Could not read ${configPath} - is it valid JSON?`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const firstError = result.error.issues[0];
    const field = firstError.path.join('.');
    throw new UserError(
      `Invalid config: ${field ? field + ': ' : ''}${firstError.message}`,
    );
  }

  return { config: result.data, chiralDir, projectName: projectName || result.data.project };
}

export function loadConfig(): Config {
  return loadConfigAndDir().config;
}

export function findChiralDir(cwd?: string): string | null {
  if (cwd) {
    const candidate = join(cwd, '.chiral');
    if (existsSync(candidate)) return candidate;
  }
  try {
    return resolveActiveProject().chiralDir;
  } catch {
    return null;
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

export function updateConfigExampleEnvs(
  chiralDir: string,
  updateFn: (envs: Record<string, Record<string, unknown>>) => void,
): void {
  const examplePath = join(chiralDir, 'config.example.json');
  if (!existsSync(examplePath)) return;
  try {
    const raw = JSON.parse(readFileSync(examplePath, 'utf-8')) as Record<string, unknown>;
    if (!raw.environments || typeof raw.environments !== 'object') {
      raw.environments = {};
    }
    const envs = raw.environments as Record<string, Record<string, unknown>>;
    updateFn(envs);
    writeFileSync(examplePath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  } catch {
    // silently fail
  }
}

// ── parseConfigExample ────────────────────────────────────────────────────────

export interface ParsedConfigExampleEnv {
  /** Pre-filled URL from the example, or undefined if it looks like a placeholder */
  url: string | undefined;
}

export interface ParsedConfigExample {
  /** Project name from the example file */
  project: string;
  /** Ordered map of env name → optional pre-filled URL */
  envs: Record<string, ParsedConfigExampleEnv>;
  /** Verbatim gitSync block if present */
  gitSync?: unknown;
}

const PLACEHOLDER_URL_PATTERNS = ['your-domain', 'example.com', 'localhost'];

function isPlaceholderUrl(url: unknown): boolean {
  if (typeof url !== 'string') return true;
  return PLACEHOLDER_URL_PATTERNS.some((p) => url.includes(p));
}

function isPlaceholderApiKey(apiKey: unknown): boolean {
  if (typeof apiKey !== 'string') return true;
  return apiKey.startsWith('YOUR_');
}

export function parseConfigExample(chiralDir: string): ParsedConfigExample {
  const examplePath = join(chiralDir, 'config.example.json');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(examplePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    throw new UserError(
      'Found .chiral/ but config.example.json is missing or invalid. Ask a teammate to share it.',
    );
  }

  const project = typeof raw['project'] === 'string' && raw['project'] ? raw['project'] : 'my-project';
  const rawEnvs = (raw['environments'] ?? {}) as Record<string, Record<string, unknown>>;

  const envs: Record<string, ParsedConfigExampleEnv> = {};
  for (const [name, envObj] of Object.entries(rawEnvs)) {
    const url = envObj['url'];
    const apiKey = envObj['apiKey'];
    // Suppress URL pre-fill if URL or apiKey looks like a placeholder
    const prefilledUrl = (!isPlaceholderUrl(url) && !isPlaceholderApiKey(apiKey)) ? (url as string) : undefined;
    envs[name] = { url: prefilledUrl };
  }

  return {
    project,
    envs,
    gitSync: raw['gitSync'],
  };
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

export function updateExampleGitSync(chiralDir: string, gitSync: GitSync | undefined): void {
  const examplePath = join(chiralDir, 'config.example.json');
  if (!existsSync(examplePath)) return;
  try {
    const raw = JSON.parse(readFileSync(examplePath, 'utf-8')) as Record<string, unknown>;
    if (gitSync) {
      raw['gitSync'] = gitSync;
    } else {
      delete raw['gitSync'];
    }
    const tmp = examplePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    renameSync(tmp, examplePath);
  } catch {
    // best-effort
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