import { execSync } from 'node:child_process';
import { watch } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { Command } from 'commander';
import { loadConfigAndDir, findChiralDir } from '../lib/config.js';
import { resolveEnvId, buildEnvIdToNameMap } from '../state/envs.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure } from '../lib/git-sync.js';
import { UserError, ControlledExit } from '../lib/errors.js';
import { printJson } from '../lib/output.js';
import {
  writeLock,
  readLock,
  releaseLock,
  listAllLocks,
  listLocksByEnv,
  type LockFile,
} from '../state/locks.js';
import { writeAuditEntry } from '../state/audit.js';
import { loadWorkflowMap } from '../state/workflows.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getGitActor(): string {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    throw new UserError(
      'git config user.email is not set — configure it before running chiral',
    );
  }
}

function parseDuration(s: string): number {
  const match = /^(\d+)(h|m|d)$/.exec(s);
  if (!match) {
    throw new UserError(
      `Cannot parse duration "${s}". Use a number followed by h, m, or d (e.g. 2h, 30m, 1d).`,
    );
  }
  const n = parseInt(match[1]!, 10);
  if (n <= 0) throw new UserError('--stale value must be greater than zero (e.g. --stale 2h)');
  const multipliers: Record<string, number> = { h: 3600, m: 60, d: 86400 };
  return n * (multipliers[match[2]!] ?? 3600);
}

function formatAge(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const days = Math.floor(seconds / 86400);
  return `${days} day${days !== 1 ? 's' : ''}`;
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padRight(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - visibleLen(s)));
}

function resolveWorkflowId(
  chiralDir: string,
  logicalName: string,
): { workflowId: string; resolved: boolean } {
  const map = loadWorkflowMap(chiralDir);
  const entry = map.workflows[logicalName];
  if (entry) {
    for (const envEntry of Object.values(entry)) {
      if (envEntry.id) return { workflowId: envEntry.id, resolved: true };
    }
  }
  return { workflowId: `logical-${logicalName}`, resolved: false };
}

function buildReverseWorkflowMap(chiralDir: string): Map<string, string> {
  const map = loadWorkflowMap(chiralDir);
  const reverse = new Map<string, string>();
  for (const [logicalName, envEntries] of Object.entries(map.workflows)) {
    for (const entry of Object.values(envEntries)) {
      if (entry.id) reverse.set(entry.id, logicalName);
    }
  }
  return reverse;
}

// ── runLockClaim ──────────────────────────────────────────────────────────────

