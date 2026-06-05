import { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { loadConfigAndDir } from '../lib/config.js';
import { UserError } from '../lib/errors.js';
import { printJson } from '../lib/output.js';
import { visibleLen, padRight } from '../lib/cli.js';
import { readAuditLog, AuditEntrySchema, AuditActionSchema, type AuditEntry } from '../state/audit.js';
import { readStatusSentinel } from '../state/sentinel.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LogOptions {
  env?: string;
  action?: string;
  actor?: string;
  result?: string;
  since?: string;
  limit?: number;
  all?: boolean;
  noHumanize?: boolean;
  watch?: boolean;
  json?: boolean;
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_ACTIONS = AuditActionSchema.options;
const VALID_RESULTS = ['success', 'failure', 'aborted'] as const;

function validateLogOptions(options: LogOptions): void {
  if (options.json && options.watch) {
    throw new UserError('--json and --watch are mutually exclusive');
  }
  if (options.action !== undefined && !(VALID_ACTIONS as readonly string[]).includes(options.action)) {
    throw new UserError(
      `Unknown action "${options.action}". Valid actions: ${VALID_ACTIONS.join(', ')}`,
    );
  }
  if (options.result !== undefined && !(VALID_RESULTS as readonly string[]).includes(options.result)) {
    throw new UserError(
      `Unknown result "${options.result}". Valid results: ${VALID_RESULTS.join(', ')}`,
    );
  }
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new UserError('--limit must be a positive integer');
    }
  }
}

// ── Since parsing ─────────────────────────────────────────────────────────────

