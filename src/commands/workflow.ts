import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { input, confirm } from '@inquirer/prompts';
import { Command } from 'commander';
import { loadConfigAndDir, findFlightdeckDir } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure, logSyncError } from '../lib/git-sync.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError } from '../lib/errors.js';
import {
  loadWorkflowMap,
  loadWorkflowMapRequired,
  writeWorkflowMap,
  upsertEnvEntry,
  deriveLogicalName,
  type WorkflowMap,
  type WorkflowEntry,
} from '../state/workflows.js';
import {
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  listDeployments,
} from '../state/snapshots.js';
import { writeAuditEntry } from '../state/audit.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getGitActor(): string {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    throw new UserError(
      'git config user.email is not set — configure it before running flightdeck',
    );
  }
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padRight(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - visibleLen(s)));
}

function isAlreadyMapped(map: WorkflowMap, env: string, name: string): boolean {
  return Object.values(map.workflows).some((entry) => entry[env]?.name === name);
}

function checkNameConflict(
  map: WorkflowMap,
  logicalName: string,
  env: string,
  name: string,
): void {
  for (const [existing, entry] of Object.entries(map.workflows)) {
    if (existing === logicalName) continue;
    if (entry[env]?.name === name) {
      throw new UserError(
        `"${name}" is already the ${env} name for "${existing}". Each workflow name must map to at most one logical entry per env.`,
      );
    }
  }
}

// Look up the n8n ID for a workflow name from the latest snapshot for that env.
function lookupSnapshotId(flightdeckDir: string, env: string, name: string): string | undefined {
  const dId = findLatestDeploymentForEnv(flightdeckDir, env);
  if (!dId) return undefined;
  return readAllWorkflowsInDeployment(flightdeckDir, dId).find((w) => w.name === name)?.id;
}

interface ParsedArgs {
  logicalName: string | undefined;
  uniformName: string | undefined;
  perEnvNames: Record<string, string>;
}

function parseWorkflowMapArgs(args: string[]): ParsedArgs {
  const perEnvNames: Record<string, string> = {};
  let logicalName: string | undefined;
  let uniformName: string | undefined;
  let plainCount = 0;

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
      perEnvNames[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
    } else {
      plainCount++;
      if (plainCount === 1) logicalName = arg;
      else if (plainCount === 2) uniformName = arg;
      else throw new UserError(`Unexpected argument "${arg}" — did you mean <env>=<name>?`);
    }
  }

  return { logicalName, uniformName, perEnvNames };
}

// ── workflow map ──────────────────────────────────────────────────────────────

async function promptEnvNames(
  envs: string[],
  defaults: Record<string, string>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const env of envs) {
    const current = defaults[env];
    const hint = current ? chalk.dim(`  [${current}]`) : chalk.dim('  (not set, Enter to skip)');
    const answer = await input({
      message: `  Name in ${chalk.cyan(env)}${hint}:`,
      default: current ?? '',
    });
    const value = answer.trim() || current || '';
    if (value) result[env] = value;
  }
  return result;
}

function printMappedEntry(logicalName: string, envNames: Record<string, WorkflowEntry>, allSame: boolean, uniformName?: string): void {
  if (allSame && uniformName) {
    console.log(`\n  ${chalk.green('✓')} Mapped "${chalk.bold(logicalName)}" (all environments → ${uniformName})\n`);
  } else {
    console.log(`\n  ${chalk.green('✓')} Mapped "${chalk.bold(logicalName)}"`);
    const envPad = Math.max(...Object.keys(envNames).map((e) => e.length)) + 2;
    for (const [env, entry] of Object.entries(envNames)) {
      console.log(`    ${padRight(chalk.cyan(env), envPad)} → ${entry.name}`);
    }
    console.log();
  }
}

