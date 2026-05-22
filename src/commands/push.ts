import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { Command } from 'commander';
import { loadConfigAndDir, resolveEnv } from '../lib/config.js';
import { N8nClient, type WorkflowSummary, type CredentialSummary, type TagSummary } from '../lib/n8n-client.js';
import { UserError, ControlledExit } from '../lib/errors.js';
import { loadWorkflowMap, resolveTargetName } from '../state/workflows.js';
import { loadCredentials, buildCredentialMap, type CredentialMapEntry } from '../state/credentials.js';
import {
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  readSnapshotMeta,
  type SnapshotWorkflow,
} from '../state/snapshots.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesGlob(name: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(name);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function failSpinner(spinner: ReturnType<typeof ora>, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  spinner.fail(chalk.red(`  ${msg}`));
  throw err;
}

/** Width used for credential map column alignment */
const CRED_COL_WIDTH = 24;

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PushOptions {
  source: string;
  target: string;
  dryRun?: boolean;
  tag?: string;
  pattern?: string;
  yes?: boolean;
  noActivate?: boolean;
  json?: boolean;
  gated?: boolean;
}

interface WorkflowClassification {
  workflow: SnapshotWorkflow;
  resolvedName: string;
  action: 'would-create' | 'would-update' | 'skipped';
  targetActive: boolean; // whether the target version is currently active
}

interface TagResolution {
  name: string;
  targetId: string | null; // null = not found in target
}

// ── Dry-run implementation ────────────────────────────────────────────────────

