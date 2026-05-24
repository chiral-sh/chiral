import { execSync } from 'node:child_process';
import chalk from 'chalk';
import ora from 'ora';
import { Command } from 'commander';
import { loadConfigAndDir, resolveEnv } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure, logSyncError } from '../lib/git-sync.js';
import { N8nClient, type WorkflowFull } from '../lib/n8n-client.js';
import { UserError, ControlledExit } from '../lib/errors.js';
import {
  generateDeploymentId,
  writeSnapshot,
  writeSnapshotMeta,
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  type SnapshotWorkflow,
} from '../state/snapshots.js';
import { writeAuditEntry, readAuditLog } from '../state/audit.js';
import {
  computeContentHash,
  computeStructureHash,
  loadFingerprints,
  writeFingerprints,
  upsertFingerprintEntry,
} from '../state/fingerprints.js';
import type { Config } from '../lib/config.js';
import { loadWorkflowMap, writeWorkflowMap, findEntryByEnvId, upsertEnvEntry } from '../state/workflows.js';

function getGitActor(): string {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    throw new UserError(
      'git config user.email is not set — configure it before running chiral',
    );
  }
}

function failSpinner(spinner: ReturnType<typeof ora>, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  spinner.fail(chalk.red(`  ${msg}`));
  throw err;
}

function matchesGlob(name: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(name);
}

interface Delta {
  added: WorkflowFull[];
  updated: WorkflowFull[];
  deleted: SnapshotWorkflow[];
  unchanged: number;
}

function computeDelta(current: WorkflowFull[], previous: SnapshotWorkflow[]): Delta {
  const prevById = new Map(previous.map((w) => [w.id, w]));
  const currIds = new Set(current.map((w) => w.id));

  const added: WorkflowFull[] = [];
  const updated: WorkflowFull[] = [];
  let unchanged = 0;

  for (const wf of current) {
    const prev = prevById.get(wf.id);
    if (!prev) {
      added.push(wf);
    } else if ((prev as Record<string, unknown>).versionId !== wf.versionId) {
      updated.push(wf);
    } else {
      unchanged++;
    }
  }

  const deleted = previous.filter((p) => !currIds.has(p.id));
  return { added, updated, deleted, unchanged };
}

function buildNextHint(
  config: Config,
  env: string,
  hasChanges: boolean,
  isFirstPull: boolean,
  filters: { tag?: string; pattern?: string },
): string {
  const others = Object.keys(config.environments).filter((e) => e !== env);
  if (others.length === 0) return '';
  const target = others[0];

  if (hasChanges && !isFirstPull) {
    const parts = [
      `--source ${env}`,
      `--target ${target}`,
      filters.tag ? `--tag ${filters.tag}` : '',
      filters.pattern ? `--pattern "${filters.pattern}"` : '',
      '--dry-run',
    ].filter(Boolean);
    return `chiral push ${parts.join(' ')}`;
  }
  return `chiral diff --source ${env} --target ${target}`;
}

