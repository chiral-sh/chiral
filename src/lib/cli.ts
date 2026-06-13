import chalk from 'chalk';
import type ora from 'ora';

export function failSpinner(spinner: ReturnType<typeof ora>, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  spinner.stop();
  console.error(`  ${chalk.red('✗')}  ${msg}`);
  console.error();
  if (err instanceof Error) {
    (err as unknown as Record<string, unknown>).__alreadyDisplayed = true;
  }
  throw err;
}

export function plural(n: number, word: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? word : (pluralForm ?? `${word}s`)}`;
}

export function matchesGlob(name: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(name);
}

export function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex -- stripping ANSI color escape codes
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function padRight(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - visibleLen(s)));
}

export function formatAge(ageSeconds: number, style: 'short' | 'long' = 'short'): string {
  if (style === 'long') {
    if (ageSeconds < 3600) {
      const mins = Math.floor(ageSeconds / 60);
      return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
    }
    if (ageSeconds < 86400) {
      const hrs = Math.floor(ageSeconds / 3600);
      return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
    }
    const days = Math.floor(ageSeconds / 86400);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }
  if (ageSeconds < 3600) return `${Math.max(1, Math.floor(ageSeconds / 60))}m`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h`;
  const days = Math.floor(ageSeconds / 86400);
  return `${days} day${days !== 1 ? 's' : ''}`;
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
