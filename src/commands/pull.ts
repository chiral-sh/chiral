import { execSync } from 'node:child_process';
import chalk from 'chalk';
import ora from 'ora';
import { Command } from 'commander';
import { loadConfigAndDir, resolveEnv } from '../lib/config.js';
import { N8nClient, type WorkflowFull } from '../lib/n8n-client.js';
import { UserError } from '../lib/errors.js';
import {
  generateDeploymentId,
  writeSnapshot,
  writeSnapshotMeta,
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  type SnapshotWorkflow,
} from '../state/snapshots.js';
import { writeAuditEntry } from '../state/audit.js';
import type { Config } from '../lib/config.js';

function getGitActor(): string {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    throw new UserError(
      'git config user.email is not set — configure it before running flightdeck',
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

function buildNextHint(config: Config, env: string): string {
  const others = Object.keys(config.environments).filter((e) => e !== env);
  if (others.length === 0) return '';
  return `flightdeck diff --source ${env} --target ${others[0]}`;
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

export async function runPull(
  options: {
    env: string;
    tag?: string;
    pattern?: string;
    onlyActive?: boolean;
    json?: boolean;
    verbose?: boolean;
  },
  cwd: string = process.cwd(),
): Promise<void> {
  const actor = getGitActor();
  const { config, flightdeckDir } = loadConfigAndDir(cwd);
  const env = resolveEnv(config, options.env);
  const client = new N8nClient(env, options.env);
  client.warnIfExpiringSoon();

  const filterLabel = [
    options.tag ? `tag: ${options.tag}` : '',
    options.pattern ? `pattern: ${options.pattern}` : '',
    options.onlyActive ? 'active only' : '',
  ]
    .filter(Boolean)
    .join(', ');

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
    flightdeck_version: '0.1.0',
  };

  if (!options.json) console.log();

  try {
    // ── fetch ─────────────────────────────────────────────────────────────────
    const connectText = filterLabel
      ? `  Connecting to ${chalk.cyan(options.env)} [${filterLabel}]…`
      : `  Connecting to ${chalk.cyan(options.env)}…`;
    const spinner1 = ora({ text: connectText, color: 'cyan' }).start();

    const summaries = await client.listWorkflows().catch((err) => failSpinner(spinner1, err));

    // apply filters client-side
    const filtered = summaries.filter((wf) => {
      if (options.tag && !wf.tags.some((t) => t.name === options.tag)) return false;
      if (options.pattern && !matchesGlob(wf.name, options.pattern)) return false;
      if (options.onlyActive && !wf.active) return false;
      return true;
    });

    // fetch full workflow data — spinner stays open through both API calls
    const workflows = await Promise.all(
      filtered.map((s) => client.getWorkflow(s.id)),
    ).catch((err) => failSpinner(spinner1, err));

    const filteredNote =
      filtered.length < summaries.length
        ? chalk.dim(` (${filtered.length} of ${summaries.length} total)`)
        : '';
    spinner1.succeed(
      chalk.green(`  Fetched ${plural(workflows.length, 'workflow')}`) + filteredNote,
    );

    // ── find previous snapshot for delta ──────────────────────────────────────
    const previousDeploymentId = findLatestDeploymentForEnv(flightdeckDir, options.env);
    const previousWorkflows = previousDeploymentId
      ? readAllWorkflowsInDeployment(flightdeckDir, previousDeploymentId)
      : null;

    const delta = previousWorkflows ? computeDelta(workflows, previousWorkflows) : null;
    const totalChanges = delta
      ? delta.added.length + delta.updated.length + delta.deleted.length
      : workflows.length;

    // ── write snapshot ────────────────────────────────────────────────────────
    const deploymentId = generateDeploymentId();

    if (delta && totalChanges === 0) {
      // nothing changed — write snapshot silently, report inline
      for (const wf of workflows) writeSnapshot(flightdeckDir, deploymentId, wf);
      writeSnapshotMeta(flightdeckDir, deploymentId, {
        deployment_id: deploymentId,
        env: options.env,
        command: 'pull',
        timestamp: new Date().toISOString(),
        workflow_count: workflows.length,
        filters: {
          tag: options.tag ?? null,
          pattern: options.pattern ?? null,
          onlyActive: options.onlyActive ?? false,
        },
      });

      if (options.json) {
        console.log(
          JSON.stringify({
            env: options.env,
            deployment_id: deploymentId,
            pulled: workflows.length,
            new: [],
            updated: [],
            deleted: [],
            unchanged: workflows.length,
          }),
        );
      } else {
        console.log(
          `\n  ${chalk.green('✓')} All ${plural(workflows.length, 'workflow')} up to date — no changes since last pull`,
        );
        if (options.verbose) printWorkflowList(workflows);
        const hint = buildNextHint(config, options.env);
        if (hint) console.log(`\n  ${chalk.dim('Next:')} ${hint}`);
        console.log();
      }
    } else {
      // first pull or changes found
      const spinner3 = ora({ text: '  Writing snapshot…', color: 'cyan' }).start();
      for (const wf of workflows) writeSnapshot(flightdeckDir, deploymentId, wf);
      writeSnapshotMeta(flightdeckDir, deploymentId, {
        deployment_id: deploymentId,
        env: options.env,
        command: 'pull',
        timestamp: new Date().toISOString(),
        workflow_count: workflows.length,
        filters: {
          tag: options.tag ?? null,
          pattern: options.pattern ?? null,
          onlyActive: options.onlyActive ?? false,
        },
      });
      spinner3.succeed(
        chalk.green('  Snapshot saved') +
          chalk.dim(` → .flightdeck/snapshots/${deploymentId}/`),
      );

      if (options.json) {
        console.log(
          JSON.stringify({
            env: options.env,
            deployment_id: deploymentId,
            pulled: workflows.length,
            new: (delta?.added ?? workflows).map((w) => w.name),
            updated: delta?.updated.map((w) => w.name) ?? [],
            deleted: delta?.deleted.map((w) => w.name) ?? [],
            unchanged: delta?.unchanged ?? 0,
          }),
        );
      } else {
        if (!delta) {
          // first pull — no delta to display
          console.log(
            `\n  ${chalk.dim('First pull — baseline saved. Run again after making changes in n8n to see a delta.')}`,
          );
        } else {
          // changes found
          console.log();
          for (const wf of delta.added) {
            console.log(`  ${chalk.green('+')} ${wf.name}  ${chalk.dim('(new)')}`);
          }
          for (const wf of delta.updated) {
            console.log(`  ${chalk.yellow('~')} ${wf.name}  ${chalk.dim('(updated)')}`);
          }
          for (const wf of delta.deleted) {
            console.log(`  ${chalk.yellow('⚠')} ${wf.name}  ${chalk.dim('(removed from n8n)')}`);
          }
          if (delta.unchanged > 0) {
            console.log(
              `  ${chalk.dim(`  ${plural(delta.unchanged, 'workflow')} unchanged`)}`,
            );
          }
          console.log();
          console.log(
            `  ${plural(totalChanges, 'change')}. Run ${chalk.dim(`'flightdeck push --source ${options.env} --target <target>'`)} to deploy.`,
          );
        }

        if (options.verbose) printWorkflowList(workflows);
        const hint = buildNextHint(config, options.env);
        if (hint) console.log(`\n  ${chalk.dim('Next:')} ${hint}`);
        console.log();
      }
    }

    baseEntry.workflow_ids = workflows.map((w) => w.id);
    writeAuditEntry(flightdeckDir, { ...baseEntry, result: 'success', error: null });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      writeAuditEntry(flightdeckDir, { ...baseEntry, result: 'failure', error: errorMsg });
    } catch {
      // best-effort — don't mask the original error
    }
    throw err;
  }
}

export const pullCommand = new Command('pull')
  .description('Sync workflow snapshots from an n8n environment')
  .requiredOption('--env <env>', 'Environment to pull from')
  .option('--tag <tag>', 'Only pull workflows with this tag')
  .option('--pattern <glob>', 'Only pull workflows whose name matches this glob (e.g. "Customer *")')
  .option('--only-active', 'Only pull currently active workflows')
  .option('--verbose', 'List every pulled workflow with its active/inactive status')
  .option('--json', 'Output a machine-readable JSON summary instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  Pull all workflows from dev:
    flightdeck pull --env dev

  Pull only workflows tagged "production":
    flightdeck pull --env dev --tag production

  Pull workflows matching a name pattern:
    flightdeck pull --env dev --pattern "Customer *"

  Pull only active workflows (CI-friendly):
    flightdeck pull --env dev --only-active

  Show every pulled workflow with its active/inactive status:
    flightdeck pull --env dev --verbose

  Machine-readable output for scripting:
    flightdeck pull --env dev --json
`,
  )
  .action(async (options) => {
    await runPull(options);
  });