export async function runWorkflowMap(
  args: string[],
  options: {
    validate?: boolean;
    dryRun?: boolean;
    json?: boolean;
    prune?: boolean;
    yes?: boolean;
  },
  cwd: string = process.cwd(),
): Promise<void> {
  const actor = getGitActor();
  const flightdeckDir = findFlightdeckDir(cwd);
  if (!flightdeckDir) {
    throw new UserError("No .flightdeck/ found. Run 'flightdeck init' first.");
  }

  const map = loadWorkflowMapRequired(flightdeckDir);

  // ── --prune mode ──────────────────────────────────────────────────────────
  if (options.prune) {
    await runWorkflowPrune(flightdeckDir, map, actor, options.yes ?? false, options.dryRun ?? false);
    return;
  }

  // ── Load config for env names ──────────────────────────────────────────────
  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir(cwd);
  } catch {
    // config.json not required for non-interactive non-validate mode
  }

  const { logicalName, uniformName, perEnvNames } = parseWorkflowMapArgs(args);
  const isNonInteractive = uniformName !== undefined || Object.keys(perEnvNames).length > 0;
  const isInteractive = !isNonInteractive;

  if (options.validate && !configResult) {
    throw new UserError('--validate requires config.json to connect to environments.');
  }

  const envList: string[] = configResult ? Object.keys(configResult.config.environments) : [];

  // ── Non-interactive modes ──────────────────────────────────────────────────
  if (isNonInteractive || (logicalName !== undefined && !isInteractive)) {
    if (!logicalName) {
      throw new UserError('Logical name is required in non-interactive mode');
    }

    // Build initial entries (name only — IDs filled in by --validate or future push)
    const envNames: Record<string, WorkflowEntry> = {};
    for (const [env, name] of Object.entries(perEnvNames)) {
      envNames[env] = { name };
    }
    if (uniformName !== undefined) {
      for (const env of (envList.length > 0 ? envList : Object.keys(perEnvNames))) {
        if (!(env in envNames)) envNames[env] = { name: uniformName };
      }
    }

    // Conflict check
    for (const [env, entry] of Object.entries(envNames)) {
      checkNameConflict(map, logicalName, env, entry.name);
    }

    // --validate: hit live API to confirm workflow exists and capture ID
    if (options.validate && configResult) {
      console.log('\n  Validating…');
      const envPad = Math.max(...Object.keys(envNames).map((e) => e.length)) + 2;
      let hasError = false;
      for (const [env, entry] of Object.entries(envNames)) {
        const envConfig = configResult.config.environments[env];
        if (!envConfig) {
          console.log(`    ${padRight(chalk.yellow(env), envPad)} "${entry.name}"    ${chalk.yellow('⚠ env not in config')}`);
          continue;
        }
        const client = new N8nClient(envConfig, env);
        try {
          const workflows = await client.listWorkflows();
          const found = workflows.find((w) => w.name === entry.name);
          if (found) {
            envNames[env] = { name: entry.name, id: found.id };
            console.log(`    ${padRight(chalk.cyan(env), envPad)} "${entry.name}"    ${chalk.green('✓ found')}`);
          } else {
            console.log(`    ${padRight(chalk.cyan(env), envPad)} "${entry.name}"    ${chalk.red('✗ not found in ' + env)}`);
            hasError = true;
          }
        } catch {
          console.log(`    ${padRight(chalk.cyan(env), envPad)} "${entry.name}"    ${chalk.red('✗ could not connect to ' + env)}`);
          hasError = true;
        }
      }
      if (hasError) {
        console.log(`\n  ${chalk.red('✗')} Cannot save — 1 workflow not found. Create it first, or check the name.\n`);
        throw new UserError('Validation failed — aborting without writing.');
      }
    }

    const allSame = uniformName !== undefined && Object.values(envNames).every((e) => e.name === uniformName);

    if (options.dryRun) {
      if (options.json) {
        console.log(JSON.stringify({
          logical_name: logicalName,
          env_names: Object.fromEntries(Object.entries(envNames).map(([e, v]) => [e, v.name])),
          dry_run: true,
        }, null, 2));
      } else {
        console.log('\n  Dry run — would write:');
        console.log(`    ${chalk.bold(logicalName)}`);
        for (const [env, entry] of Object.entries(envNames)) {
          console.log(`      ${chalk.cyan(env)} → ${entry.name}`);
        }
        console.log();
      }
      return;
    }

    // Upsert: preserve existing id when name is unchanged and new entry has none
    if (!map.workflows[logicalName]) map.workflows[logicalName] = {};
    for (const [env, newEntry] of Object.entries(envNames)) {
      upsertEnvEntry(map, logicalName, env, newEntry);
    }
    writeWorkflowMap(flightdeckDir, map);

    writeAuditEntry(flightdeckDir, {
      event_id: crypto.randomUUID(),
      event_schema_version: 1,
      timestamp: new Date().toISOString(),
      actor,
      action: 'map',
      project: configResult?.config.project ?? 'unknown',
      source_env: null,
      target_env: Object.keys(envNames)[0] ?? '',
      workflow_ids: [],
      result: 'success',
      error: null,
      flightdeck_version: '0.1.0',
      match_method: 'manual',
      match_score: null,
    });

    if (options.json) {
      console.log(JSON.stringify({
        logical_name: logicalName,
        env_names: Object.fromEntries(Object.entries(envNames).map(([e, v]) => [e, v.name])),
      }));
    } else {
      printMappedEntry(logicalName, envNames, allSame, uniformName);
    }

    // Sync
    const syncResult = await syncToRemote(
      flightdeckDir,
      configResult?.config ?? { version: 1, project: 'unknown', environments: {} } as never,
      `chore(flightdeck): workflow map ${logicalName}`,
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
    return;
  }

  // ── Interactive modes ──────────────────────────────────────────────────────
  if (!configResult) {
    throw new UserError(
      "Interactive mode requires config.json. Run 'flightdeck configure' first.",
    );
  }

  const config = configResult.config;
  const envs = Object.keys(config.environments);

  // Discover unmapped workflows from snapshots
  interface UnmappedWorkflow {
    name: string;
    id: string;
    sourceEnv: string;
  }
  const unmapped: UnmappedWorkflow[] = [];
  const allSnapshotNames = new Map<string, string>();

  for (const env of envs) {
    const deploymentId = findLatestDeploymentForEnv(flightdeckDir, env);
    if (!deploymentId) continue;
    const workflows = readAllWorkflowsInDeployment(flightdeckDir, deploymentId);
    for (const wf of workflows) {
      if (!isAlreadyMapped(map, env, wf.name)) {
        unmapped.push({ name: wf.name, id: wf.id, sourceEnv: env });
      }
      allSnapshotNames.set(`${env}::${wf.name}`, env);
    }
  }

  const hasSnapshots = unmapped.length > 0 || allSnapshotNames.size > 0;
  let mappedCount = 0;

  console.log();

  if (unmapped.length === 0 && !hasSnapshots) {
    const firstEnv = envs[0] ?? 'dev';
    const secondEnv = envs[1] ?? 'prod';
    console.log(
      `  No snapshots found — flightdeck doesn't know what workflows exist yet.\n\n` +
      `  ${chalk.dim('Run this first to discover your workflows:')}\n` +
      `    flightdeck adopt --env ${firstEnv}\n\n` +
      `  ${chalk.dim('Or map a workflow manually without snapshots:')}\n` +
      `    flightdeck workflow map <logical-name> ${firstEnv}="<name in ${firstEnv}>" ${secondEnv}="<name in ${secondEnv}>"\n`,
    );
    return;
  } else if (unmapped.length === 0) {
    console.log('  All workflows from snapshots are already mapped.\n');
  } else {
    const toProcess = logicalName
      ? unmapped.filter(() => true)
      : unmapped;

    for (const { name: wfName, id: wfId, sourceEnv } of toProcess) {
      if (isAlreadyMapped(map, sourceEnv, wfName)) continue;
      console.log(`  Unmapped workflow: "${chalk.bold(wfName)}"  ${chalk.dim(`from ${sourceEnv}`)}`);

      const suggested = deriveLogicalName(wfName);
      const targetLogical = logicalName ?? await input({
        message: `  Logical name (e.g. ${suggested}, Enter to skip):`,
        default: '',
      });

      if (!targetLogical.trim()) {
        console.log(chalk.dim('  Skipped.\n'));
        continue;
      }

      // Prompt for names in each env (raw strings)
      const rawDefaults: Record<string, string> = { [sourceEnv]: wfName };
      const rawNames = await promptEnvNames(envs, rawDefaults);

      if (Object.keys(rawNames).length === 0) {
        console.log(chalk.dim('  Nothing saved for this workflow.\n'));
        continue;
      }

      // Conflict check
      for (const [env, name] of Object.entries(rawNames)) {
        checkNameConflict(map, targetLogical, env, name);
      }

      // Enrich with IDs: source env uses the snapshot ID; others get snapshot lookup
      const envNames: Record<string, WorkflowEntry> = {};
      for (const [env, name] of Object.entries(rawNames)) {
        if (env === sourceEnv && name === wfName) {
          envNames[env] = { name, id: wfId };
        } else {
          const id = lookupSnapshotId(flightdeckDir, env, name);
          envNames[env] = { name, ...(id ? { id } : {}) };
        }
      }

      if (!options.dryRun) {
        if (!map.workflows[targetLogical]) map.workflows[targetLogical] = {};
        for (const [env, entry] of Object.entries(envNames)) {
          upsertEnvEntry(map, targetLogical, env, entry);
        }
        writeWorkflowMap(flightdeckDir, map);
        writeAuditEntry(flightdeckDir, {
          event_id: crypto.randomUUID(),
          event_schema_version: 1,
          timestamp: new Date().toISOString(),
          actor,
          action: 'map',
          project: config.project,
          source_env: null,
          target_env: Object.keys(envNames)[0] ?? '',
          workflow_ids: [],
          result: 'success',
          error: null,
          flightdeck_version: '0.1.0',
          match_method: 'manual',
          match_score: null,
        });
      }

      printMappedEntry(targetLogical, envNames, false);
      mappedCount++;

      if (logicalName) break;
    }
  }

  if (mappedCount > 0 && !options.dryRun) {
    const syncResult = await syncToRemote(
      flightdeckDir,
      config,
      `chore(flightdeck): workflow map`,
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
}

// ── --prune helper ────────────────────────────────────────────────────────────

async function runWorkflowPrune(
  flightdeckDir: string,
  map: WorkflowMap,
  actor: string,
  autoYes: boolean,
  dryRun: boolean,
): Promise<void> {
  interface StaleEntry {
    logical: string;
    env: string;
    name: string;
  }

  const stale: StaleEntry[] = [];

  for (const [logical, envMap] of Object.entries(map.workflows)) {
    for (const [env, entry] of Object.entries(envMap)) {
      const deploymentId = findLatestDeploymentForEnv(flightdeckDir, env);
      if (!deploymentId) continue;
      const workflows = readAllWorkflowsInDeployment(flightdeckDir, deploymentId);
      if (!workflows.some((w) => w.name === entry.name)) {
        stale.push({ logical, env, name: entry.name });
      }
    }
  }

  if (stale.length === 0) {
    console.log('\n  No stale entries found.\n');
    return;
  }

  console.log(`\n  Stale entries to remove:\n`);
  for (const { logical, env, name } of stale) {
    console.log(`    ${chalk.bold(logical)}  →  ${chalk.cyan(env)}: "${name}" ${chalk.dim('(not found)')}`);
  }
  console.log();

  if (dryRun) {
    console.log(chalk.dim('  Dry run — nothing removed.\n'));
    return;
  }

  let removed = 0;
  for (const { logical, env } of stale) {
    let doRemove = autoYes;
    if (!doRemove) {
      doRemove = await confirm({
        message: `  Remove "${logical}" → ${env} mapping?`,
        default: false,
      });
    }
    if (doRemove) {
      delete map.workflows[logical]![env];
      if (Object.keys(map.workflows[logical] ?? {}).length === 0) {
        delete map.workflows[logical];
      }
      writeWorkflowMap(flightdeckDir, map);
      writeAuditEntry(flightdeckDir, {
        event_id: crypto.randomUUID(),
        event_schema_version: 1,
        timestamp: new Date().toISOString(),
        actor,
        action: 'unmap',
        project: 'unknown',
        source_env: null,
        target_env: env,
        workflow_ids: [],
        result: 'success',
        error: null,
        flightdeck_version: '0.1.0',
      });
      console.log(`  ${chalk.green('✓')} Removed "${logical}" → ${env} mapping.`);
      removed++;
    }
  }

  if (removed === 0) {
    console.log(chalk.dim('\n  Nothing removed.\n'));
  } else {
    console.log();
  }
}

// ── workflow list ─────────────────────────────────────────────────────────────

export async function runWorkflowList(
  options: { env?: string; unmapped?: boolean; json?: boolean },
  cwd: string = process.cwd(),
): Promise<void> {
  const flightdeckDir = findFlightdeckDir(cwd);
  if (!flightdeckDir) {
    throw new UserError("No .flightdeck/ found. Run 'flightdeck init' first.");
  }

  const map = loadWorkflowMapRequired(flightdeckDir);

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir(cwd);
  } catch {
    // ok — fall back to deriving env list from workflows.json
  }

  let envList: string[];
  if (configResult) {
    envList = Object.keys(configResult.config.environments);
  } else {
    const allEnvs = new Set<string>();
    for (const entry of Object.values(map.workflows)) {
      for (const env of Object.keys(entry)) allEnvs.add(env);
    }
    envList = Array.from(allEnvs);
  }

  if (options.env) {
    if (configResult && !configResult.config.environments[options.env]) {
      const available = Object.keys(configResult.config.environments).join(', ');
      throw new UserError(`Unknown environment "${options.env}". Available: ${available}`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify(map, null, 2));
    return;
  }

  if (options.unmapped) {
    const hasAnySnapshot = listDeployments(flightdeckDir).length > 0;
    if (!hasAnySnapshot) {
      throw new UserError(
        "No snapshots found. Run 'flightdeck adopt --env <env>' first.",
      );
    }

    const envs = options.env ? [options.env] : envList;
    let foundAny = false;

    console.log('\n  Unmapped workflows (not in workflows.json):\n');
    for (const env of envs) {
      const deploymentId = findLatestDeploymentForEnv(flightdeckDir, env);
      if (!deploymentId) continue;
      const workflows = readAllWorkflowsInDeployment(flightdeckDir, deploymentId);
      const unmapped = workflows.filter((w) => !isAlreadyMapped(map, env, w.name));
      if (unmapped.length > 0) {
        foundAny = true;
        console.log(`    ${chalk.cyan(env)}:`);
        for (const wf of unmapped) {
          console.log(`      ${chalk.dim('–')} ${wf.name}`);
        }
        console.log();
      }
    }

    if (!foundAny) {
      console.log('  All workflows are mapped.\n');
      return;
    }

    const sourceEnv = envs[0] ?? 'dev';
    const targetEnv = envs[1] ?? envs[0] ?? 'prod';
    console.log(
      chalk.dim(
        `  Run 'flightdeck workflow map --source ${sourceEnv} --target ${targetEnv}' to auto-detect matches.\n` +
        `  Or map manually: flightdeck workflow map <logical-name> ${sourceEnv}="..." ${targetEnv}="..."\n`,
      ),
    );
    return;
  }

  // Default: table view
  let entries = Object.entries(map.workflows);

  if (options.env) {
    entries = entries.filter(([, envMap]) => options.env! in envMap);
  }

  if (entries.length === 0) {
    console.log(chalk.dim('\n  No workflow mappings found. Run flightdeck workflow map to add one.\n'));
    return;
  }

  const C_LOGICAL = Math.max(12, ...entries.map(([l]) => l.length)) + 2;
  const C_ENV = Math.max(12, ...envList.map((e) => e.length));
  const C_NAME = Math.max(C_ENV, 24);

  console.log();
  const headerParts = [padRight(chalk.dim('LOGICAL NAME'), C_LOGICAL)];
  for (const env of envList) {
    headerParts.push(padRight(chalk.dim(env.toUpperCase()), C_NAME + 2));
  }
  console.log('  ' + headerParts.join(''));

  for (const [logical, envMap] of entries) {
    const hasGap = envList.some((env) => !(env in envMap));
    const logicalStr = hasGap ? chalk.yellow(logical) : logical;
    const parts = [padRight(logicalStr, C_LOGICAL)];
    for (const env of envList) {
      const name = envMap[env]?.name;
      parts.push(padRight(name ?? chalk.dim('(not set)'), C_NAME + 2));
    }
    console.log('  ' + parts.join(''));
  }

  console.log();
}

// ── workflow unmap ────────────────────────────────────────────────────────────

export async function runWorkflowUnmap(
  logicalName: string,
  options: { env?: string },
  cwd: string = process.cwd(),
): Promise<void> {
  const actor = getGitActor();
  const flightdeckDir = findFlightdeckDir(cwd);
  if (!flightdeckDir) {
    throw new UserError("No .flightdeck/ found. Run 'flightdeck init' first.");
  }

  const map = loadWorkflowMapRequired(flightdeckDir);

  if (!(logicalName in map.workflows)) {
    throw new UserError(
      `Workflow mapping "${logicalName}" not found in workflows.json`,
    );
  }

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir(cwd);
  } catch { /* best-effort */ }

  if (options.env) {
    const entry = map.workflows[logicalName];
    if (!entry || !(options.env in entry)) {
      throw new UserError(
        `No mapping for "${logicalName}" in env "${options.env}"`,
      );
    }
    delete entry[options.env];
    if (Object.keys(entry).length === 0) {
      delete map.workflows[logicalName];
    }
  } else {
    delete map.workflows[logicalName];
  }

  writeWorkflowMap(flightdeckDir, map);

  writeAuditEntry(flightdeckDir, {
    event_id: crypto.randomUUID(),
    event_schema_version: 1,
    timestamp: new Date().toISOString(),
    actor,
    action: 'unmap',
    project: configResult?.config.project ?? 'unknown',
    source_env: null,
    target_env: options.env ?? '',
    workflow_ids: [],
    result: 'success',
    error: null,
    flightdeck_version: '0.1.0',
  });

  if (options.env) {
    console.log(
      `\n  ${chalk.green('✓')} Removed "${logicalName}" mapping for ${options.env}\n`,
    );
  } else {
    console.log(
      `\n  ${chalk.green('✓')} Removed workflow mapping "${logicalName}"\n`,
    );
  }

  const syncResult = await syncToRemote(
    flightdeckDir,
    configResult?.config ?? { version: 1, project: 'unknown', environments: {} } as never,
    `chore(flightdeck): workflow unmap ${logicalName}`,
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

// ── Commander wiring ──────────────────────────────────────────────────────────

const workflowMapCmd = new Command('map')
  .description('Map workflow names across environments in workflows.json')
  .argument('[args...]', 'Logical name, uniform name, or env=name pairs')
  .option('--validate', 'Verify workflow names exist in their n8n environments')
  .option('--dry-run', 'Print what would be written without saving')
  .option('--json', 'Emit the mapping entry as JSON instead of human output')
  .option('--prune', 'Remove stale entries whose mapped names no longer exist in any snapshot')
  .option('--yes', 'Auto-accept confirmations (for --prune)')
  .addHelpText(
    'after',
    `
Examples:
  Interactive — discover and map unmapped workflows:
    flightdeck workflow map

  Provide logical name, prompt for env names:
    flightdeck workflow map order-processor

  Uniform name (same in all environments):
    flightdeck workflow map invoice-sync "Invoice Sync"

  Per-environment names:
    flightdeck workflow map order-processor dev="Order Processor [DEV]" prod="Order Processor"

  Remove stale entries:
    flightdeck workflow map --prune
`,
  )
  .action(async (args: string[], options) => {
    await runWorkflowMap(args, options);
  });

const workflowListCmd = new Command('list')
  .description('List all workflow name mappings from workflows.json')
  .option('--env <env>', 'Show only entries that include a mapping for this environment')
  .option('--unmapped', 'Show workflows from the most recent snapshot with no mapping')
  .option('--json', 'Emit the full workflows.json as JSON')
  .addHelpText(
    'after',
    `
Examples:
  List all mappings:
    flightdeck workflow list

  Show only mappings for prod:
    flightdeck workflow list --env prod

  Find unmapped workflows across all environments:
    flightdeck workflow list --unmapped
`,
  )
  .action(async (options) => {
    await runWorkflowList(options);
  });

const workflowUnmapCmd = new Command('unmap')
  .description('Remove a workflow mapping from workflows.json')
  .argument('<logical-name>', 'Logical workflow identifier to remove')
  .option('--env <env>', 'Remove only this environment\'s mapping')
  .addHelpText(
    'after',
    `
Examples:
  Remove the entire logical workflow entry:
    flightdeck workflow unmap order-processor

  Remove only the staging mapping:
    flightdeck workflow unmap order-processor --env staging
`,
  )
  .action(async (logicalName: string, options) => {
    await runWorkflowUnmap(logicalName, options);
  });

export const workflowCommand = new Command('workflow')
  .description('Manage workflow name mappings across environments');

workflowCommand.addCommand(workflowMapCmd);
workflowCommand.addCommand(workflowListCmd);
workflowCommand.addCommand(workflowUnmapCmd);