export async function runLockClaim(
  logicalName: string,
  options: { env?: string; allEnvs?: boolean; reason?: string; json?: boolean },
): Promise<void> {
  if (options.env && options.allEnvs) {
    throw new UserError('--env and --all-envs are mutually exclusive');
  }
  if (!options.env && !options.allEnvs) {
    throw new UserError('Specify --env <env> or --all-envs');
  }

  const actor = getGitActor();
  const host = osHostname();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const { config } = loadConfigAndDir();
  const envs = Object.keys(config.environments);

  let targetEnvs: string[];
  if (options.allEnvs) {
    targetEnvs = envs;
  } else {
    const envName = options.env!;
    if (!(envName in config.environments)) {
      throw new UserError(
        `Unknown environment "${envName}". Available: ${envs.join(', ')}`,
      );
    }
    targetEnvs = [envName];
  }

  const { workflowId, resolved } = resolveWorkflowId(chiralDir, logicalName);

  if (!resolved && !options.json) {
    console.log(
      chalk.yellow(
        `  ⚠ "${logicalName}" not found in workflows.json — lock written with unresolved key.`,
      ),
    );
    console.log(
      chalk.dim("    Run 'chiral workflow map --validate' to link workflow names to IDs."),
    );
  }

  if (resolved) {
    const map = loadWorkflowMap(chiralDir);
    const envEntries = map.workflows[logicalName];
    for (const env of targetEnvs) {
      if (!envEntries?.[env]?.id) {
        throw new UserError(
          `"${logicalName}" is not mapped to environment "${env}". Run 'chiral workflow map' to add it.`,
        );
      }
    }
  }

  const writtenEnvs: string[] = [];

  for (const env of targetEnvs) {
    const envId = resolveEnvId(chiralDir, env);
    const existing = readLock(chiralDir, envId, workflowId);
    if (existing) {
      const ageSeconds = Math.floor(
        (Date.now() - new Date(existing.timestamp).getTime()) / 1000,
      );
      const age = formatAge(ageSeconds);

      // Rollback previously written locks
      for (const rollbackEnv of writtenEnvs) {
        try {
          releaseLock(chiralDir, resolveEnvId(chiralDir, rollbackEnv), workflowId);
        } catch {
          // best effort
        }
      }

      if (writtenEnvs.length > 0 && !options.json) {
        console.log();
        const rollbackList = writtenEnvs.map((e) => `lock in ${e}`).join(', ');
        console.log(`  Rolled back: removed ${rollbackList}.`);
      }

      if (options.json) {
        console.error(
          JSON.stringify({
            status: 'error',
            error: {
              code: 'lock_conflict',
              message: `${logicalName} is already locked in ${env} by ${existing.actor}`,
              retryable: false,
            },
          }),
        );
      } else if (targetEnvs.length === 1) {
        console.error(
          `  ${chalk.red('✗')} ${logicalName} is already locked in ${env} by ${existing.actor} (${age} ago)`,
        );
        console.error(
          chalk.dim(
            `    Run 'chiral unlock ${logicalName} --env ${env}' to release, or push with --yes to override.`,
          ),
        );
        console.error();
      } else {
        console.log(
          `  ${chalk.red('✗')} Locked ${logicalName} in ${env}  ← conflict: held by ${existing.actor} (${age} ago)`,
        );
      }
      throw new ControlledExit(6);
    }

    const timestamp = new Date().toISOString();
    writeLock(chiralDir, envId, workflowId, actor, host, {
      reason: options.reason,
      resolved,
    });
    writtenEnvs.push(env);

    if (!options.json) {
      console.log(`  ${chalk.green('✓')} Locked ${logicalName} in ${env}   (${actor})`);
    }

    // Store timestamp for single-env JSON output
    if (!options.allEnvs && options.json) {
      writeAuditEntry(chiralDir, {
        event_id: crypto.randomUUID(),
        event_schema_version: 1,
        timestamp: new Date().toISOString(),
        actor,
        action: 'lock',
        project: config.project,
        source_env: null,
        target_env: env,
        workflow_ids: [workflowId],
        result: 'success',
        error: null,
        chiral_version: '0.1.0',
      });
      printJson({
        workflowId,
        logicalName,
        env,
        actor,
        timestamp,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      });
      const syncResult = await syncToRemote(
        chiralDir,
        config,
        `chore(chiral): lock ${logicalName}`,
      );
      if (!syncResult.skipped && !syncResult.nothingToCommit && syncResult.success) {
        // sync output suppressed for JSON mode
      }
      return;
    }
  }

  writeAuditEntry(chiralDir, {
    event_id: crypto.randomUUID(),
    event_schema_version: 1,
    timestamp: new Date().toISOString(),
    actor,
    action: 'lock',
    project: config.project,
    source_env: null,
    target_env: targetEnvs.join(','),
    workflow_ids: [workflowId],
    result: 'success',
    error: null,
    chiral_version: '0.1.0',
  });

  if (options.json) {
    printJson({ locked: writtenEnvs, skipped: [] });
  }

  const syncResult = await syncToRemote(
    chiralDir,
    config,
    `chore(chiral): lock ${logicalName}`,
  );
  if (!options.json && !syncResult.skipped && !syncResult.nothingToCommit) {
    if (syncResult.success) {
      console.log(formatSyncSuccess(syncResult));
    } else {
      for (const line of formatSyncFailure(syncResult)) console.log(chalk.yellow(line));
    }
    console.log();
  }
}

