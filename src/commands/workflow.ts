import chalk from 'chalk';
import { input, confirm, search } from '@inquirer/prompts';
import { Command, Option } from 'commander';
import { loadConfigAndDir, findChiralDir, resolveEnv, type Config } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure} from '../lib/git-sync.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError } from '../lib/errors.js';
import { getGitActor } from '../lib/git.js';
import { padRight, plural, getChiralVersion, renderBoxTable } from '../lib/cli.js';
import { printJson } from '../lib/output.js';
import {
  loadWorkflowMapRequired,
  writeWorkflowMap,
  upsertEnvEntry,
  deriveLogicalName,
  validateNoDuplicateTargets,
  validateNoCircularMapping,
  type WorkflowMap,
  type WorkflowEntry,
} from '../state/workflows.js';
import {
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  listDeployments,
} from '../state/snapshots.js';
import { writeAuditEntry } from '../state/audit.js';
import { loadFingerprints } from '../state/fingerprints.js';
import { buildStructureIndex, claimLogicalName, matchExact, reserveLogicalNames } from '../lib/workflow-match.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
function lookupSnapshotId(chiralDir: string, env: string, name: string): string | undefined {
  const dId = findLatestDeploymentForEnv(chiralDir, env);
  if (!dId) return undefined;
  return readAllWorkflowsInDeployment(chiralDir, dId).workflows.find((w) => w.name === name)?.id;
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
    if (eqIdx === 0) {
      throw new UserError(`Invalid argument "${arg}" — environment name cannot be empty before '='`);
    }
    if (eqIdx > 0) {
      perEnvNames[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
    } else {
      plainCount++;
      if (plainCount === 1) logicalName = arg;
      else if (plainCount === 2) uniformName = arg;
      else throw new UserError(`Unexpected argument "${arg}" - did you mean <env>=<name>?`);
    }
  }

  return { logicalName, uniformName, perEnvNames };
}

// ── workflow map ──────────────────────────────────────────────────────────────