export async function runPush(
  options: PushOptions,
  cwd: string = process.cwd(),
): Promise<void> {

  // ── Guard: live push placeholder ──────────────────────────────────────────
  if (!options.dryRun) {
    throw new UserError(
      'Live push is not yet implemented.',
      '  Use --dry-run to preview changes, or watch for the next release.',
    );
  }

  // ── Guard: source ≠ target ────────────────────────────────────────────────
  if (options.source === options.target) {
    throw new UserError(
      `Cannot push an environment to itself — source and target are both "${options.source}"`,
    );
  }

  const { config, flightdeckDir } = loadConfigAndDir(cwd);

  // Validate both env names exist in config (source doesn't need a live client)
  resolveEnv(config, options.source);
  const targetEnvObj = resolveEnv(config, options.target);

  const targetClient = new N8nClient(targetEnvObj, options.target);
  targetClient.warnIfExpiringSoon();

  const isJson = !!(options.json);

  // ── Header ────────────────────────────────────────────────────────────────
  if (!isJson) {
    console.log();
    const scopeLabel = [
      options.tag ? `tag: ${options.tag}` : '',
      options.pattern ? `pattern: ${options.pattern}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const scope = scopeLabel ? `  ${chalk.dim(`[${scopeLabel}]`)}` : '';
    console.log(
      `  Dry run: ${chalk.cyan(options.source)} → ${chalk.cyan(options.target)}${scope}`,
    );
  }

  // ── Snapshot check ────────────────────────────────────────────────────────
  const deploymentId = findLatestDeploymentForEnv(flightdeckDir, options.source);
  if (!deploymentId) {
    throw new UserError(
      `No snapshot found for ${options.source}.`,
      `  Run: flightdeck pull --env ${options.source}`,
    );
  }

  // Stale snapshot warning (>24h)
  const meta = readSnapshotMeta(flightdeckDir, deploymentId);
  if (meta && !options.yes && !options.json) {
    const snapshotAge = Date.now() - new Date(meta.timestamp).getTime();
    const STALE_MS = 24 * 60 * 60 * 1000;
    if (snapshotAge > STALE_MS) {
      const days = Math.floor(snapshotAge / (1000 * 60 * 60 * 24));
      const ageStr = `${days} day${days === 1 ? '' : 's'}`;
      const snapshotDate = new Date(meta.timestamp).toLocaleDateString();
      console.log();
      console.log(
        `  ${chalk.yellow('⚠')}  Snapshot for ${chalk.cyan(options.source)} is ${ageStr} old (taken: ${snapshotDate}).`,
      );
      console.log(
        `     Run ${chalk.dim(`'flightdeck pull --env ${options.source}'`)} to refresh before pushing.`,
      );
      console.log();

      let proceed: boolean;
      try {
        proceed = await confirm({
          message: 'Push from snapshot anyway?',
          default: false,
        });
      } catch (err) {
        // ExitPromptError (Ctrl+C) — let top-level handler deal with it
        throw err;
      }
      if (!proceed) throw new ControlledExit(0);
    }
  }

  // ── Load snapshot workflows ───────────────────────────────────────────────
  let snapshotWorkflows = readAllWorkflowsInDeployment(flightdeckDir, deploymentId);

  // Apply client-side filters
  snapshotWorkflows = snapshotWorkflows.filter((wf) => {
    if (
      options.tag &&
      !((wf as Record<string, unknown>)['tags'] as Array<{ name: string }> | undefined)
        ?.some((t) => t.name === options.tag)
    ) return false;
    if (options.pattern && !matchesGlob(wf.name, options.pattern)) return false;
    return true;
  });

  if (snapshotWorkflows.length === 0) {
    if (!isJson) {
      console.log();
      const scopeDesc = options.tag ? ` tagged "${options.tag}"` : options.pattern ? ` matching "${options.pattern}"` : '';
      console.log(`  ${chalk.yellow('⚠')} No workflows${scopeDesc} found in snapshot for ${chalk.cyan(options.source)}.`);
      console.log();
    } else {
      console.log(JSON.stringify({
        source: options.source, target: options.target, dry_run: true,
        deployment_id: deploymentId, created: [], updated: [], skipped: [], failed: [],
        credential_map: [], tag_warnings: [], credential_errors: [],
      }));
    }
    return;
  }

  // ── Fetch from target (parallel) ─────────────────────────────────────────
  const spinner = !isJson
    ? ora({ text: `  Fetching ${chalk.cyan(options.target)} workflows…`, color: 'cyan' }).start()
    : null;

  let targetSummaries: WorkflowSummary[];
  let targetCreds: CredentialSummary[];
  let targetTags: TagSummary[];

  try {
    [targetSummaries, targetCreds, targetTags] = await Promise.all([
      targetClient.listWorkflows(),
      targetClient.listCredentials(),
      targetClient.listTags(),
    ]);
  } catch (err) {
    if (spinner) failSpinner(spinner, err);
    throw err;
  }

  if (spinner) {
    spinner.succeed(
      chalk.green(
        `  Fetched ${plural(targetSummaries.length, 'workflow')} from ${options.target}`,
      ),
    );
  }

  // ── Name resolution + classification ─────────────────────────────────────
  const workflowMap = loadWorkflowMap(flightdeckDir);
  const targetByName = new Map<string, WorkflowSummary>(
    targetSummaries.map((w) => [w.name, w]),
  );
  const targetCredNames = new Set(targetCreds.map((c) => c.name));
  const targetTagMap = new Map<string, string>(targetTags.map((t) => [t.name, t.id]));

  const classified: WorkflowClassification[] = snapshotWorkflows.map((wf) => {
    const resolvedName = resolveTargetName(workflowMap, options.source, options.target, wf.name);
    const targetMatch = targetByName.get(resolvedName);
    if (!targetMatch) {
      return { workflow: wf, resolvedName, action: 'would-create', targetActive: false };
    }
    if ((wf as Record<string, unknown>)['versionId'] !== targetMatch.versionId) {
      return { workflow: wf, resolvedName, action: 'would-update', targetActive: targetMatch.active };
    }
    return { workflow: wf, resolvedName, action: 'skipped', targetActive: targetMatch.active };
  });

  // ── Credential map ────────────────────────────────────────────────────────
  // Aggregate all nodes across in-scope (non-skipped) workflows
  const allNodes: unknown[] = [];
  for (const c of classified) {
    if (c.action === 'skipped') continue;
    const nodes = (c.workflow as Record<string, unknown>)['nodes'];
    if (Array.isArray(nodes)) allNodes.push(...nodes);
  }
  const credentials = loadCredentials(flightdeckDir);
  const credMap = buildCredentialMap(allNodes, options.source, options.target, credentials);

  const credentialErrors: CredentialMapEntry[] = [];
  for (const entry of credMap) {
    if (entry.status === 'mapped' && !targetCredNames.has(entry.targetName)) {
      credentialErrors.push(entry);
    }
  }

  // ── Tag resolution ────────────────────────────────────────────────────────
  const allTagNames = new Set<string>();
  for (const c of classified) {
    const tags = (c.workflow as Record<string, unknown>)['tags'] as Array<{ name: string }> | undefined;
    if (Array.isArray(tags)) tags.forEach((t) => allTagNames.add(t.name));
  }
  const tagResolutions: TagResolution[] = Array.from(allTagNames).map((name) => ({
    name,
    targetId: targetTagMap.get(name) ?? null,
  }));
  const tagWarnings = tagResolutions.filter((t) => t.targetId === null);

  // ── Changeset counts ─────────────────────────────────────────────────────
  const toCreate = classified.filter((c) => c.action === 'would-create');
  const toUpdate = classified.filter((c) => c.action === 'would-update');
  const toSkip   = classified.filter((c) => c.action === 'skipped');

  // ── JSON output ───────────────────────────────────────────────────────────
  if (options.json) {
    console.log(
      JSON.stringify({
        source: options.source,
        target: options.target,
        dry_run: true,
        deployment_id: deploymentId,
        created:  toCreate.map((c) => c.workflow.name),
        updated:  toUpdate.map((c) => c.workflow.name),
        skipped:  toSkip.map((c) => c.workflow.name),
        failed:   [],
        credential_map: credMap.map(({ sourceName, targetName, status }) => ({
          sourceName, targetName, status,
        })),
        tag_warnings: tagWarnings.map((t) => t.name),
        credential_errors: credentialErrors.map(({ sourceName, targetName }) => ({
          sourceName, targetName,
        })),
      }),
    );
    if (credentialErrors.length > 0) throw new ControlledExit(1);
    return;
  }

  // ── Human output ─────────────────────────────────────────────────────────
  console.log();

  // Credential map section
  if (credMap.length > 0) {
    console.log(`  Credential map:`);
    for (const entry of credMap) {
      const src = padEnd(entry.sourceName, CRED_COL_WIDTH);
      const dst = padEnd(entry.targetName, CRED_COL_WIDTH);
      if (entry.status === 'passthrough') {
        console.log(
          `    ${chalk.dim(src)} → ${chalk.dim(dst)}  ${chalk.yellow('⚠')} no mapping — passing through unchanged`,
        );
      } else if (credentialErrors.some((e) => e.sourceName === entry.sourceName)) {
        console.log(
          `    ${chalk.dim(src)} → ${chalk.red(entry.targetName)}${' '.repeat(Math.max(0, CRED_COL_WIDTH - entry.targetName.length))}  ${chalk.red('✗')} missing in ${options.target}`,
        );
      } else {
        console.log(
          `    ${chalk.dim(src)} → ${chalk.dim(dst)}  ${chalk.green('✓')} found`,
        );
      }
    }
    console.log();
  }

  // Credential errors — abort before showing changeset
  if (credentialErrors.length > 0) {
    const hint = credentialErrors.map((e) => {
      const logical = e.logicalName ?? e.sourceName;
      return `  flightdeck credential add ${logical} ${options.target}=${e.targetName}`;
    });
    console.log(
      `  ${chalk.red('✗')}  Cannot push — ${plural(credentialErrors.length, 'credential')} not found in ${chalk.cyan(options.target)}. Create ${credentialErrors.length === 1 ? 'it' : 'them'} first or run:`,
    );
    for (const h of hint) console.log(chalk.dim(h));
    console.log();
    throw new ControlledExit(1);
  }

  // Changeset
  for (const c of toCreate) {
    console.log(
      `  ${chalk.green('+')} ${c.workflow.name}  ${chalk.dim('(will be created)')}`,
    );
  }
  for (const c of toUpdate) {
    const activeNote = c.targetActive ? ' — active, will be paused briefly' : '';
    console.log(
      `  ${chalk.yellow('~')} ${c.workflow.name}  ${chalk.dim(`(will be updated${activeNote})`)}`,
    );
  }
  for (const c of toSkip) {
    console.log(
      `  ${chalk.dim('─')} ${c.workflow.name}  ${chalk.dim('(already up to date — skipped)')}`,
    );
  }

  // Tag warnings
  if (tagWarnings.length > 0) {
    console.log();
    for (const tw of tagWarnings) {
      console.log(
        `  ${chalk.yellow('⚠')}  Tag "${tw.name}" not found in ${chalk.cyan(options.target)} — it will not be assigned to pushed workflows`,
      );
    }
  }

  // Summary + next hint
  const changeCount = toCreate.length + toUpdate.length;
  console.log();
  if (changeCount === 0) {
    console.log(`  ${chalk.green('✓')} ${chalk.cyan(options.source)} and ${chalk.cyan(options.target)} are already in sync — no changes needed`);
  } else {
    console.log(
      `  ${plural(changeCount, 'change')}. Run without ${chalk.dim('--dry-run')} to apply.`,
    );
  }

  const nextParts = [
    `--source ${options.source}`,
    `--target ${options.target}`,
    options.tag ? `--tag ${options.tag}` : '',
    options.pattern ? `--pattern "${options.pattern}"` : '',
  ].filter(Boolean);

  console.log(`\n  ${chalk.dim('Next:')} flightdeck push ${nextParts.join(' ')}`);
  console.log();
}

// ── Commander definition ──────────────────────────────────────────────────────

export const pushCommand = new Command('push')
  .description('Push workflows from a source environment to a target environment')
  .requiredOption('--source <env>', 'Source environment (reads from local snapshot)')
  .requiredOption('--target <env>', 'Target environment (the n8n instance to write to)')
  .option('--dry-run', 'Preview changes only — no writes made')
  .option('--tag <tag>', 'Only push workflows with this tag')
  .option('--pattern <glob>', 'Glob pattern matched against workflow names (e.g. "Customer *")')
  .option('--yes', 'Skip all confirmation prompts — for CI/scripted use')
  .option('--no-activate', 'Do not reactivate workflows after push (leave them inactive)')
  .option('--json', 'Output machine-readable JSON instead of human output')
  .option('--gated', 'Paid: gate push on smoke tests passing (requires licenseKey)')
  .addHelpText(
    'after',
    `
Examples:
  Preview changes before pushing:
    flightdeck push --source dev --target prod --dry-run

  Preview changes for a specific tag:
    flightdeck push --source dev --target prod --dry-run --tag billing

  Push (coming soon):
    flightdeck push --source dev --target prod

  Non-interactive push for CI:
    flightdeck push --source dev --target prod --yes
`,
  )
  .action(async (options: PushOptions) => {
    await runPush(options);
  });