// ── runLockList ───────────────────────────────────────────────────────────────

interface LockListEntry {
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

function buildLockList(
  chiralDir: string,
  options: { env?: string; stale?: string },
): LockListEntry[] {
  const staleThresholdSeconds = options.stale ? parseDuration(options.stale) : 86400;
  const reverse = buildReverseWorkflowMap(chiralDir);

  let rawLocks: Array<{ env: string; workflowId: string; lock: LockFile }>;
  if (options.env) {
    const envId = resolveEnvId(chiralDir, options.env);
    rawLocks = listLocksByEnv(chiralDir, envId).map(({ workflowId, lock }) => ({
      env: options.env!,
      workflowId,
      lock,
    }));
  } else {
    const idToName = buildEnvIdToNameMap(chiralDir);
    rawLocks = listAllLocks(chiralDir)
      .filter(({ envId }) => idToName.has(envId))
      .map(({ envId, workflowId, lock }) => ({
        env: idToName.get(envId)!,
        workflowId,
        lock,
      }));
  }

  const now = Date.now();
  const entries: LockListEntry[] = rawLocks.map(({ env, workflowId, lock }) => {
    const ageSeconds = Math.floor((now - new Date(lock.timestamp).getTime()) / 1000);
    const stale = ageSeconds > staleThresholdSeconds;
    const resolved = reverse.get(workflowId);
    const logicalName = resolved ?? `${workflowId} (unmapped)`;
    return {
      workflowId,
      logicalName,
      env,
      actor: lock.actor,
      hostname: lock.hostname,
      timestamp: lock.timestamp,
      ageSeconds,
      reason: lock.reason,
      stale,
    };
  });

  if (options.stale) {
    return entries.filter((e) => e.stale);
  }
  return entries;
}

function renderLockTable(entries: LockListEntry[]): void {
  if (entries.length === 0) {
    console.log('\n  No active locks.\n');
    return;
  }

  const hasReason = entries.some((e) => e.reason);

  const C_ENV = Math.max('ENV'.length, ...entries.map((e) => e.env.length));
  const C_WF = Math.max(
    'WORKFLOW'.length,
    ...entries.map((e) => visibleLen(e.logicalName + (e.stale ? ' ⚠' : ''))),
  );
  const C_ACTOR = Math.max('ACTOR'.length, ...entries.map((e) => e.actor.length));
  const C_AGE = Math.max('AGE'.length, ...entries.map((e) => formatAge(e.ageSeconds).length));
  const widths: number[] = hasReason
    ? [
        C_ENV,
        C_WF,
        C_ACTOR,
        C_AGE,
        Math.max('REASON'.length, ...entries.map((e) => (e.reason ?? '').length)),
      ]
    : [C_ENV, C_WF, C_ACTOR, C_AGE];

  const headers = hasReason
    ? ['ENV', 'WORKFLOW', 'ACTOR', 'AGE', 'REASON']
    : ['ENV', 'WORKFLOW', 'ACTOR', 'AGE'];

  const top = '  ┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const sep = '  ├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '  └' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
  const headerRow =
    '  │ ' +
    widths.map((w, i) => padRight(chalk.dim(headers[i]!), w)).join(' │ ') +
    ' │';

  console.log('\n  Active locks\n');
  console.log(top);
  console.log(headerRow);
  console.log(sep);

  for (const entry of entries) {
    const wfDisplay = entry.stale
      ? `${entry.logicalName} ${chalk.yellow('⚠')}`
      : entry.logicalName;
    const cells = [
      padRight(entry.env, widths[0]!),
      padRight(wfDisplay, widths[1]!),
      padRight(entry.actor, widths[2]!),
      padRight(formatAge(entry.ageSeconds), widths[3]!),
      ...(hasReason ? [padRight(entry.reason ?? '', widths[4]!)] : []),
    ];
    console.log('  │ ' + cells.join(' │ ') + ' │');
  }

  console.log(bot);
  console.log();
}

export async function runLockList(
  options: { env?: string; stale?: string; json?: boolean; watch?: boolean },
): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  if (options.env) {
    try {
      const { config } = loadConfigAndDir();
      if (!(options.env in config.environments)) {
        const available = Object.keys(config.environments).join(', ');
        throw new UserError(`Unknown environment "${options.env}". Available: ${available}`);
      }
    } catch (err) {
      if (err instanceof UserError) throw err;
    }
  }

