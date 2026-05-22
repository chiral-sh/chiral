import { execSync } from 'node:child_process';
import chalk from 'chalk';
import ora from 'ora';
import { Command } from 'commander';
import { loadConfigAndDir, resolveEnv } from '../lib/config.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError } from '../lib/errors.js';
import { generateDeploymentId, writeSnapshot, writeSnapshotMeta } from '../state/snapshots.js';
import { writeAuditEntry } from '../state/audit.js';

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

export async function runAdopt(
  options: { env: string },
  cwd: string = process.cwd(),
): Promise<void> {
  const actor = getGitActor();
  const { config, flightdeckDir } = loadConfigAndDir(cwd);
  const env = resolveEnv(config, options.env);
  const client = new N8nClient(env, options.env);
  client.warnIfExpiringSoon();

  const baseEntry = {
    event_id: crypto.randomUUID(),
    event_schema_version: 1 as const,
    timestamp: new Date().toISOString(),
    actor,
    action: 'adopt' as const,
    project: config.project,
    source_env: null,
    target_env: options.env,
    workflow_ids: [],
    flightdeck_version: '0.1.0',
  };

  console.log();

  try {
    // ── discover ──────────────────────────────────────────────────────────────
    const spinner1 = ora({ text: `  Connecting to ${chalk.cyan(options.env)}…`, color: 'cyan' }).start();
    const [summaries, credentials, tags] = await Promise.all([
      client.listWorkflows(),
      client.listCredentials(),
      client.listTags(),
    ]).catch((err) => failSpinner(spinner1, err));
    spinner1.succeed(
      chalk.green('  Connected') +
        chalk.dim(
          ` — ${summaries.length} workflows, ${credentials.length} credentials, ${tags.length} tags`,
        ),
    );

    // ── fetch definitions ─────────────────────────────────────────────────────
    const spinner2 = ora({ text: '  Fetching workflow definitions…', color: 'cyan' }).start();
    const workflows = await Promise.all(summaries.map((s) => client.getWorkflow(s.id))).catch(
      (err) => failSpinner(spinner2, err),
    );
    spinner2.succeed(
      chalk.green(`  Fetched ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`),
    );

    // ── snapshot ──────────────────────────────────────────────────────────────
    const spinner3 = ora({ text: '  Writing snapshot…', color: 'cyan' }).start();
    const deploymentId = generateDeploymentId();
    for (const workflow of workflows) {
      writeSnapshot(flightdeckDir, deploymentId, workflow);
    }
    writeSnapshotMeta(flightdeckDir, deploymentId, {
      deployment_id: deploymentId,
      env: options.env,
      command: 'adopt',
      timestamp: new Date().toISOString(),
      workflow_count: workflows.length,
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });
    spinner3.succeed(
      chalk.green('  Snapshot saved') +
        chalk.dim(` → .flightdeck/snapshots/${deploymentId}/`),
    );

    // ── workflow list ─────────────────────────────────────────────────────────
    console.log(`\n  ${chalk.bold('Workflows')}`);
    for (const wf of workflows) {
      const badge = wf.active ? chalk.green('active') : chalk.dim('inactive');
      console.log(`  ${chalk.dim('–')} ${wf.name}  ${badge}`);
    }

    console.log(`\n  ${chalk.dim('Next:')} flightdeck pull --env ${options.env}\n`);

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

export const adoptCommand = new Command('adopt')
  .description('Import an existing n8n instance into flightdeck state')
  .requiredOption('--env <env>', 'Environment name from config.json')
  .addHelpText(
    'after',
    `
Examples:
  Adopt a configured environment:
    flightdeck adopt --env dev
`,
  )
  .action(async (options) => {
    await runAdopt(options);
  });
