import { Command } from 'commander';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfigAndDir } from '../lib/config.js';
import { UserError, ControlledExit } from '../lib/errors.js';
import { printJson } from '../lib/output.js';
import { readAuditLog, AuditEntrySchema, type AuditEntry } from '../state/audit.js';
import { listDeployments, readSnapshotMeta, listSnapshotWorkflows } from '../state/snapshots.js';
import { listLocks } from '../state/locks.js';
import { writeStatusSentinel } from '../state/sentinel.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StatusOptions {
  env?: string;
  json?: boolean;
  staleAfter?: number;
  staleLockAfter?: number;
  noHumanize?: boolean;
  verbose?: boolean;
  compact?: boolean;
  summary?: boolean;
  fields?: string;
}

interface EnvRow {
  name: string;
  lastPull: string | null;
  lastPush: string | null;
  workflowCount: number | null;
  stale: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findNearestEnv(input: string, names: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const name of names) {
    const d = levenshtein(input.toLowerCase(), name.toLowerCase());
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return bestDist <= 3 ? best : undefined;
}

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

function compactAge(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 3_600_000) return 'just now';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(ms / 86_400_000);
  return `${days}d`;
}

type ColKey = 'env' | 'lastPull' | 'lastPush' | 'workflows' | 'drift';

const COLUMN_HEADERS: Record<ColKey, string> = {
  env: 'env',
  lastPull: 'last pull',
  lastPush: 'last push',
  workflows: 'workflows',
  drift: 'drift',
};

const COLUMN_ORDER: ColKey[] = ['env', 'lastPull', 'lastPush', 'workflows', 'drift'];

const VALID_FIELDS = ['name', 'last_pull', 'last_push', 'workflow_count', 'stale', 'drift'] as const;
type FieldName = (typeof VALID_FIELDS)[number];

const FIELD_TO_COL: Partial<Record<FieldName, ColKey>> = {
  name: 'env',
  last_pull: 'lastPull',
  last_push: 'lastPush',
  workflow_count: 'workflows',
  drift: 'drift',
};

function buildCellValues(row: EnvRow, noHumanize: boolean): Record<ColKey, string> {
  const lastPullCell = row.lastPull
    ? humanize(row.lastPull, noHumanize) + (row.stale ? ' !' : '')
    : 'never !';
  return {
    env: row.name,
    lastPull: lastPullCell,
    lastPush: row.lastPush ? humanize(row.lastPush, noHumanize) : '—',
    workflows: row.workflowCount === null ? '—' : row.workflowCount === 0 ? '0 (!)' : String(row.workflowCount),
    drift: '—',
  };
}

function renderTable(rows: EnvRow[], noHumanize: boolean, cols: ColKey[] = COLUMN_ORDER): string[] {
  const allCells = rows.map(row => buildCellValues(row, noHumanize));

  const widths: Record<ColKey, number> = {} as Record<ColKey, number>;
  for (const col of cols) {
    widths[col] = Math.max(
      COLUMN_HEADERS[col].length,
      ...allCells.map(c => c[col].length),
    );
  }

  function borderLine(left: string, mid: string, right: string): string {
    return '  ' + left + cols.map(c => '─'.repeat(widths[c] + 2)).join(mid) + right;
  }

  function dataLine(vals: Record<ColKey, string>): string {
    return '  │' + cols.map(c => ' ' + vals[c].padEnd(widths[c]) + ' ').join('│') + '│';
  }

  const lines: string[] = [];
  lines.push(borderLine('┌', '┬', '┐'));
  lines.push(dataLine(COLUMN_HEADERS));
  lines.push(borderLine('├', '┼', '┤'));
  for (const cell of allCells) {
    lines.push(dataLine(cell));
  }
  lines.push(borderLine('└', '┴', '┘'));
  return lines;
}

