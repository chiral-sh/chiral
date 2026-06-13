import chalk from 'chalk';
import { visibleLen, padRight, formatAge } from './cli.js';

export interface LockListEntry {
  workflowId: string;
  logicalName: string;
  env: string;
  actor: string;
  hostname: string;
  timestamp: string;
  ageSeconds: number;
  reason?: string;
  stale: boolean;
}

export function renderLockTable(entries: LockListEntry[]): void {
  if (entries.length === 0) {
    console.log('\n  No active locks.\n');
    return;
  }

  const hasReason = entries.some((e) => e.reason);

  const C_ENV = Math.max('env'.length, ...entries.map((e) => e.env.length));
  const C_WF = Math.max(
    'workflow'.length,
    ...entries.map((e) => visibleLen(e.logicalName + (e.stale ? ' ⚠' : ''))),
  );
  const C_ACTOR = Math.max('actor'.length, ...entries.map((e) => e.actor.length));
  const C_AGE = Math.max('age'.length, ...entries.map((e) => formatAge(e.ageSeconds).length));
  const widths: number[] = hasReason
    ? [
        C_ENV,
        C_WF,
        C_ACTOR,
        C_AGE,
        Math.max('reason'.length, ...entries.map((e) => (e.reason ?? '').length)),
      ]
    : [C_ENV, C_WF, C_ACTOR, C_AGE];

  const headers = hasReason
    ? ['env', 'workflow', 'actor', 'age', 'reason']
    : ['env', 'workflow', 'actor', 'age'];

  const top = '  ┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const sep = '  ├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '  └' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
  const headerRow =
    '  │ ' +
    widths.map((w, i) => padRight(chalk.dim(headers[i]), w)).join(' │ ') +
    ' │';

  console.log(`\n  ${chalk.bold('Active locks')}\n`);
  console.log(top);
  console.log(headerRow);
  console.log(sep);

  for (const entry of entries) {
    const wfDisplay = entry.stale
      ? `${entry.logicalName} ${chalk.yellow('⚠')}`
      : entry.logicalName;
    const cells = [
      padRight(entry.env, widths[0]),
      padRight(wfDisplay, widths[1]),
      padRight(entry.actor, widths[2]),
      padRight(formatAge(entry.ageSeconds), widths[3]),
      ...(hasReason ? [padRight(entry.reason ?? '', widths[4])] : []),
    ];
    console.log('  │ ' + cells.join(' │ ') + ' │');
  }

  console.log(bot);
  console.log();
}