function checkStaleness(chiralDir: string, env: string): void {
  const entries = readAuditLog(chiralDir);
  const lastPull = [...entries]
    .reverse()
    .find((e) => e.action === 'pull' && e.target_env === env && e.result === 'success');

  if (!lastPull) return;

  const daysAgo = (Date.now() - new Date(lastPull.timestamp).getTime()) / (1000 * 60 * 60 * 24);
  if (daysAgo > 7) {
    const days = Math.floor(daysAgo);
    console.log(chalk.dim(`  Note: last pull from ${env} was ${days} day${days === 1 ? '' : 's'} ago.`));
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function printWorkflowList(workflows: WorkflowFull[]): void {
  console.log(`\n  ${chalk.bold('Workflows pulled:')}`);
  for (const wf of workflows) {
    const badge = wf.active ? chalk.green('active') : chalk.dim('inactive');
    console.log(`  ${chalk.dim('–')} ${wf.name}  ${badge}`);
  }
}

interface PullOptions {
  env: string;
  tag?: string;
  pattern?: string;
  id?: string;
  onlyActive?: boolean;
  json?: boolean;
  verbose?: boolean;
  nameOnly?: boolean;
  exitCode?: boolean;
}

export async function runPull(
  options: PullOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  if (options.id && (options.tag || options.pattern || options.onlyActive)) {
    throw new UserError('--id cannot be combined with --tag, --pattern, or --only-active');
  }

  const actor = getGitActor();
  const { config, chiralDir } = loadConfigAndDir(cwd);
  const env = resolveEnv(config, options.env);
  const client = new N8nClient(env, options.env);
  client.warnIfExpiringSoon();

  const baseEntry = {
    event_id: crypto.randomUUID(),
    event_schema_version: 1 as const,
    timestamp: new Date().toISOString(),
    actor,
    action: 'pull' as const,
    project: config.project,
    source_env: null,
    target_env: options.env,
    workflow_ids: [] as string[],
    chiral_version: '0.1.0',
  };

  const isSilent = options.json || options.nameOnly;
  if (!isSilent) {
    console.log();
    checkStaleness(chiralDir, options.env);
  }

  try {
    // ── --id: single-workflow path ────────────────────────────────────────────
    if (options.id) {
      const spinner = ora({
        text: `  Connecting to ${chalk.cyan(options.env)}…`,
        color: 'cyan',
      }).start();

      const workflow = await client.getWorkflow(options.id).catch((err) => failSpinner(spinner, err));
      spinner.succeed(chalk.green(`  Fetched "${workflow.name}"`));

      const previousDeploymentId = findLatestDeploymentForEnv(chiralDir, options.env);
      const previousWorkflows = previousDeploymentId
        ? readAllWorkflowsInDeployment(chiralDir, previousDeploymentId)
        : null;
      const prevEntry = previousWorkflows?.find((w) => w.id === options.id);
      const isNew = !prevEntry;
      const isUpdated = !!prevEntry && (prevEntry as Record<string, unknown>).versionId !== workflow.versionId;
      const hasChanges = isNew || isUpdated;

      const deploymentId = generateDeploymentId();
      const snapshotTimestamp = new Date().toISOString();
      writeSnapshot(chiralDir, deploymentId, workflow);
      writeSnapshotMeta(chiralDir, deploymentId, {
        deployment_id: deploymentId,
        env: options.env,
        command: 'pull',
        timestamp: snapshotTimestamp,
        workflow_count: 1,
        filters: { tag: null, pattern: null, onlyActive: false, id: options.id },
      });
      upsertFingerprintEntry(chiralDir, options.env, workflow.id, {
        name: workflow.name,
        versionId: workflow.versionId,
        contentHash: computeContentHash(workflow),
        structureHash: computeStructureHash(workflow),
        updatedAt: snapshotTimestamp,
      });

      // Auto-heal: update map entry name if the workflow was renamed in n8n
      {
        const wfMap = loadWorkflowMap(chiralDir);
        const found = findEntryByEnvId(wfMap, options.env, workflow.id);
        if (found && found.entry.name !== workflow.name) {
          upsertEnvEntry(wfMap, found.logicalName, options.env, { name: workflow.name, id: workflow.id });
          writeWorkflowMap(chiralDir, wfMap);
        }
      }

      if (options.nameOnly) {
        if (hasChanges) console.log(workflow.name);
      } else if (options.json) {
        console.log(
          JSON.stringify({
            env: options.env,
            deployment_id: deploymentId,
            pulled: 1,
            active: workflow.active ? 1 : 0,
            inactive: workflow.active ? 0 : 1,
            new: isNew ? [workflow.name] : [],
            updated: isUpdated ? [workflow.name] : [],
            deleted: [],
            unchanged: hasChanges ? 0 : 1,
          }),
        );
      } else {
        console.log();
        if (isNew) {
          console.log(`  ${chalk.green('+')} ${workflow.name}  ${chalk.dim('(new)')}`);
        } else if (isUpdated) {
          console.log(`  ${chalk.yellow('~')} ${workflow.name}  ${chalk.dim('(updated)')}`);
        } else {
          console.log(`  ${chalk.green('✓')} ${workflow.name} up to date`);
        }
        console.log(chalk.dim(`\n  Snapshot saved → .chiral/snapshots/${deploymentId}/`));
        console.log();
      }

      baseEntry.workflow_ids = [options.id];
      writeAuditEntry(chiralDir, { ...baseEntry, result: 'success', error: null });

      if (!isSilent) {
        const syncResult = await syncToRemote(
          chiralDir, config, `chore(chiral): pull ${options.env}`,
        );
        if (!syncResult.skipped && !syncResult.nothingToCommit) {
          if (syncResult.success) {
            console.log(formatSyncSuccess(syncResult));
          } else {
            for (const line of formatSyncFailure(syncResult)) console.log(chalk.yellow(line));
          }
          console.log();
        }
      }

      if (options.exitCode && hasChanges) throw new ControlledExit(1);
      return;
    }

    // ── normal path ───────────────────────────────────────────────────────────
    const filterLabel = [
      options.tag ? `tag: ${options.tag}` : '',
      options.pattern ? `pattern: ${options.pattern}` : '',
      options.onlyActive ? 'active only' : '',
    ]
      .filter(Boolean)
      .join(', ');

    const connectText = filterLabel
      ? `  Connecting to ${chalk.cyan(options.env)} [${filterLabel}]…`
      : `  Connecting to ${chalk.cyan(options.env)}…`;
    const spinner1 = ora({ text: connectText, color: 'cyan' }).start();

    // Server-side filtering for active and tags; pattern stays client-side
    const summaries = await client
      .listWorkflows({
        active: options.onlyActive ? true : undefined,
        tags: options.tag,
      })
      .catch((err) => failSpinner(spinner1, err));

    // Client-side filters as belt-and-suspenders (and for pattern which has no server-side support)
    const filtered = summaries.filter((wf) => {
      if (options.tag && !wf.tags.some((t) => t.name === options.tag)) return false;
      if (options.pattern && !matchesGlob(wf.name, options.pattern)) return false;
      if (options.onlyActive && !wf.active) return false;
      return true;
    });

    const workflows = await Promise.all(
      filtered.map((s) => client.getWorkflow(s.id)),
    ).catch((err) => failSpinner(spinner1, err));

    const activeCount = filtered.filter((w) => w.active).length;
    const inactiveCount = filtered.length - activeCount;
    const activeLabel = `${activeCount} active, ${inactiveCount} inactive`;
    const filteredNote =
      filtered.length < summaries.length
        ? chalk.dim(` (filtered from ${summaries.length} total)`)
        : '';
    spinner1.succeed(
      chalk.green(`  Fetched ${plural(workflows.length, 'workflow')} — ${activeLabel}`) + filteredNote,
    );

    // ── delta ─────────────────────────────────────────────────────────────────
    const previousDeploymentId = findLatestDeploymentForEnv(chiralDir, options.env);
    const previousWorkflows = previousDeploymentId
      ? readAllWorkflowsInDeployment(chiralDir, previousDeploymentId)
      : null;

    const delta = previousWorkflows ? computeDelta(workflows, previousWorkflows) : null;
    const isFirstPull = delta === null;
    const totalChanges = delta
      ? delta.added.length + delta.updated.length + delta.deleted.length
      : 0;
    const hasChanges = !isFirstPull && totalChanges > 0;

    // ── write snapshot ────────────────────────────────────────────────────────
    const deploymentId = generateDeploymentId();
    const snapshotTimestamp = new Date().toISOString();
    const meta = {
      deployment_id: deploymentId,
      env: options.env,
      command: 'pull' as const,
      timestamp: snapshotTimestamp,
      workflow_count: workflows.length,
      filters: {
        tag: options.tag ?? null,
        pattern: options.pattern ?? null,
        onlyActive: options.onlyActive ?? false,
        id: null,
      },
    };

    if (!isFirstPull && totalChanges === 0) {
      // nothing changed — write snapshot silently
      for (const wf of workflows) writeSnapshot(chiralDir, deploymentId, wf);
      writeSnapshotMeta(chiralDir, deploymentId, meta);

      if (options.nameOnly) {
        // nothing changed — no output
      } else if (options.json) {
        console.log(
          JSON.stringify({
            env: options.env,
            deployment_id: deploymentId,
            pulled: workflows.length,
            active: activeCount,
            inactive: inactiveCount,
            new: [],
            updated: [],
            deleted: [],
            unchanged: workflows.length,
          }),
        );
      } else {
        if (workflows.length === 0) {
          console.log(
            `\n  ${chalk.yellow('⚠')} No workflows found in ${chalk.cyan(options.env)} — is this expected?`,
          );
          console.log(
            chalk.dim(`\n  Check that your API key has permission to list workflows in this environment.`),
          );
        } else {
          console.log(
            `\n  ${chalk.green('✓')} All ${plural(workflows.length, 'workflow')} up to date — no changes since last pull`,
          );
          if (options.verbose) printWorkflowList(workflows);
          const hint = buildNextHint(config, options.env, false, false, {});
          if (hint) console.log(`\n  ${chalk.dim('Next:')} ${hint}`);
        }
        console.log();
      }
    } else {
      // first pull or changes found — show snapshot spinner
      const spinner3 = ora({ text: '  Writing snapshot…', color: 'cyan' }).start();
      for (const wf of workflows) writeSnapshot(chiralDir, deploymentId, wf);
      writeSnapshotMeta(chiralDir, deploymentId, meta);
      spinner3.succeed(
        chalk.green('  Snapshot saved') +
        chalk.dim(` → .chiral/snapshots/${deploymentId}/`),
      );

      if (options.nameOnly) {
        // print only names of changed workflows — no other output
        for (const wf of (delta?.added ?? [])) console.log(wf.name);
        for (const wf of (delta?.updated ?? [])) console.log(wf.name);
        for (const wf of (delta?.deleted ?? [])) console.log(wf.name);
      } else if (options.json) {
        console.log(
          JSON.stringify({
            env: options.env,
            deployment_id: deploymentId,
            pulled: workflows.length,
            active: activeCount,
            inactive: inactiveCount,
            new: (delta?.added ?? workflows).map((w) => w.name),
            updated: delta?.updated.map((w) => w.name) ?? [],
            deleted: delta?.deleted.map((w) => w.name) ?? [],
            unchanged: delta?.unchanged ?? 0,
          }),
        );
      } else {
        if (isFirstPull && workflows.length === 0) {
          console.log(
            `\n  ${chalk.yellow('⚠')} No workflows found in ${chalk.cyan(options.env)} — is this expected?`,
          );
          console.log(
            chalk.dim(`\n  Check that your API key has permission to list workflows in this environment.`),
          );
        } else if (isFirstPull) {
          console.log(
            `\n  ${chalk.dim('First pull — baseline saved. Run again after making changes in n8n to see a delta.')}`,
          );
        } else {
          console.log();
          for (const wf of delta!.added) {
            console.log(`  ${chalk.green('+')} ${wf.name}  ${chalk.dim('(new)')}`);
          }
          for (const wf of delta!.updated) {
            console.log(`  ${chalk.yellow('~')} ${wf.name}  ${chalk.dim('(updated)')}`);
          }
          for (const wf of delta!.deleted) {
            console.log(`  ${chalk.yellow('⚠')} ${wf.name}  ${chalk.dim('(removed from n8n)')}`);
          }
          if (delta!.unchanged > 0) {
            console.log(
              `  ${chalk.dim(`  ${plural(delta!.unchanged, 'workflow')} unchanged`)}`,
            );
          }
          console.log();
          console.log(`  ${plural(totalChanges, 'change')}.`);
        }

        if (options.verbose) printWorkflowList(workflows);
        const hint = buildNextHint(config, options.env, hasChanges, isFirstPull, {
          tag: options.tag,
          pattern: options.pattern,
        });
        if (hint) console.log(`\n  ${chalk.dim('Next:')} ${hint}`);
        console.log();
      }
    }

    // Batch-update fingerprints for every pulled workflow — runs for both the
    // "no changes" and "first pull / changes found" branches.
    if (workflows.length > 0) {
      const fp = loadFingerprints(chiralDir);
      if (!fp.envs[options.env]) fp.envs[options.env] = {};
      for (const wf of workflows) {
        fp.envs[options.env]![wf.id] = {
          name: wf.name,
          versionId: wf.versionId,
          contentHash: computeContentHash(wf),
          structureHash: computeStructureHash(wf),
          updatedAt: snapshotTimestamp,
        };
      }
      writeFingerprints(chiralDir, fp);

      // Auto-heal: update map entry names for any workflows renamed in n8n
      const wfMap = loadWorkflowMap(chiralDir);
      let mapDirty = false;
      for (const wf of workflows) {
        const found = findEntryByEnvId(wfMap, options.env, wf.id);
        if (found && found.entry.name !== wf.name) {
          upsertEnvEntry(wfMap, found.logicalName, options.env, { name: wf.name, id: wf.id });
          mapDirty = true;
        }
      }
      if (mapDirty) writeWorkflowMap(chiralDir, wfMap);
    }

    baseEntry.workflow_ids = workflows.map((w) => w.id);
    writeAuditEntry(chiralDir, { ...baseEntry, result: 'success', error: null });

    if (!isSilent) {
      const syncResult = await syncToRemote(
        chiralDir, config, `chore(chiral): pull ${options.env}`,
      );
      if (!syncResult.skipped && !syncResult.nothingToCommit) {
        if (syncResult.success) {
          console.log(formatSyncSuccess(syncResult));
        } else {
          for (const line of formatSyncFailure(syncResult)) console.log(chalk.yellow(line));
          if (syncResult.message) logSyncError(syncResult.message);
        }
        console.log();
      }
    }

    if (options.exitCode && hasChanges) throw new ControlledExit(1);
  } catch (err) {
    if (err instanceof ControlledExit) throw err;
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      writeAuditEntry(chiralDir, { ...baseEntry, result: 'failure', error: errorMsg });
    } catch {
      // best-effort — don't mask the original error
    }
    throw err;
  }
}

export const pullCommand = new Command('pull')
  .description('Sync workflow snapshots from an n8n environment')
  .requiredOption('--env <env>', 'Environment to pull from')
  .option('--tag <tag>', 'Only pull workflows with this tag name')
  .option('--pattern <glob>', 'Only pull workflows whose name matches this glob (e.g. "Customer *")')
  .option('--id <workflow-id>', 'Pull a single workflow by its n8n ID (mutually exclusive with --tag, --pattern, --only-active)')
  .option('--only-active', 'Only pull currently active workflows')
  .option('--verbose', 'List every pulled workflow with its active/inactive status')
  .option('--name-only', 'Print only changed workflow names, one per line — suitable for piping')
  .option('--json', 'Output a machine-readable JSON summary instead of human output')
  .option('--exit-code', 'Exit 1 if changes were detected, 0 if everything was already up to date (CI use)')
  .addHelpText(
    'after',
    `
Examples:
  Pull all workflows from dev:
    chiral pull --env dev

  Pull only workflows tagged "production":
    chiral pull --env dev --tag production

  Pull workflows matching a name pattern:
    chiral pull --env dev --pattern "Customer *"

  Pull a single workflow by ID:
    chiral pull --env dev --id abc123

  Pull only active workflows (CI-friendly):
    chiral pull --env dev --only-active

  Exit 1 if changes detected (for CI scripts):
    chiral pull --env dev --exit-code

  Print only changed workflow names for piping:
    chiral pull --env dev --name-only

  Show every pulled workflow with its active/inactive status:
    chiral pull --env dev --verbose

  Machine-readable output for scripting:
    chiral pull --env dev --json
`,
  )
  .action(async (options) => {
    await runPull(options);
  });