function parseSinceDuration(value: string, chiralDir: string): Date {
  if (value === 'last-status') {
    const sentinel = readStatusSentinel(chiralDir);
    if (!sentinel) {
      throw new UserError("No status sentinel found. Run 'chiral status' first.");
    }
    return new Date(sentinel.last_status_at);
  }

  const match = /^(\d+)(m|h|d|w)$/.exec(value);
  if (!match) {
    throw new UserError(
      `Unrecognized --since value "${value}". Use a duration like 7d, 2h, 30m, or "last-status".`,
    );
  }

  const n = parseInt(match[1], 10);
  const unit = match[2];
  const msMap: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return new Date(Date.now() - n * msMap[unit]);
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function applyFilters(
  entries: AuditEntry[],
  options: LogOptions,
  sinceDate: Date | null,
): AuditEntry[] {
  let result = entries;

  if (options.env) {
    result = result.filter(
      (e) => e.target_env === options.env || e.source_env === options.env,
    );
  }
  if (options.action) {
    result = result.filter((e) => e.action === options.action);
  }
  if (options.actor) {
    result = result.filter((e) => e.actor === options.actor);
  }
  if (options.result) {
    result = result.filter((e) => e.result === options.result);
  }
  if (sinceDate) {
    result = result.filter((e) => new Date(e.timestamp) >= sinceDate);
  }

  return result;
}

// ── Timestamp humanizer ───────────────────────────────────────────────────────

function humanize(iso: string, noHumanize: boolean): string {
  if (noHumanize) return iso;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (ms < 3_600_000) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (ms < 86_400_000) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(ms / 86_400_000);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

// ── Table rendering ───────────────────────────────────────────────────────────

function resultCell(result: string): string {
  if (result === 'success') return chalk.green('✓ success');
  if (result === 'failure') return chalk.red('✗ failed');
  return chalk.yellow('⚠ aborted');
}

function envCell(entry: AuditEntry): string {
  const env = entry.source_env
    ? `${entry.source_env} → ${entry.target_env}`
    : entry.target_env;
  return chalk.cyan(env);
}

function renderLogTable(entries: AuditEntry[], noHumanize: boolean): string {
  type Col = 'time' | 'action' | 'env' | 'result' | 'actor';
  const HEADERS: Record<Col, string> = {
    time: 'TIME',
    action: 'ACTION',
    env: 'ENV',
    result: 'RESULT',
    actor: 'ACTOR',
  };
  const COLS: Col[] = ['time', 'action', 'env', 'result', 'actor'];

  // Build raw cell values per entry
  type CellRow = Record<Col, string>;
  const cells: CellRow[] = entries.map((e) => ({
    time: humanize(e.timestamp, noHumanize),
    action: e.action,
    env: envCell(e),
    result: resultCell(e.result),
    actor: e.actor,
  }));

  // Compute column widths
  const widths: Record<Col, number> = {} as Record<Col, number>;
  for (const col of COLS) {
    widths[col] = Math.max(
      visibleLen(HEADERS[col]),
      ...cells.map((c) => visibleLen(c[col])),
    );
  }

  function borderLine(left: string, mid: string, right: string): string {
    return '  ' + left + COLS.map((c) => '─'.repeat(widths[c] + 2)).join(mid) + right;
  }

  function dataLine(vals: CellRow): string {
    return '  │' + COLS.map((c) => ' ' + padRight(vals[c], widths[c]) + ' ').join('│') + '│';
  }

  const headerRow: CellRow = Object.fromEntries(
    COLS.map((c) => [c, chalk.dim(HEADERS[c])]),
  ) as CellRow;

  // Compute the offset to the start of RESULT column for sub-line alignment
  const resultColOffset =
    COLS.slice(0, COLS.indexOf('result')).reduce((acc, c) => acc + widths[c] + 3, 0) + 3; // 3 = " │" + leading space

  const lines: string[] = [];
  lines.push(borderLine('┌', '┬', '┐'));
  lines.push(dataLine(headerRow));
  lines.push(borderLine('├', '┼', '┤'));

  for (let i = 0; i < entries.length; i++) {
    lines.push(dataLine(cells[i]));
    const e = entries[i];
    if (e.result === 'failure' && e.error) {
      const maxLen = 72;
      let errMsg = e.error;
      if (visibleLen(errMsg) > maxLen) {
        errMsg = errMsg.slice(0, maxLen - 1) + '…';
      }
      const indent = ' '.repeat(resultColOffset);
      lines.push('  │' + indent + chalk.dim(errMsg));
    }
  }

  lines.push(borderLine('└', '┴', '┘'));
  return lines.join('\n');
}

// ── Activity summary footer ───────────────────────────────────────────────────

function buildSummaryLine(entries: AuditEntry[]): string | null {
  const total = entries.length;
  if (total === 0) return null;

  const actionCounts: Record<string, number> = {};
  let failCount = 0;

  for (const e of entries) {
    actionCounts[e.action] = (actionCounts[e.action] ?? 0) + 1;
    if (e.result === 'failure') failCount++;
  }

  const actionTypes = Object.keys(actionCounts);
  // Omit summary when single action type and all success
  if (actionTypes.length === 1 && failCount === 0) return null;

  const actionParts = actionTypes
    .sort()
    .map((a) => `${actionCounts[a]} ${a}${actionCounts[a] !== 1 ? 's' : ''}`)
    .join(', ');

  let line = `  ${total} operation${total !== 1 ? 's' : ''}: ${actionParts}`;
  if (failCount > 0) {
    line += ` — ${chalk.red(`${failCount} failure${failCount !== 1 ? 's' : ''}`)}`;
  }
  return line;
}

// ── Pager ─────────────────────────────────────────────────────────────────────

function printWithPager(content: string, rowCount: number): void {
  const isTTY = process.stdout.isTTY;
  const isCI = process.env['CI'] === 'true';

  if (isTTY && !isCI && rowCount > 40) {
    const pager = process.env['CHIRAL_PAGER'] ?? process.env['PAGER'] ?? 'less';
    const result = spawnSync(pager, ['-FIRX'], {
      input: content,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (result.error) {
      // Pager failed — fall back to direct print
      console.log(content);
    }
    return;
  }

  console.log(content);
}

// ── Lenient audit read ────────────────────────────────────────────────────────

function readAuditLogLenient(chiralDir: string): AuditEntry[] {
  const auditPath = join(chiralDir, 'audit.jsonl');
  if (!existsSync(auditPath)) return [];

  const lines = readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '');

  const entries: AuditEntry[] = [];
  let skipped = 0;

  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as unknown;
      const result = AuditEntrySchema.safeParse(raw);
      if (result.success) {
        entries.push(result.data);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  if (skipped > 0) {
    console.error(`  Warning: skipped ${skipped} malformed line(s) in audit.jsonl`);
  }

  return entries;
}

// ── Run function ──────────────────────────────────────────────────────────────

export async function runLog(options: LogOptions, cwd = process.cwd()): Promise<void> {
  validateLogOptions(options);

  const outputMode = options.json ? 'json' : 'human';

  async function doOnce(): Promise<void> {
    const { config, chiralDir } = loadConfigAndDir(cwd);

    // Validate --env against config
    if (options.env && !config.environments[options.env]) {
      throw new UserError(
        `Environment "${options.env}" not found in config. Run 'chiral environment list' to see available environments.`,
      );
    }

    // Parse --since before loading audit data
    let sinceDate: Date | null = null;
    if (options.since !== undefined) {
      sinceDate = parseSinceDuration(options.since, chiralDir);
    }

    // Load audit entries (lenient — tolerate corruption)
    let allEntries: AuditEntry[] = [];
    try {
      allEntries = readAuditLog(chiralDir);
    } catch (err) {
      if (err instanceof UserError) {
        allEntries = readAuditLogLenient(chiralDir);
      } else {
        throw err;
      }
    }

    // Entries in file are oldest-first; reverse for newest-first display
    const reversed = [...allEntries].reverse();

    // Apply filters
    const filtered = applyFilters(reversed, options, sinceDate);

    // Empty log case
    if (filtered.length === 0 && allEntries.length === 0) {
      if (outputMode === 'human') {
        console.log();
        console.log('  No activity recorded yet.');
        console.log();
      } else {
        printJson({ entries: [], total_shown: 0, has_more: false });
      }
      return;
    }

    // Apply limit
    const limit = options.limit ?? 50;
    const showAll = options.all === true;
    const hasMore = !showAll && filtered.length > limit;
    const displayed = showAll ? filtered : filtered.slice(0, limit);

    if (outputMode === 'json') {
      const jsonEntries = displayed.map((e) => {
        const obj: Record<string, unknown> = { ...e };
        if (obj['match_method'] == null) delete obj['match_method'];
        if (obj['match_score'] == null) delete obj['match_score'];
        return obj;
      });
      printJson({ entries: jsonEntries, total_shown: displayed.length, has_more: hasMore });
      return;
    }

    // Human mode output
    const lines: string[] = [];

    // Count header
    lines.push('');
    if (sinceDate && !showAll) {
      lines.push(`  Showing ${displayed.length} entries since ${humanize(sinceDate.toISOString(), false)}`);
    } else if (showAll || !hasMore) {
      lines.push(`  Showing ${displayed.length} of ${filtered.length} entries`);
    } else {
      lines.push(`  Showing last ${displayed.length} entries`);
    }
    lines.push('');

    if (displayed.length === 0) {
      lines.push('  No matching entries.');
      lines.push('');
      const output = lines.join('\n');
      printWithPager(output, 0);
      return;
    }

    // Table
    lines.push(renderLogTable(displayed, options.noHumanize ?? false));
    lines.push('');

    // Activity summary footer
    const summaryLine = buildSummaryLine(displayed);
    if (summaryLine) {
      lines.push(summaryLine);
      lines.push('');
    }

    // Truncation-honesty footer
    if (hasMore) {
      lines.push(`  Showing last ${displayed.length} entries — pass --all to see everything.`);
    } else {
      lines.push(`  Showing ${displayed.length} of ${displayed.length} entries.`);
    }
    lines.push('');

    const output = lines.join('\n');
    printWithPager(output, displayed.length);
  }

  if (options.watch) {
    if (!process.stdout.isTTY) {
      await doOnce();
      return;
    }

    process.stdout.write('\x1b[2J\x1b[H');
    try { await doOnce(); } catch { /* keep watching on render errors */ }

    const { chiralDir: watchDir } = loadConfigAndDir(cwd);
    const auditPath = join(watchDir, 'audit.jsonl');

    await new Promise<void>((resolve) => {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const watcher = fsWatch(auditPath, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          process.stdout.write('\x1b[2J\x1b[H');
          try { await doOnce(); } catch { /* keep watching */ }
        }, 150);
      });
      process.once('SIGINT', () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        watcher.close();
        process.stdout.write('\n  Stopped watching.\n');
        resolve();
      });
    });
    return;
  }

  await doOnce();
}