  if (options.stale) {
    parseDuration(options.stale); // validate early; throws on bad format
  }

  const render = () => {
    const entries = buildLockList(chiralDir, options);
    if (options.json) {
      printJson({ locks: entries });
    } else {
      renderLockTable(entries);
    }
  };

  if (!options.watch) {
    render();
    return;
  }

  const locksDir = join(chiralDir, 'locks');
  const isTTY = process.stdout.isTTY;

  if (isTTY) process.stdout.write('\x1b[2J\x1b[H');
  render();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const onEvent = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (isTTY) {
        process.stdout.write('\x1b[2J\x1b[H');
        render();
      } else {
        const entries = buildLockList(chiralDir, options);
        console.log(JSON.stringify({ status: 'ok', data: { locks: entries } }));
      }
    }, 150);
  };

  try {
    const watcher = watch(locksDir, { recursive: true }, onEvent);
    process.on('SIGINT', () => {
      watcher.close();
      console.log('  Stopped watching.');
      process.exit(0);
    });
    await new Promise<void>(() => {}); // keep alive
  } catch {
    // locks dir doesn't exist; single render already done above
  }
}

// ── runUnlock ─────────────────────────────────────────────────────────────────

export async function runUnlock(
  logicalName: string,
  options: {
    env?: string;
    allEnvs?: boolean;
    force?: boolean;
    yes?: boolean;
    json?: boolean;
  },
): Promise<void> {
  if (options.env && options.allEnvs) {
    throw new UserError('--env and --all-envs are mutually exclusive');
  }
  if (!options.env && !options.allEnvs) {
    throw new UserError('Specify --env <env> or --all-envs');
  }

  const actor = getGitActor();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const { config } = loadConfigAndDir();
  const envs = Object.keys(config.environments);

  let targetEnvs: string[];
  if (options.allEnvs) {
    targetEnvs = envs;
  } else {
    const envName = options.env!;
    if (!(envName in config.environments)) {
      throw new UserError(
        `Unknown environment "${envName}". Available: ${envs.join(', ')}`,
      );
    }
    targetEnvs = [envName];
  }

  const { workflowId } = resolveWorkflowId(chiralDir, logicalName);
  const releasedEnvs: string[] = [];
  const skippedEnvs: Array<{ env: string; reason: string }> = [];

  for (const env of targetEnvs) {
    const envId = resolveEnvId(chiralDir, env);
    const lock = readLock(chiralDir, envId, workflowId);

    if (!lock) {
      if (options.allEnvs) continue; // silently skip
      throw new UserError(`Workflow "${logicalName}" is not locked in ${env}`);
    }

    if (lock.actor !== actor) {
      if (!options.force) {
        if (options.allEnvs) {
          skippedEnvs.push({ env, reason: `held by ${lock.actor}` });
          continue;
        }
        throw new UserError(
          `You do not own this lock. Held by ${lock.actor}. Use --force to override.`,
        );
      }
      // Free tier: --force on another actor's lock is a paid feature
      throw new UserError(
        "Force-unlocking another actor's lock requires a paid license.",
      );
    }

    releaseLock(chiralDir, envId, workflowId);
    releasedEnvs.push(env);

    if (!options.json) {
      console.log(`  ${chalk.green('✓')} Unlocked ${logicalName} in ${env}`);
    }
  }

  if (!options.json) {
    for (const { env, reason } of skippedEnvs) {
      console.log(
        `  ${chalk.dim('─')} ${logicalName} in ${env}  (${reason} — skipped)`,
      );
    }
  }

  if (releasedEnvs.length === 0) {
    if (options.json) printJson({ unlocked: [], skipped: skippedEnvs.map((s) => s.env) });
    return;
  }

  writeAuditEntry(chiralDir, {
    event_id: crypto.randomUUID(),
    event_schema_version: 1,
    timestamp: new Date().toISOString(),
    actor,
    action: 'unlock',
    project: config.project,
    source_env: null,
    target_env: releasedEnvs.join(','),
    workflow_ids: [workflowId],
    result: 'success',
    error: null,
    chiral_version: '0.1.0',
  });

  if (options.json) {
    printJson({ unlocked: releasedEnvs, skipped: skippedEnvs.map((s) => s.env) });
  }

  const syncResult = await syncToRemote(
    chiralDir,
    config,
    `chore(chiral): unlock ${logicalName}`,
  );
  if (!options.json && !syncResult.skipped && !syncResult.nothingToCommit) {
    if (syncResult.success) {
      console.log(formatSyncSuccess(syncResult));
    } else {
      for (const line of formatSyncFailure(syncResult)) console.log(chalk.yellow(line));
    }
    console.log();
  }
}

