import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { Command } from 'commander';
import { loadConfigAndDir, resolveEnv } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure} from '../lib/git-sync.js';
import { N8nClient } from '../lib/n8n-client.js';
import { getGitActor } from '../lib/git.js';
import { failSpinner, plural, detectsEnvMarker, getChiralVersion } from '../lib/cli.js';
import { generateDeploymentId, writeSnapshot, writeSnapshotMeta, computeSnapshotContentHash } from '../state/snapshots.js';
import { writeAuditEntry } from '../state/audit.js';
import { computeContentHash, computeStructureHash, loadFingerprints, writeFingerprints } from '../state/fingerprints.js';
import { loadWorkflowMap, findLogicalByEnvAndName } from '../state/workflows.js';
import { extractUrlsFromSnapshots, validateUrlValue } from '../state/url-map.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdoptOptions {
  env: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

// No invalid combinations currently exist for adopt.
function validateOptions(_options: AdoptOptions): void { }

// ── Run function ──────────────────────────────────────────────────────────────

export async function runAdopt(
  options: AdoptOptions,
): Promise<void> {
  validateOptions(options);

  const actor = getGitActor();
  const { config, chiralDir } = loadConfigAndDir();
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
    workflow_ids: [] as string[],
    chiral_version: getChiralVersion(),
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
        ` - ${summaries.length} workflows, ${credentials.length} credentials, ${tags.length} tags`,
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

    // ── snapshot + fingerprints ───────────────────────────────────────────────
    const spinner3 = ora({ text: '  Writing snapshot…', color: 'cyan' }).start();
    const deploymentId = generateDeploymentId();
    const snapshotTimestamp = new Date().toISOString();
    for (const workflow of workflows) {
      writeSnapshot(chiralDir, deploymentId, workflow);
    }
    writeSnapshotMeta(chiralDir, deploymentId, {
      deployment_id: deploymentId,
      env: options.env,
      command: 'adopt',
      timestamp: snapshotTimestamp,
      workflow_count: workflows.length,
      content_hash: computeSnapshotContentHash(workflows),
      filters: { tag: null, pattern: null, onlyActive: false, id: null },
    });

    const fingerprints = loadFingerprints(chiralDir);
    if (!fingerprints.envs[options.env]) fingerprints.envs[options.env] = {};
    for (const workflow of workflows) {
      fingerprints.envs[options.env][workflow.id] = {
        name: workflow.name,
        versionId: workflow.versionId,
        contentHash: computeContentHash(workflow),
        structureHash: computeStructureHash(workflow),
        updatedAt: snapshotTimestamp,
      };
    }
    writeFingerprints(chiralDir, fingerprints);

    spinner3.succeed(
      chalk.green('  Snapshot saved') +
      chalk.dim(` → .chiral/snapshots/${deploymentId}/`),
    );
    console.log(
      `${chalk.green('✔   Fingerprints saved')}` +
      chalk.dim(` → .chiral/fingerprints.json  (${plural(workflows.length, 'workflow')})`),
    );

    // ── env-specific name detection ───────────────────────────────────────────
    const wfMap = loadWorkflowMap(chiralDir);
    const envSpecific = workflows.filter(
      (wf) => detectsEnvMarker(wf.name, Object.keys(config.environments)) && !findLogicalByEnvAndName(wfMap, options.env, wf.name),
    );
    if (envSpecific.length > 0) {
      const example = envSpecific[0].name;
      const otherEnvs = Object.keys(config.environments).filter((e) => e !== options.env);
      const targetHint = otherEnvs[0] ?? '<other-env>';
      console.log(
        `\n  ${chalk.yellow('⚠')}  Some workflow names look environment-specific (e.g., "${example}").`,
      );
      console.log(
        chalk.dim(`     If they exist under different names in other environments, run:`),
      );
      console.log(
        chalk.dim(`     chiral workflow match --source ${options.env} --target ${targetHint}`),
      );
    }

    // ── workflow list ─────────────────────────────────────────────────────────
    console.log(`\n  ${chalk.bold('Workflows')}`);
    for (const wf of workflows) {
      const badge = wf.active ? chalk.green('active') : chalk.dim('inactive');
      console.log(`  ${chalk.dim('–')} ${wf.name}  ${badge}`);
    }

    // ── URL discovery hint ────────────────────────────────────────────────────
    const discoveredUrls = extractUrlsFromSnapshots(chiralDir, [options.env]);
    const safeUrls = discoveredUrls.filter((d) => {
      try { validateUrlValue(d.value); return true; } catch { return false; }
    });
    const uniqueHostnames = new Set(safeUrls.map((d) => d.hostname));
    if (uniqueHostnames.size > 0) {
      const uniqueWorkflowNames = new Set(safeUrls.flatMap((d) => d.workflowNames));
      const domainLabel = uniqueHostnames.size === 1 ? 'domain' : 'domains';
      const wfLabel = uniqueWorkflowNames.size === 1 ? 'workflow' : 'workflows';
      const msg = `Found ${uniqueHostnames.size} unique ${domainLabel} across ${uniqueWorkflowNames.size} ${wfLabel}`;
      if (process.stdout.isTTY) {
        console.log(`\n  ${msg}.`);
        const shouldRegister = await confirm({ message: '  Register them as URL mappings?' });
        if (shouldRegister) {
          console.log(chalk.dim(`     Run: chiral url map`));
        }
      } else {
        console.log(`\n  ${chalk.dim(`${msg} — run chiral url map to register them.`)}`);
      }
    }

    const otherEnvs = Object.keys(config.environments).filter((e) => e !== options.env);
    if (otherEnvs.length > 0) {
      console.log(`\n  ${chalk.dim('Next:')} chiral diff --source ${options.env} --target ${otherEnvs[0]}\n`);
    } else {
      console.log(`\n  ${chalk.dim('Next:')} chiral environment add  ${chalk.dim('# connect another environment to enable push/diff')}\n`);
    }

    // Fix B1: record actual workflow IDs in the audit entry
    baseEntry.workflow_ids = workflows.map((w) => w.id);
    writeAuditEntry(chiralDir, { ...baseEntry, result: 'success', error: null });

    const syncResult = await syncToRemote(
      chiralDir, config, `chore(chiral): adopt ${options.env}`,
    );
    if (!syncResult.skipped && !syncResult.nothingToCommit) {
      if (syncResult.success) {
        console.log(formatSyncSuccess(syncResult));
      } else {
        for (const line of formatSyncFailure(syncResult)) console.log(chalk.yellow(line));
      }
      console.log();
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      writeAuditEntry(chiralDir, { ...baseEntry, result: 'failure', error: errorMsg });
    } catch {
      // best-effort - don't mask the original error
    }
    throw err;
  }
}

// ── Command definition ────────────────────────────────────────────────────────

export const adoptCommand = new Command('adopt')
  .description('Import an existing n8n instance into chiral state')
  .requiredOption('--env <env>', 'Environment name from config.json')
  .addHelpText(
    'after',
    `
Examples:
  Adopt a configured environment:
    chiral adopt --env dev
`,
  )
  .action(async (options: AdoptOptions) => {
    await runAdopt(options);
  });