// Lenient deployment finder: checks raw JSON `env` field without full Zod validation.
// Allows detecting deployments whose meta.json has the right env but fails full schema.
function findLatestDeploymentForEnvLenient(chiralDir: string, env: string): string | undefined {
  for (const id of listDeployments(chiralDir)) {
    try {
      const metaPath = join(chiralDir, 'snapshots', id, 'meta.json');
      if (!existsSync(metaPath)) continue;
      const raw = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
      if (raw['env'] === env) return id;
    } catch { /* skip unreadable deployments */ }
  }
  return undefined;
}

// ── Run function ──────────────────────────────────────────────────────────────

export async function runStatus(options: StatusOptions): Promise<void> {
  const { config, chiralDir } = loadConfigAndDir();

  const allEnvNames = Object.keys(config.environments);
  // Zod schema already enforces ≥1 env, but guard for belt-and-suspenders
  if (allEnvNames.length === 0) {
    throw new UserError("No environments configured. Run 'chiral environment add' to add one.");
  }

  let envFilter = allEnvNames;
  if (options.env) {
    if (!config.environments[options.env]) {
      const nearest = findNearestEnv(options.env, allEnvNames);
      const available = allEnvNames.join(', ');
      if (nearest) {
        throw new UserError(`Unknown environment '${options.env}'. Did you mean '${nearest}'? Available: ${available}`);
      }
      throw new UserError(`Unknown environment '${options.env}'. Available: ${available}`);
    }
    envFilter = [options.env];
  }

  if (options.staleAfter !== undefined && (isNaN(options.staleAfter) || options.staleAfter < 1 || !Number.isInteger(options.staleAfter))) {
    throw new UserError('--stale-after must be a positive integer (e.g. --stale-after 7)');
  }
  if (options.staleLockAfter !== undefined && (isNaN(options.staleLockAfter) || options.staleLockAfter < 1 || !Number.isInteger(options.staleLockAfter))) {
    throw new UserError('--stale-lock-after must be a positive integer (e.g. --stale-lock-after 24)');
  }

  if (options.compact && options.json) {
    throw new UserError('--compact cannot be combined with --json');
  }
  if (options.summary && options.json) {
    throw new UserError('--summary cannot be combined with --json');
  }

  // Validate and parse --fields
  let requestedFields: FieldName[] | null = null;
  if (options.fields) {
    const cols = options.fields.split(',').map(s => s.trim());
    for (const col of cols) {
      if (!(VALID_FIELDS as readonly string[]).includes(col)) {
        throw new UserError(`Unknown column '${col}'. Valid columns: ${VALID_FIELDS.join(', ')}`);
      }
    }
    requestedFields = cols as FieldName[];
  }

  const staleAfterDays = options.staleAfter ?? 7;
  const staleAfterExplicit = options.staleAfter !== undefined;
  const staleLockAfterMs = (options.staleLockAfter ?? 24) * 3_600_000;

  if (options.verbose) console.error('  verbose: reading audit.jsonl');

  let auditEntries: AuditEntry[] = [];
  try {
    auditEntries = readAuditLog(chiralDir);

    // Tail integrity check (success path only — belt-and-suspenders for partial writes)
    const auditPath = join(chiralDir, 'audit.jsonl');
    if (existsSync(auditPath)) {
      const rawLines = readFileSync(auditPath, 'utf-8').split('\n').filter(l => l.trim());
      let tailWarned = false;
      for (const line of rawLines.slice(-2)) {
        if (tailWarned) break;
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          if (!raw['event_id']) {
            console.error('  Warning: audit.jsonl tail appears corrupted — last entry may be incomplete');
            tailWarned = true;
          }
        } catch {
          console.error('  Warning: audit.jsonl tail appears corrupted — last entry may be incomplete');
          tailWarned = true;
        }
      }
    }
  } catch (err) {
    if (err instanceof UserError) {
      console.error('  Warning: audit.jsonl may be incomplete — timestamps shown may be inaccurate');
      // Fallback: collect any parseable, valid-schema entries line by line
      const auditPath = join(chiralDir, 'audit.jsonl');
      if (existsSync(auditPath)) {
        for (const line of readFileSync(auditPath, 'utf-8').split('\n').filter(l => l.trim())) {
          try {
            const raw = JSON.parse(line) as unknown;
            const result = AuditEntrySchema.safeParse(raw);
            if (result.success) auditEntries.push(result.data);
          } catch { /* skip invalid lines */ }
        }
      }
    } else {
      throw err;
    }
  }

  // Single reverse-scan: first pull/push per env, early-terminate once all slots filled
  const lastPullMap: Record<string, string> = {};
  const lastPushMap: Record<string, string> = {};
  const targetSet = new Set(envFilter);
  let remaining = targetSet.size * 2;
  for (let i = auditEntries.length - 1; i >= 0 && remaining > 0; i--) {
    const e = auditEntries[i];
    if (!targetSet.has(e.target_env) || e.result !== 'success') continue;
    if (e.action === 'pull' && !lastPullMap[e.target_env]) {
      lastPullMap[e.target_env] = e.timestamp;
      remaining--;
    } else if (e.action === 'push' && !lastPushMap[e.target_env]) {
      lastPushMap[e.target_env] = e.timestamp;
      remaining--;
    }
  }

  // Per-env snapshot data
  const envRows: EnvRow[] = [];
  const zeroWorkflowEnvs: string[] = [];

  for (const envName of envFilter) {
    if (options.verbose) console.error(`  verbose: reading snapshots for ${envName}`);

    const lastPull = lastPullMap[envName] ?? null;
    const lastPush = lastPushMap[envName] ?? null;

    const staleMs = lastPull ? Date.now() - new Date(lastPull).getTime() : Infinity;
    const stale = staleMs > staleAfterDays * 86_400_000;

    const deploymentId = findLatestDeploymentForEnvLenient(chiralDir, envName);
    let workflowCount: number | null = null;

    if (deploymentId) {
      if (options.verbose) console.error(`  verbose: reading snapshot meta for ${envName} (${deploymentId})`);
      const meta = readSnapshotMeta(chiralDir, deploymentId);
      if (meta) {
        workflowCount = meta.workflow_count;
      } else {
        console.error(`  Warning: ${envName}: snapshot meta unreadable — workflow count unavailable`);
        try {
          workflowCount = listSnapshotWorkflows(chiralDir, deploymentId).length;
        } catch {
          workflowCount = null;
        }
      }
    }

    if (workflowCount === 0) zeroWorkflowEnvs.push(envName);

    envRows.push({ name: envName, lastPull, lastPush, workflowCount, stale });
  }

  // Locks
  if (options.verbose) console.error('  verbose: reading locks');
  const rawLocks = listLocks(chiralDir);
  const locks = rawLocks.map(({ workflowId, lock }) => ({
    workflowId,
    actor: lock.actor,
    hostname: lock.hostname,
    since: lock.timestamp,
    staleLock: (Date.now() - new Date(lock.timestamp).getTime()) > staleLockAfterMs,
  }));

  const anyStale = envRows.some(r => r.stale);

  // ── Output ────────────────────────────────────────────────────────────────

  if (options.compact) {
    for (const row of envRows) {
      const staleIcon = row.stale ? '!' : '✓';
      const age = compactAge(row.lastPull);
      const count = row.workflowCount === null ? '—' : String(row.workflowCount);
      console.log(`${row.name}\t${staleIcon}\t${age}\t${count}wf\t${locks.length} locks`);
    }
    writeStatusSentinel(chiralDir);
    if (anyStale) throw new ControlledExit(3);
    return;
  }

  if (options.summary) {
    const total = envRows.length;
    const staleCount = envRows.filter(r => r.stale).length;
    if (staleCount > 0) {
      console.log(`${staleCount}/${total} envs stale, ${locks.length} locks`);
    } else {
      console.log(`${total}/${total} envs synced, ${locks.length} locks`);
    }
    writeStatusSentinel(chiralDir);
    if (anyStale) throw new ControlledExit(3);
    return;
  }

  if (options.json) {
    const envObjects = envRows.map(r => {
      const full: Record<string, unknown> = {
        name: r.name,
        last_pull: r.lastPull,
        last_push: r.lastPush,
        workflow_count: r.workflowCount,
        stale: r.stale,
        drift: null,
      };
      if (requestedFields) {
        return Object.fromEntries(Object.entries(full).filter(([k]) => requestedFields!.includes(k as FieldName)));
      }
      return full;
    });

    printJson({
      project: config.project,
      environments: envObjects,
      locks: locks.map(l => ({
        workflow_id: l.workflowId,
        actor: l.actor,
        hostname: l.hostname,
        since: l.since,
        stale_lock: l.staleLock,
      })),
    });
  } else {
    const noHumanize = options.noHumanize ?? false;

    // Derive table columns from --fields if specified
    const tableCols: ColKey[] = requestedFields
      ? COLUMN_ORDER.filter(col =>
          Object.entries(FIELD_TO_COL).some(([f, c]) => c === col && requestedFields!.includes(f as FieldName))
        )
      : COLUMN_ORDER;

    console.log();
    console.log(`  ${config.project}`);
    console.log();

    for (const line of renderTable(envRows, noHumanize, tableCols)) console.log(line);

    for (const envName of zeroWorkflowEnvs) {
      console.log(`\n  ⚠  ${envName} has 0 workflows — last pull may have failed. Run 'chiral pull --env ${envName}' to resync.`);
    }

    if (locks.length > 0) {
      console.log(`\n  Locks (${locks.length} active)`);
      console.log('  ' + '─'.repeat(71));
      for (const lock of locks) {
        const age = humanize(lock.since, false);
        const staleLabel = lock.staleLock ? `   STALE (>${options.staleLockAfter ?? 24}h — may be abandoned)` : '';
        console.log(`  ${lock.workflowId}   ${lock.actor} (${lock.hostname})   since ${age}${staleLabel}`);
      }
    }

    console.log();
  }

  writeStatusSentinel(chiralDir);

  if (staleAfterExplicit && anyStale) throw new ControlledExit(3);
}

