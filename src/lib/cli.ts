import chalk from 'chalk';
import type ora from 'ora';

export function failSpinner(spinner: ReturnType<typeof ora>, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  spinner.fail(chalk.red(`  ${msg}`));
  throw err;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function matchesGlob(name: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(name);
}

const BUILTIN_ENV_NAMES = ['dev', 'staging', 'prod', 'stg', 'test', 'qa', 'uat'];

export function detectsEnvMarker(name: string, configuredEnvNames: string[]): boolean {
  const allEnvs = [...new Set([...configuredEnvNames.map((e) => e.toLowerCase()), ...BUILTIN_ENV_NAMES])];
  const lower = name.toLowerCase();
  for (const env of allEnvs) {
    if (lower.includes(`[${env}]`)) return true;
    if (lower.endsWith(`_${env}`)) return true;
    if (lower.endsWith(` - ${env}`)) return true;
    if (lower.endsWith(`-${env}`)) return true;
  }
  return false;
}
