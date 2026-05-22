import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { UserError } from './errors.js';

export interface ConfigWithDir {
  config: Config;
  flightdeckDir: string;
}

const EnvironmentSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().min(1),
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
});

export type Config = z.infer<typeof ConfigSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;

function findConfigPath(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const candidate = join(current, '.flightdeck', 'config.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadConfigAndDir(startDir: string = process.cwd()): ConfigWithDir {
  const configPath = findConfigPath(startDir);
  if (!configPath) {
    throw new UserError("No .flightdeck/config.json found. Run 'flightdeck init' first.");
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

  return { config: result.data, flightdeckDir: dirname(configPath) };
}

export function loadConfig(startDir: string = process.cwd()): Config {
  return loadConfigAndDir(startDir).config;
}

export function resolveEnv(config: Config, envName: string): Environment {
  const env = config.environments[envName];
  if (!env) {
    const available = Object.keys(config.environments).join(', ');
    throw new UserError(`Unknown environment "${envName}". Available: ${available}`);
  }
  return env;
}