// ── Commander wiring ──────────────────────────────────────────────────────────

const lockListCmd = new Command('list')
  .description('Show all active workflow locks')
  .option('--env <env>', 'Show locks for one environment only')
  .option('--stale <duration>', 'Filter to locks older than this duration (e.g. 2h, 30m, 1d)')
  .option('--json', 'Emit standard JSON envelope')
  .option('--watch', 'Re-render on filesystem changes; streams JSON lines when stdout is not a TTY')
  .addHelpText(
    'after',
    `
Examples:
  List all active locks:
    chiral lock list

  Show only stale locks older than 2 hours:
    chiral lock list --stale 2h

  Filter to a specific environment:
    chiral lock list --env prod

  Watch for changes in real time:
    chiral lock list --watch
`,
  )
  .action(async (options) => {
    await runLockList(options);
  });

export const lockCommand = new Command('lock')
  .description('Claim a workflow lock to signal active editing')
  .argument('[workflow]', 'Logical workflow name (from workflows.json)')
  .enablePositionalOptions()
  .option('--env <env>', 'Environment to lock the workflow in')
  .option('--all-envs', 'Lock the workflow in every configured environment atomically')
  .option('--reason <text>', 'Human-readable reason stored in the lock file')
  .option('--json', 'Emit standard JSON envelope')
  .addHelpText(
    'after',
    `
Examples:
  Lock a workflow in one environment:
    chiral lock order-processor --env prod

  Lock across all environments:
    chiral lock order-processor --all-envs --reason "deploying billing fix"

  List all active locks:
    chiral lock list
`,
  )
  .action(async (workflow: string | undefined, options) => {
    if (!workflow) {
      lockCommand.outputHelp();
      return;
    }
    await runLockClaim(workflow, options);
  });

lockCommand.addCommand(lockListCmd);

export const unlockCommand = new Command('unlock')
  .description('Release a workflow lock')
  .argument('<workflow>', 'Logical workflow name')
  .option('--env <env>', 'Environment to unlock')
  .option('--all-envs', 'Unlock in every env where the current actor holds the lock')
  .option('--force', 'Free tier: override own lock. Paid: override any lock (requires --reason).')
  .option('--yes', 'Skip confirmation prompt on --force')
  .option('--json', 'Emit standard JSON envelope')
  .addHelpText(
    'after',
    `
Examples:
  Unlock a workflow in one environment:
    chiral unlock order-processor --env prod

  Unlock across all owned environments:
    chiral unlock order-processor --all-envs
`,
  )
  .action(async (workflow: string, options) => {
    await runUnlock(workflow, options);
  });