// ── Command definition ────────────────────────────────────────────────────────

export const statusCommand = new Command('status')
  .description('Show environment health snapshot (last pull/push timestamps, workflow count, locks)')
  .option('--env <env>', 'Show status for a single environment only')
  .option('--json', 'Emit standard JSON envelope to stdout instead of text table')
  .option('--stale-after <days>', 'Mark last pull as stale when older than N days (default 7; must be ≥ 1)', parseInt)
  .option('--stale-lock-after <hours>', 'Mark locks as STALE when older than N hours (default 24; must be ≥ 1)', parseInt)
  .option('--no-humanize', 'Show ISO-8601 timestamps instead of relative time in text mode')
  .option('--verbose', 'Print each state file read to stderr before rendering')
  .option('--compact', 'Output one tab-separated line per env; exits 3 if any env is stale')
  .option('--summary', 'Output a single summary line; exits 3 if any env is stale')
  .option('--fields <cols>', 'Comma-separated column selector (name,last_pull,last_push,workflow_count,stale,drift)')
  .addHelpText(
    'after',
    `
Examples:
  Show status for all environments:
    chiral status

  Show status with exact timestamps:
    chiral status --no-humanize

  Machine-readable output:
    chiral status --json

  CI gate — exit 3 if any env not pulled in 5 days:
    chiral status --stale-after 5

  Compact one-line-per-env output:
    chiral status --compact

  Shell prompt summary token:
    chiral status --summary

  Select specific columns:
    chiral status --fields name,last_pull,workflow_count
`,
  )
  .action(async (opts: Record<string, unknown>) => {
    const { humanize: humanizeFlag, ...rest } = opts;
    await runStatus({
      ...rest as StatusOptions,
      noHumanize: humanizeFlag === false,
    });
  });