async function promptEnvNames(
  envs: string[],
  defaults: Record<string, string>,
  envWorkflows?: Map<string, Array<{ name: string; id: string }>>,
): Promise<{ names: Record<string, string>; selectedIds: Map<string, string> }> {
  const names: Record<string, string> = {};
  const selectedIds = new Map<string, string>();

  for (const env of envs) {
    const current = defaults[env];
    const workflows = envWorkflows?.get(env);

    if (workflows && workflows.length > 0) {
      const selected = await search<string | null>({
        message: `  Name in ${chalk.cyan(env)}:`,
        source: (term) => {
          const skip = { value: null, name: chalk.dim('─ skip this env ─') };
          if (!term) return [skip, ...workflows.map((w) => ({ value: w.name }))];
          const lower = term.toLowerCase();
          return [
            ...workflows
              .filter((w) => w.name.toLowerCase().includes(lower))
              .map((w) => ({ value: w.name })),
            skip,
          ];
        },
        default: current,
      });
      if (selected !== null) {
        names[env] = selected;
        const wf = workflows.find((w) => w.name === selected);
        if (wf) selectedIds.set(`${env}::${selected}`, wf.id);
      }
    } else {
      const hint = current ? chalk.dim(`  [${current}]`) : chalk.dim('  (not set, Enter to skip)');
      const answer = await input({
        message: `  Name in ${chalk.cyan(env)}${hint}:`,
        default: current ?? '',
      });
      const value = answer.trim() || current || '';
      if (value) names[env] = value;
    }
  }

  return { names, selectedIds };
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
): Promise<void> {
  const actor = getGitActor();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const map = loadWorkflowMapRequired(chiralDir);

  // ── --prune mode ──────────────────────────────────────────────────────────
  if (options.prune) {
    await runWorkflowPrune(chiralDir, map, actor, options.yes ?? false, options.dryRun ?? false);
    return;
  }

  // ── Load config for env names ──────────────────────────────────────────────
  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
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

    // Build initial entries (name only - IDs filled in by --validate or future push)
    const envNames: Record<string, WorkflowEntry> = {};
    for (const [env, name] of Object.entries(perEnvNames)) {
      envNames[env] = { name };
    }
    if (uniformName !== undefined) {
      for (const env of (envList.length > 0 ? envList : Object.keys(perEnvNames))) {
        if (!(env in envNames)) envNames[env] = { name: uniformName };
      }
    }

    if (Object.keys(envNames).length === 0) {
      throw new UserError(
        'No environments resolved. Provide per-env names (env=name) or run inside a chiral project with config.json.',
      );
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
            console.error(`    ${padRight(chalk.cyan(env), envPad)} "${entry.name}"    ${chalk.red('✗ not found in ' + env)}`);
            hasError = true;
          }
        } catch {
          console.error(`    ${padRight(chalk.cyan(env), envPad)} "${entry.name}"    ${chalk.red('✗ could not connect to ' + env)}`);
          hasError = true;
        }
      }
      if (hasError) {
        console.error(`\n  ${chalk.red('✗')} Cannot save - 1 workflow not found. Create it first, or check the name.\n`);
        throw new UserError('Validation failed - aborting without writing.');
      }
    }

    const allSame = uniformName !== undefined && Object.values(envNames).every((e) => e.name === uniformName);

    if (options.dryRun) {
      if (options.json) {
        printJson({
          logical_name: logicalName,
          env_names: Object.fromEntries(Object.entries(envNames).map(([e, v]) => [e, v.name])),
          dry_run: true,
        });
      } else {
        console.log('\n  Dry run - would write:');
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
    const writtenEnvs = Object.keys(envNames);
    for (let i = 0; i < writtenEnvs.length; i++) {
      for (let j = i + 1; j < writtenEnvs.length; j++) {
        validateNoDuplicateTargets(map, writtenEnvs[i], writtenEnvs[j]);
      }
    }
    writeWorkflowMap(chiralDir, map);

    writeAuditEntry(chiralDir, {
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
      chiral_version: getChiralVersion(),
      match_method: 'manual',
      match_score: null,
    });

    if (options.json) {
      printJson({
        logical_name: logicalName,
        env_names: Object.fromEntries(Object.entries(envNames).map(([e, v]) => [e, v.name])),
      });
    } else {
      printMappedEntry(logicalName, envNames, allSame, uniformName);
    }

    // Sync
    if (configResult) {
      const syncResult = await syncToRemote(
        chiralDir,
        configResult.config,
        `chore(chiral): workflow map ${logicalName}`,
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
    return;
  }

  // ── Interactive modes ──────────────────────────────────────────────────────
  if (!configResult) {
    throw new UserError(
      "Interactive mode requires config.json. Run 'chiral environment add <env>' first.",
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
  const snapshotWorkflowsCache = new Map<string, Array<{ name: string; id: string }>>();

  for (const env of envs) {
    const deploymentId = findLatestDeploymentForEnv(chiralDir, env);
    if (!deploymentId) continue;
    const { workflows } = readAllWorkflowsInDeployment(chiralDir, deploymentId);
    snapshotWorkflowsCache.set(env, workflows.map((w) => ({ name: w.name, id: w.id })));
    for (const wf of workflows) {
      if (!isAlreadyMapped(map, env, wf.name)) {
        unmapped.push({ name: wf.name, id: wf.id, sourceEnv: env });
      }
      allSnapshotNames.set(`${env}::${wf.name}`, env);
    }
  }

  const hasSnapshots = unmapped.length > 0 || allSnapshotNames.size > 0;
  let mappedCount = 0;

  if (!options.json) console.log();

  if (unmapped.length === 0 && !hasSnapshots) {
    const firstEnv = envs[0] ?? 'dev';
    const secondEnv = envs[1] ?? 'prod';
    console.log(
      `  No snapshots found - chiral doesn't know what workflows exist yet.\n\n` +
      `  ${chalk.dim('Run this first to discover your workflows:')}\n` +
      `    chiral adopt ${firstEnv}\n\n` +
      `  ${chalk.dim('Or map a workflow manually without snapshots:')}\n` +
      `    chiral workflow map <logical-name> ${firstEnv}="<name in ${firstEnv}>" ${secondEnv}="<name in ${secondEnv}>"\n`,
    );
    return;
  } else if (unmapped.length === 0) {
    if (!options.json) console.log('  All workflows from snapshots are already mapped.\n');
  } else {
    // Pre-fetch workflow lists once per env when --validate (reused across all mappings in this session)
    const envWorkflowsCache = new Map<string, Array<{ name: string; id: string }>>();
    if (options.validate) {
      for (const env of envs) {
        const envConfig = config.environments[env];
        if (!envConfig) continue;
        const client = new N8nClient(envConfig, env);
        try {
          const workflows = await client.listWorkflows();
          envWorkflowsCache.set(env, workflows.map((w) => ({ name: w.name, id: w.id })));
        } catch {
          // env unreachable - will fall back to plain input for this env
        }
      }
    }

    const toProcess = unmapped;

    const jsonResults: Array<{ logical_name: string; env_names: Record<string, string> }> = [];

    for (const { name: wfName, id: wfId, sourceEnv } of toProcess) {
      if (isAlreadyMapped(map, sourceEnv, wfName)) continue;
      if (!options.json) console.log(`  Unmapped workflow: "${chalk.bold(wfName)}"  ${chalk.dim(`from ${sourceEnv}`)}`);

      const suggested = deriveLogicalName(wfName, envs);
      const targetLogical = logicalName ?? await input({
        message: `  Logical name (clear to skip):`,
        default: suggested,
      });

      if (!targetLogical.trim()) {
        console.log(chalk.dim('  Skipped.\n'));
        continue;
      }

      const baseCache = options.validate ? envWorkflowsCache : snapshotWorkflowsCache;
      const filteredCache = new Map(
        Array.from(baseCache.entries()).map(([env, workflows]) => [
          env,
          workflows.filter((w) => !isAlreadyMapped(map, env, w.name)),
        ]),
      );
      const { names: promptedNames, selectedIds: validatedIds } = await promptEnvNames(
        envs,
        { [sourceEnv]: wfName },
        filteredCache,
      );
      const rawNames: Record<string, string> = { ...promptedNames };

      if (Object.keys(rawNames).length === 0) {
        console.log(chalk.dim('  Nothing saved for this workflow.\n'));
        continue;
      }

      // Conflict check
      for (const [env, name] of Object.entries(rawNames)) {
        checkNameConflict(map, targetLogical, env, name);
      }

      // Enrich with IDs: source env uses snapshot ID; validated envs use cached live ID; others snapshot lookup
      const envNames: Record<string, WorkflowEntry> = {};
      for (const [env, name] of Object.entries(rawNames)) {
        if (env === sourceEnv && name === wfName) {
          envNames[env] = { name, id: wfId };
        } else {
          const id = validatedIds.get(`${env}::${name}`) ?? lookupSnapshotId(chiralDir, env, name);
          envNames[env] = { name, ...(id ? { id } : {}) };
        }
      }

      if (!options.dryRun) {
        if (!map.workflows[targetLogical]) map.workflows[targetLogical] = {};
        for (const [env, entry] of Object.entries(envNames)) {
          upsertEnvEntry(map, targetLogical, env, entry);
        }
        writeAuditEntry(chiralDir, {
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
          chiral_version: getChiralVersion(),
          match_method: 'manual',
          match_score: null,
        });
      }

      if (options.json) {
        jsonResults.push({
          logical_name: targetLogical,
          env_names: Object.fromEntries(Object.entries(envNames).map(([e, v]) => [e, v.name])),
        });
      } else {
        printMappedEntry(targetLogical, envNames, false);
      }
      mappedCount++;

      if (logicalName) break;
    }

    if (options.json && jsonResults.length > 0) {
      printJson(jsonResults.length === 1 ? jsonResults[0] : jsonResults);
    }
  }

  if (mappedCount > 0 && !options.dryRun) {
    writeWorkflowMap(chiralDir, map);
    const syncResult = await syncToRemote(
      chiralDir,
      config,
      `chore(chiral): workflow map`,
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
}

// ── --prune helper ────────────────────────────────────────────────────────────

async function runWorkflowPrune(
  chiralDir: string,
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

  const deploymentNames = new Map<string, Set<string>>();
  const allMappedEnvs = new Set(Object.values(map.workflows).flatMap((e) => Object.keys(e)));
  for (const env of allMappedEnvs) {
    const dId = findLatestDeploymentForEnv(chiralDir, env);
    if (!dId) continue;
    const { workflows } = readAllWorkflowsInDeployment(chiralDir, dId);
    deploymentNames.set(env, new Set(workflows.map((w) => w.name)));
  }

  for (const [logical, envMap] of Object.entries(map.workflows)) {
    for (const [env, entry] of Object.entries(envMap)) {
      const names = deploymentNames.get(env);
      if (!names) continue;
      if (!names.has(entry.name)) {
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
    console.log(chalk.dim('  Dry run - nothing removed.\n'));
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
      if (!map.workflows[logical]) continue;
      delete map.workflows[logical][env];
      if (Object.keys(map.workflows[logical]).length === 0) {
        delete map.workflows[logical];
      }
      writeWorkflowMap(chiralDir, map);
      writeAuditEntry(chiralDir, {
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
        chiral_version: getChiralVersion(),
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

// Result types for the collect→render pipeline
interface UnmappedResult {
  env: string;
  name: string;
  id: string;
}

type IncompleteIssue =
  | { kind: 'missing_env'; env: string }
  | { kind: 'missing_id'; env: string; name: string };

interface IncompleteResult {
  logical: string;
  issues: IncompleteIssue[];
}

// ── Collect helpers (pure - no rendering side effects) ────────────────────────

function collectUnmapped(
  chiralDir: string,
  map: WorkflowMap,
  envs: string[],
): UnmappedResult[] {
  if (listDeployments(chiralDir).length === 0) {
    throw new UserError("No snapshots found. Run 'chiral adopt <env>' first.");
  }
  const results: UnmappedResult[] = [];
  for (const env of envs) {
    const deploymentId = findLatestDeploymentForEnv(chiralDir, env);
    if (!deploymentId) continue;
    const { workflows } = readAllWorkflowsInDeployment(chiralDir, deploymentId);
    for (const wf of workflows) {
      if (!isAlreadyMapped(map, env, wf.name)) {
        results.push({ env, name: wf.name, id: wf.id });
      }
    }
  }
  return results;
}

function collectIncomplete(map: WorkflowMap, envList: string[]): IncompleteResult[] {
  const results: IncompleteResult[] = [];
  for (const [logical, envMap] of Object.entries(map.workflows)) {
    const issues: IncompleteIssue[] = [];
    for (const env of envList) {
      const entry = envMap[env];
      if (!entry) {
        issues.push({ kind: 'missing_env', env });
      } else if (!entry.id) {
        issues.push({ kind: 'missing_id', env, name: entry.name });
      }
    }
    if (issues.length > 0) results.push({ logical, issues });
  }
  return results;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderMappedHuman(
  entries: Array<[string, Record<string, WorkflowEntry>]>,
  envList: string[],
): void {
  if (entries.length === 0) {
    console.log(chalk.dim('\n  No workflow mappings found. Run chiral workflow map to add one.\n'));
    return;
  }

  const C_LOGICAL = Math.max('LOGICAL NAME'.length, ...entries.map(([l]) => l.length));
  const C_ENVS = envList.map((env) =>
    Math.max(env.length, ...entries.map(([, m]) => (m[env]?.name ?? '(not set)').length)),
  );
  const widths = [C_LOGICAL, ...C_ENVS];
  const headers = [chalk.dim('LOGICAL NAME'), ...envList.map((env) => chalk.cyan(env))];
  const rows = entries.map(([logical, envMap]) => ({
    label: logical,
    hasGap: envList.some((env) => !(env in envMap)),
    cells: envList.map((env) => envMap[env]?.name ?? chalk.dim('(not set)')),
  }));
  renderBoxTable(widths, headers, rows);
}

function renderUnmappedHuman(results: UnmappedResult[], envList: string[]): void {
  console.log('\n  Unmapped workflows (not in workflows.json):\n');

  if (results.length === 0) {
    console.log('  All workflows are mapped.\n');
    return;
  }

  // Group by env for structured display
  const byEnv = new Map<string, UnmappedResult[]>();
  for (const r of results) {
    const list = byEnv.get(r.env) ?? [];
    list.push(r);
    byEnv.set(r.env, list);
  }
  for (const [env, wfs] of byEnv) {
    console.log(`    ${chalk.cyan(env)}:`);
    for (const wf of wfs) {
      console.log(`      ${chalk.dim('–')} ${wf.name}`);
    }
    console.log();
  }

  const sourceEnv = envList[0] ?? 'dev';
  const targetEnv = envList[1] ?? envList[0] ?? 'prod';
  console.log(
    chalk.dim(
      `  Run 'chiral workflow match --from ${sourceEnv} --to ${targetEnv}' to auto-detect matches.\n` +
      `  Or map manually: chiral workflow map <logical-name> ${sourceEnv}="..." ${targetEnv}="..."\n`,
    ),
  );
}

function renderIncompleteHuman(results: IncompleteResult[]): void {
  if (results.length === 0) {
    console.log('\n  All mappings are complete.\n');
    return;
  }

  console.log('\n  Incomplete mappings:\n');

  const firstWithMissingId = results.find((r) =>
    r.issues.some((i) => i.kind === 'missing_id'),
  )?.logical;

  for (const { logical, issues } of results) {
    console.log(`    ${chalk.bold(logical)}`);
    for (const issue of issues) {
      if (issue.kind === 'missing_id') {
        console.log(
          `      ${chalk.yellow('⚠')} ${chalk.cyan(issue.env)}  missing id  ${chalk.dim(`(name: "${issue.name}")`)}`,
        );
      } else {
        console.log(`      ${chalk.yellow('⚠')} ${chalk.cyan(issue.env)}  missing env entry`);
      }
    }
    console.log();
  }

  if (firstWithMissingId) {
    console.log(
      chalk.dim(
        `  Run 'chiral workflow map --validate ${firstWithMissingId}' to fill in missing IDs.\n`,
      ),
    );
  } else {
    console.log(
      chalk.dim(
        `  Run 'chiral workflow map <logical-name> <env>="..."' to add missing env entries.\n`,
      ),
    );
  }
}

export async function runWorkflowList(
  options: { env?: string; unmapped?: boolean; incomplete?: boolean; json?: boolean },
): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const map = loadWorkflowMapRequired(chiralDir);

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch {
    // ok - fall back to deriving env list from workflows.json
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

  // ── --unmapped mode ───────────────────────────────────────────────────────
  if (options.unmapped) {
    const envs = options.env ? [options.env] : envList;
    const results = collectUnmapped(chiralDir, map, envs);
    if (options.json) {
      printJson(results);
    } else {
      renderUnmappedHuman(results, envList);
    }
    return;
  }

  // ── --incomplete mode ─────────────────────────────────────────────────────
  if (options.incomplete) {
    const allIncomplete = collectIncomplete(map, envList);
    const results = options.env
      ? allIncomplete.filter((r) => r.issues.some((i) => i.env === options.env))
      : allIncomplete;
    if (options.json) {
      printJson(results);
    } else {
      renderIncompleteHuman(results);
    }
    return;
  }

  // ── Default: mapped table ─────────────────────────────────────────────────
  let entries = Object.entries(map.workflows);
  if (options.env) {
    entries = entries.filter(([, envMap]) => options.env! in envMap);
  }

  if (options.json) {
    if (options.env) {
      printJson({ version: map.version, workflows: Object.fromEntries(entries) });
    } else {
      printJson(map);
    }
    return;
  }

  renderMappedHuman(entries, envList);
}

// ── workflow unmap ────────────────────────────────────────────────────────────

export async function runWorkflowUnmap(
  logicalName: string,
  options: { env?: string },
): Promise<void> {
  const actor = getGitActor();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const map = loadWorkflowMapRequired(chiralDir);

  if (!(logicalName in map.workflows)) {
    throw new UserError(
      `Workflow mapping "${logicalName}" not found in workflows.json`,
    );
  }

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
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

  writeWorkflowMap(chiralDir, map);

  writeAuditEntry(chiralDir, {
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
    chiral_version: getChiralVersion(),
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

  if (configResult) {
    const syncResult = await syncToRemote(
      chiralDir,
      configResult.config,
      `chore(chiral): workflow unmap ${logicalName}`,
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
}

// ── workflow match ────────────────────────────────────────────────────────────

export interface WorkflowMatchOptions {
  from?: string;
  to?: string;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  previewDiff?: boolean;
}

type MatchOutputMode = 'human' | 'json';

function resolveMatchOutputMode(options: WorkflowMatchOptions): MatchOutputMode {
  if (options.json || !process.stdout.isTTY) return 'json';
  return 'human';
}

function validateMatchOptions(
  options: WorkflowMatchOptions,
  config: Config,
): { from: string; to: string } {
  if (!options.from) throw new UserError('--from is required');
  if (!options.to) throw new UserError('--to is required');
  resolveEnv(config, options.from);
  resolveEnv(config, options.to);
  if (options.from === options.to) {
    throw new UserError('--from and --to must be different environments');
  }
  if (options.yes && options.dryRun) {
    throw new UserError('--yes has no effect with --dry-run');
  }
  if (options.previewDiff && !options.dryRun) {
    throw new UserError('--preview-diff requires --dry-run');
  }
  return { from: options.from, to: options.to };
}

interface MatchCandidate {
  logical_name?: string;
  source_name: string;
  target_name: string | string[];
  confidence: 'exact' | 'ambiguous';
  fuzzy_score: null;
  algorithm: 'structure_hash';
  structure_match: true;
  accepted: boolean;
}

function buildMatchCandidates(
  reserved: Array<{ logicalName: string; sourceName: string; targetName: string }>,
  ambiguous: Array<{ sourceName: string; targetNames: string[] }>,
  written: boolean,
): MatchCandidate[] {
  const candidates: MatchCandidate[] = reserved.map((r) => ({
    logical_name: r.logicalName,
    source_name: r.sourceName,
    target_name: r.targetName,
    confidence: 'exact',
    fuzzy_score: null,
    algorithm: 'structure_hash',
    structure_match: true,
    accepted: written,
  }));
  for (const a of ambiguous) {
    candidates.push({
      source_name: a.sourceName,
      target_name: a.targetNames,
      confidence: 'ambiguous',
      fuzzy_score: null,
      algorithm: 'structure_hash',
      structure_match: true,
      accepted: false,
    });
  }
  return candidates;
}

export async function runWorkflowMatch(
  options: WorkflowMatchOptions,
  cwd?: string,
): Promise<void> {
  const outputMode = resolveMatchOutputMode(options);
  const actor = getGitActor();
  const chiralDir = findChiralDir(cwd);
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const { config } = loadConfigAndDir(cwd);
  const { from, to } = validateMatchOptions(options, config);

  const fingerprints = loadFingerprints(chiralDir);
  if (!fingerprints.envs[from]) {
    throw new UserError(`No fingerprints found for ${from}. Run: chiral adopt ${from}`);
  }
  if (!fingerprints.envs[to]) {
    throw new UserError(`No fingerprints found for ${to}. Run: chiral adopt ${to}`);
  }

  const map = loadWorkflowMapRequired(chiralDir);

  const srcIndex = buildStructureIndex(fingerprints.envs[from]);
  const tgtIndex = buildStructureIndex(fingerprints.envs[to]);
  const result = matchExact(srcIndex, tgtIndex, map, from, to);
  const reserved = reserveLogicalNames(map, result.matches, Object.keys(config.environments));

  // ── Decide whether to write ──────────────────────────────────────────────
  let shouldWrite = false;
  if (reserved.length > 0 && !options.dryRun) {
    if (options.yes) {
      shouldWrite = true;
    } else if (outputMode === 'human') {
      shouldWrite = await confirm({
        message: `  Write ${reserved.length} mapping${reserved.length === 1 ? '' : 's'} to workflows.json?`,
        default: true,
      });
    } else {
      // non-TTY without --yes: treated as declined, exit 0
      shouldWrite = false;
    }
  }

  // ── Apply + validate before any output, so a validation failure can't follow
  // a printed "✓ Wrote" success message ───────────────────────────────────
  if (shouldWrite) {
    const mapDraft = JSON.parse(JSON.stringify(map)) as WorkflowMap;
    for (const r of reserved) {
      upsertEnvEntry(mapDraft, r.logicalName, from, { name: r.sourceName });
      upsertEnvEntry(mapDraft, r.logicalName, to, { name: r.targetName });
    }
    validateNoDuplicateTargets(mapDraft, from, to);
    validateNoCircularMapping(mapDraft, from, to);
    for (const r of reserved) {
      upsertEnvEntry(map, r.logicalName, from, { name: r.sourceName });
      upsertEnvEntry(map, r.logicalName, to, { name: r.targetName });
    }
  }

  // Names already reserved for Pass-1 matches, so manual-resolution hints for
  // ambiguous entries don't suggest a logical name that collides with them.
  const reservedNames = new Set<string>([...Object.keys(map.workflows), ...reserved.map((r) => r.logicalName)]);

  // Reserved entries where source and target names differ would have shown up as a
  // separate "added" (source) and "removed" (target) row in `chiral diff`; mapping
  // them collapses both into one modified/unchanged row. Entries with matching names
  // already resolved by name and contribute nothing.
  const previewDiffResolved = reserved.filter((r) => r.sourceName !== r.targetName).length;

  // ── Human output: Pass 1 block ───────────────────────────────────────────
  if (outputMode === 'human') {
    if (reserved.length > 0) {
      console.log(`\n  Pass 1 — exact structure matches (${from} → ${to}):\n`);
      const srcCol = Math.max(...reserved.map((r) => `"${r.sourceName}"`.length));
      for (const r of reserved) {
        console.log(`    ${padRight(`"${r.sourceName}"`, srcCol)}   →  "${r.targetName}"`);
      }

      if (options.dryRun) {
        console.log(`\n  Dry run - would write ${reserved.length} mapping${reserved.length === 1 ? '' : 's'}:`);
        const logicalCol = Math.max(...reserved.map((r) => r.logicalName.length));
        for (const r of reserved) {
          console.log(`    ${padRight(r.logicalName, logicalCol)}  ${from}="${r.sourceName}"  ${to}="${r.targetName}"`);
        }
        console.log();
        if (options.previewDiff) {
          const n = previewDiffResolved;
          console.log(
            `  Applying these ${plural(reserved.length, 'mapping')} would resolve ${n} + / ${n} - rows in chiral diff --from ${from} --to ${to}\n`,
          );
        }
      } else if (shouldWrite) {
        console.log(`\n  ${chalk.green('✓')} Wrote ${reserved.length} mapping${reserved.length === 1 ? '' : 's'}`);
        const logicalCol = Math.max(...reserved.map((r) => r.logicalName.length));
        for (const r of reserved) {
          console.log(`    ${padRight(r.logicalName, logicalCol)}  ${from}="${r.sourceName}"  ${to}="${r.targetName}"`);
        }
        console.log();
      }
    }

    if (result.ambiguous.length > 0) {
      console.log(`\n  Ambiguous matches (same structure, multiple candidates in ${to}):\n`);
      for (const a of result.ambiguous) {
        console.log(`    "${a.sourceName}" matches ${a.targetNames.length} workflows in ${to}:`);
        for (const tName of a.targetNames) {
          console.log(`      - "${tName}"`);
        }
        const hintBase = deriveLogicalName(a.sourceName, Object.keys(config.environments));
        const hintLogical = claimLogicalName(hintBase, reservedNames);
        console.log(
          `\n  → Resolve manually: chiral workflow map ${hintLogical} ${from}="${a.sourceName}" ${to}="${a.targetNames[0]}"\n`,
        );
      }
    }

    if (reserved.length === 0 && result.ambiguous.length === 0) {
      console.log(`\n  No exact structure matches found between ${from} and ${to}.\n`);
    }

    if (shouldWrite) {
      for (const name of result.unmatchedTarget) {
        console.log(`\n  Note: "${name}" in ${to} has no match in ${from} — removed, or needs chiral workflow map?\n`);
      }
    }

    console.log(`  Next: chiral workflow match --from ${from} --to ${to} --smart\n`);
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  if (shouldWrite) {
    writeWorkflowMap(chiralDir, map);

    writeAuditEntry(chiralDir, {
      event_id: crypto.randomUUID(),
      event_schema_version: 1,
      timestamp: new Date().toISOString(),
      actor,
      action: 'map',
      project: config.project,
      source_env: from,
      target_env: to,
      workflow_ids: [],
      result: 'success',
      error: null,
      chiral_version: getChiralVersion(),
      match_method: 'exact',
      match_score: null,
      resource: 'workflow',
    });

    const syncResult = await syncToRemote(
      chiralDir,
      config,
      `chore(chiral): workflow match --from ${from} --to ${to}`,
    );
    if (outputMode === 'human' && !syncResult.skipped && !syncResult.nothingToCommit) {
      if (syncResult.success) {
        console.log(formatSyncSuccess(syncResult));
      } else {
        for (const line of formatSyncFailure(syncResult)) console.log(chalk.yellow(line));
      }
      console.log();
    }
  }

  // ── JSON output ───────────────────────────────────────────────────────────
  if (outputMode === 'json') {
    const candidates = buildMatchCandidates(reserved, result.ambiguous, shouldWrite);
    printJson({
      candidates,
      unmatched_source: result.unmatchedSource,
      unmatched_target: result.unmatchedTarget,
      ...(options.previewDiff
        ? {
            diff_rows_resolved_plus: previewDiffResolved,
            diff_rows_resolved_minus: previewDiffResolved,
          }
        : {}),
    });
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
  Interactive - discover and map unmapped workflows:
    chiral workflow map

  Map with per-environment names:
    chiral workflow map order-processor dev="Order Processor [DEV]" prod="Order Processor"

  Remove stale entries:
    chiral workflow map --prune
`,
  )
  .action(async (args: string[], options: { validate?: boolean; dryRun?: boolean; json?: boolean; prune?: boolean; yes?: boolean }) => {
    await runWorkflowMap(args, options);
  });

const workflowListCmd = new Command('list')
  .description('List all workflow name mappings from workflows.json')
  .option('--env <env>', 'Show only entries that include a mapping for this environment')
  .addOption(new Option('--unmapped', 'Show workflows from the most recent snapshot with no mapping').conflicts('incomplete'))
  .addOption(new Option('--incomplete', 'Show mapped workflows that are missing IDs or env coverage').conflicts('unmapped'))
  .option('--json', 'Emit machine-readable JSON instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  List all mappings:
    chiral workflow list

  Find unmapped workflows:
    chiral workflow list --unmapped

  Find mappings missing IDs or env coverage:
    chiral workflow list --incomplete
`,
  )
  .action(async (options: { env?: string; unmapped?: boolean; incomplete?: boolean; json?: boolean }) => {
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
    chiral workflow unmap order-processor

  Remove only the staging mapping:
    chiral workflow unmap order-processor --env staging
`,
  )
  .action(async (logicalName: string, options: { env?: string }) => {
    await runWorkflowUnmap(logicalName, options);
  });

const workflowMatchCmd = new Command('match')
  .description('Auto-detect workflows that are the same under different names across environments')
  .requiredOption('--from <env>', 'Source environment')
  .requiredOption('--to <env>', 'Target environment')
  .option('--yes', 'Auto-accept exact structure matches (Pass 1 only)')
  .option('--dry-run', 'Compute and print candidates without writing workflows.json')
  .option('--preview-diff', 'Requires --dry-run. Print how many chiral diff +/- rows the mapping would resolve')
  .option('--json', 'Emit machine-readable JSON instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  Find and confirm exact structure matches:
    chiral workflow match --from dev --to prod

  Auto-accept all exact matches:
    chiral workflow match --from dev --to prod --yes

  Preview without writing:
    chiral workflow match --from dev --to prod --dry-run

  Preview how many diff rows a match would resolve:
    chiral workflow match --from dev --to prod --dry-run --preview-diff
`,
  )
  .action(async (options: WorkflowMatchOptions) => {
    await runWorkflowMatch(options);
  });

export const workflowCommand = new Command('workflow')
  .description('Manage workflow name mappings across environments');

workflowCommand.addCommand(workflowMapCmd);
workflowCommand.addCommand(workflowListCmd);
workflowCommand.addCommand(workflowUnmapCmd);
workflowCommand.addCommand(workflowMatchCmd);