// ── Command definition ────────────────────────────────────────────────────────

export const logCommand = new Command('log')
  .description('Show audit log of all operations recorded in .chiral/audit.jsonl (newest first)')
  .option('--env <env>', 'Filter to entries where source_env or target_env matches this name')
  .option('--action <action>', `Filter by action type (${['push', 'pull', 'diff', 'rollback', 'lock', 'unlock', 'adopt', 'init', 'map', 'unmap'].join('|')})`)
  .option('--actor <email>', 'Filter to entries where actor matches this email (exact match)')
  .option('--result <result>', 'Filter by result: success|failure|aborted')
  .option('--since <value>', 'Show only entries after this point: duration (7d, 2h, 30m, 4w) or "last-status"')
  .option('--limit <n>', 'Maximum entries to show (default 50, must be ≥ 1)', parseInt)
  .option('--all', 'Remove the count cap; show all matching entries (overrides --limit)')
  .option('--no-humanize', 'Show ISO-8601 timestamps instead of relative age strings')
  .option('--watch', 'Re-render on audit.jsonl changes; silently runs once when stdout is not a TTY')
  .option('--json', 'Emit standard JSON envelope to stdout instead of text table')
  .addHelpText(
    'after',
    `
Examples:
  Show recent activity (default last 50 entries):
    chiral log

  Filter by environment and action:
    chiral log --env prod --action push

  Machine-readable output with jq:
    chiral log --since 7d --json | jq '.data.entries[0]'

  Watch mode (re-renders on changes):
    chiral log --all --watch
`,
  )
  .action(async (opts: Record<string, unknown>) => {
    const { humanize: humanizeFlag, ...rest } = opts;
    await runLog({
      ...rest as LogOptions,
      noHumanize: humanizeFlag === false,
    });
  });
