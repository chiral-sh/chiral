import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { input, confirm, search } from '@inquirer/prompts';
import { Command, Option } from 'commander';
import { loadConfigAndDir, findChiralDir } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure, logSyncError } from '../lib/git-sync.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError } from '../lib/errors.js';
import {
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
      'git config user.email is not set - configure it before running chiral',
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
function lookupSnapshotId(chiralDir: string, env: string, name: string): string | undefined {
  const dId = findLatestDeploymentForEnv(chiralDir, env);
  if (!dId) return undefined;
  return readAllWorkflowsInDeployment(chiralDir, dId).find((w) => w.name === name)?.id;
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
          const skip = { value: null as null, name: chalk.dim('─ skip this env ─') };
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
        console.log(`\n  ${chalk.red('✗')} Cannot save - 1 workflow not found. Create it first, or check the name.\n`);
        throw new UserError('Validation failed - aborting without writing.');
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
      chiral_version: '0.1.0',
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
      chiralDir,
      configResult?.config ?? { version: 1, project: 'unknown', environments: {} } as never,
      `chore(chiral): workflow map ${logicalName}`,
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
    const workflows = readAllWorkflowsInDeployment(chiralDir, deploymentId);
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
      `    chiral adopt --env ${firstEnv}\n\n` +
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
        writeWorkflowMap(chiralDir, map);
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
          chiral_version: '0.1.0',
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
      console.log(JSON.stringify(jsonResults.length === 1 ? jsonResults[0] : jsonResults, null, 2));
    }
  }

  if (mappedCount > 0 && !options.dryRun) {
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
        if (syncResult.message) logSyncError(syncResult.message);
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

  for (const [logical, envMap] of Object.entries(map.workflows)) {
    for (const [env, entry] of Object.entries(envMap)) {
      const deploymentId = findLatestDeploymentForEnv(chiralDir, env);
      if (!deploymentId) continue;
      const workflows = readAllWorkflowsInDeployment(chiralDir, deploymentId);
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
      delete map.workflows[logical]![env];
      if (Object.keys(map.workflows[logical] ?? {}).length === 0) {
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
        chiral_version: '0.1.0',
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
    throw new UserError("No snapshots found. Run 'chiral adopt --env <env>' first.");
  }
  const results: UnmappedResult[] = [];
  for (const env of envs) {
    const deploymentId = findLatestDeploymentForEnv(chiralDir, env);
    if (!deploymentId) continue;
    const workflows = readAllWorkflowsInDeployment(chiralDir, deploymentId);
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

  // Compute column widths using ANSI-stripped lengths
  const C_LOGICAL = Math.max(
    'LOGICAL NAME'.length,
    ...entries.map(([l]) => l.length),
  );
  const C_ENVS = envList.map((env) =>
    Math.max(env.length, ...entries.map(([, m]) => (m[env]?.name ?? '(not set)').length)),
  );
  const widths = [C_LOGICAL, ...C_ENVS];
  const pad = (s: string, w: number) =>
    s + ' '.repeat(Math.max(0, w - visibleLen(s)));

  const top = '  ┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const sep = '  ├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '  └' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
  const headerRow =
    '  │ ' +
    [
      pad(chalk.dim('LOGICAL NAME'), C_LOGICAL),
      ...envList.map((env, i) => pad(chalk.cyan(env), C_ENVS[i]!)),
    ].join(' │ ') +
    ' │';

  console.log();
  console.log(top);
  console.log(headerRow);
  console.log(sep);

  for (const [logical, envMap] of entries) {
    const hasGap = envList.some((env) => !(env in envMap));
    const logicalStr = hasGap ? chalk.yellow(logical) : logical;
    const cells = [
      pad(logicalStr, C_LOGICAL),
      ...envList.map((env, i) => {
        const name = envMap[env]?.name;
        return pad(name ?? chalk.dim('(not set)'), C_ENVS[i]!);
      }),
    ];
    console.log('  │ ' + cells.join(' │ ') + ' │');
  }

  console.log(bot);
  console.log();
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
      `  Run 'chiral workflow match --source ${sourceEnv} --target ${targetEnv}' to auto-detect matches.\n` +
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
      console.log(JSON.stringify(results, null, 2));
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
      console.log(JSON.stringify(results, null, 2));
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
      // Filtered blob when --env is combined with --json
      console.log(
        JSON.stringify({ version: map.version, workflows: Object.fromEntries(entries) }, null, 2),
      );
    } else {
      // Raw blob - backward compat
      console.log(JSON.stringify(map, null, 2));
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
    chiral_version: '0.1.0',
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
    chiralDir,
    configResult?.config ?? { version: 1, project: 'unknown', environments: {} } as never,
    `chore(chiral): workflow unmap ${logicalName}`,
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
  Interactive - discover and map unmapped workflows:
    chiral workflow map

  Map with per-environment names:
    chiral workflow map order-processor dev="Order Processor [DEV]" prod="Order Processor"

  Remove stale entries:
    chiral workflow map --prune
`,
  )
  .action(async (args: string[], options) => {
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
    chiral workflow unmap order-processor

  Remove only the staging mapping:
    chiral workflow unmap order-processor --env staging
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
