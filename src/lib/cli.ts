import chalk from 'chalk';
import type ora from 'ora';

let _chiralVersion = '0.0.0';

export function setChiralVersion(v: string): void {
  _chiralVersion = v;
}

export function getChiralVersion(): string {
  return _chiralVersion;
}

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

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function normalizedSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export function renderBoxTable(
  widths: number[],
  headerCells: string[],
  rows: Array<{ label: string; hasGap: boolean; cells: string[] }>,
): void {
  const top = '  ┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const sep = '  ├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '  └' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
  const headerRow = '  │ ' + headerCells.map((h, i) => padRight(h, widths[i])).join(' │ ') + ' │';
  console.log();
  console.log(top);
  console.log(headerRow);
  console.log(sep);
  for (const { label, hasGap, cells } of rows) {
    const labelStr = hasGap ? chalk.yellow(label) : label;
    const allCells = [padRight(labelStr, widths[0]), ...cells.map((c, i) => padRight(c, widths[i + 1]))];
    console.log('  │ ' + allCells.join(' │ ') + ' │');
  }
  console.log(bot);
  console.log();
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
