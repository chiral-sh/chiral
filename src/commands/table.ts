import chalk from 'chalk';
import { input, confirm } from '@inquirer/prompts';
import { Command } from 'commander';
import { loadConfigAndDir, findChiralDir } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure } from '../lib/git-sync.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError, ControlledExit } from '../lib/errors.js';
import { getGitActor } from '../lib/git.js';
import { padRight } from '../lib/cli.js';
import { printJson } from '../lib/output.js';
import {
  loadTableMap,
  writeTableMap,
  upsertTableEnvEntry,
  removeTableEnvEntry,
  type TablesMap,
  type TableEntry,
} from '../state/tables.js';
import {
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  listDeployments,
  type SnapshotWorkflow,
} from '../state/snapshots.js';
import { writeAuditEntry } from '../state/audit.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function validateLogicalName(name: string): void {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new UserError(
      `Invalid logical name "${name}" — use lowercase letters, numbers, and hyphens only`,
    );
  }
}

interface ParsedTableArgs {
  logicalName: string | undefined;
  perEnvIds: Record<string, string>;
}

function parseTableMapArgs(args: string[]): ParsedTableArgs {
  const perEnvIds: Record<string, string> = {};
  let logicalName: string | undefined;
  let plainCount = 0;

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
      const env = arg.slice(0, eqIdx);
      const id = arg.slice(eqIdx + 1);
      if (!id) throw new UserError(`Missing ID for env "${env}" — use: ${env}=<id>`);
      perEnvIds[env] = id;
    } else {
      plainCount++;
      if (plainCount === 1) logicalName = arg;
      else throw new UserError(`Unexpected argument "${arg}" — did you mean <env>=<id>?`);
    }
  }

  return { logicalName, perEnvIds };
}

interface FoundTableRef {
  id: string;
  cachedName: string;
  workflows: string[];
}

function extractTableIds(workflows: SnapshotWorkflow[]): Map<string, FoundTableRef> {
  const found = new Map<string, FoundTableRef>();
  for (const wf of workflows) {
    const nodes = (wf as unknown as { nodes?: unknown[] }).nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const n = node as Record<string, unknown>;
      if (n['type'] !== 'n8n-nodes-base.datatable') continue;
      const params = n['parameters'] as Record<string, unknown> | undefined;
      const dtId = params?.['dataTableId'] as Record<string, unknown> | undefined;
      if (!dtId || dtId['__rl'] !== true) continue;
      const id = dtId['value'];
      if (typeof id !== 'string' || !id) continue;
      const cachedName =
        typeof dtId['cachedResultName'] === 'string' ? dtId['cachedResultName'] : '';
      const existing = found.get(id);
      if (existing) {
        if (!existing.workflows.includes(wf.name)) existing.workflows.push(wf.name);
      } else {
        found.set(id, { id, cachedName, workflows: [wf.name] });
      }
    }
  }
  return found;
}

function isTableIdMapped(map: TablesMap, env: string, id: string): boolean {
  return Object.values(map.tables).some((envMap) => envMap[env]?.id === id);
}

// ── table map ─────────────────────────────────────────────────────────────────

export async function runTableMap(
  args: string[],
  options: { validate?: boolean; dryRun?: boolean; json?: boolean },
): Promise<void> {
  const actor = getGitActor();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const map = loadTableMap(chiralDir);

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch {
    // config.json not required for non-interactive non-validate mode
  }

  const { logicalName, perEnvIds } = parseTableMapArgs(args);
  const isNonInteractive = Object.keys(perEnvIds).length > 0;

  if (options.json && !isNonInteractive && !logicalName) {
    throw new UserError(
      '--json requires env=<id> arguments. Example: chiral table map contacts dev=<id> prod=<id>',
    );
  }

  // ── Non-interactive mode (env=id pairs provided) ──────────────────────────
  if (isNonInteractive) {
    if (!logicalName) {
      throw new UserError('Logical name is required in non-interactive mode');
    }

    validateLogicalName(logicalName);

    const envEntries: Record<string, TableEntry> = {};
    for (const [env, id] of Object.entries(perEnvIds)) {
      envEntries[env] = { id, name: logicalName };
    }

    if (options.validate && !configResult) {
      throw new UserError('--validate requires config.json to connect to environments.');
    }

    if (options.validate && configResult) {
      console.log('\n  Validating…');
      const envPad = Math.max(...Object.keys(envEntries).map((e) => e.length)) + 2;
      let hasError = false;
      for (const [env, entry] of Object.entries(envEntries)) {
        const envConfig = configResult.config.environments[env];
        if (!envConfig) {
          console.log(
            `    ${padRight(chalk.yellow(env), envPad)} ${entry.id}    ${chalk.yellow('⚠ env not in config')}`,
          );
          continue;
        }
        const client = new N8nClient(envConfig, env);
        try {
          const tableData = await client.getDataTable(entry.id);
          envEntries[env] = { id: entry.id, name: tableData.name || logicalName };
          console.log(
            `    ${padRight(chalk.cyan(env), envPad)} ${entry.id}    ${chalk.green('✓ found')}  (${tableData.name})`,
          );
        } catch {
          console.log(
            `    ${padRight(chalk.cyan(env), envPad)} ${entry.id}    ${chalk.red('✗ not found in ' + env)}`,
          );
          hasError = true;
        }
      }
      if (hasError) {
        console.log(
          `\n  ${chalk.red('✗')} Cannot save - table ID not found. Check the ID in the n8n Data Tables UI.\n`,
        );
        throw new UserError('Validation failed - aborting without writing.');
      }
    }

    if (options.dryRun) {
      if (options.json) {
        printJson({
          logical_name: logicalName,
          env_entries: envEntries,
          dry_run: true,
        });
      } else {
        console.log('\n  Dry run — would write to tables.json:\n');
        console.log(`    ${chalk.bold(logicalName)}:`);
        for (const [env, entry] of Object.entries(envEntries)) {
          console.log(`      ${chalk.cyan(env)}  → ${entry.id}`);
        }
        console.log('\n  (dry run — nothing written)\n');
      }
      return;
    }

    for (const [env, entry] of Object.entries(envEntries)) {
      upsertTableEnvEntry(map, logicalName, env, entry);
    }
    writeTableMap(chiralDir, map);

    writeAuditEntry(chiralDir, {
      event_id: crypto.randomUUID(),
      event_schema_version: 1,
      timestamp: new Date().toISOString(),
      actor,
      action: 'map',
      project: configResult?.config.project ?? 'unknown',
      source_env: null,
      target_env: Object.keys(envEntries)[0] ?? '',
      workflow_ids: [],
      result: 'success',
      error: null,
      chiral_version: '0.1.0',
      match_method: 'manual',
      match_score: null,
      resource: 'table',
    });

    if (options.json) {
      printJson({ logical_name: logicalName, env_entries: envEntries });
    } else {
      console.log(`\n  ${chalk.green('✓')} Mapped "${chalk.bold(logicalName)}"`);
      const envPad = Math.max(...Object.keys(envEntries).map((e) => e.length)) + 2;
      for (const [env, entry] of Object.entries(envEntries)) {
        console.log(`    ${padRight(chalk.cyan(env), envPad)} → ${entry.id}`);
      }
      console.log();
      console.log(chalk.dim('  Next: chiral push --source dev --target prod --dry-run'));
      console.log();
    }

    const syncResult = await syncToRemote(
      chiralDir,
      configResult?.config ?? ({ version: 1, project: 'unknown', environments: {} } as never),
      `chore(chiral): table map ${logicalName}`,
    );
    if (!syncResult.skipped && !syncResult.nothingToCommit) {
      if (syncResult.success) {
        console.log(formatSyncSuccess(syncResult));
      } else {
        for (const line of formatSyncFailure(syncResult)) console.log(chalk.yellow(line));
      }
      console.log();
    }
    return;
  }

  // ── Interactive mode ───────────────────────────────────────────────────────
  if (!process.stdin.isTTY) {
    throw new UserError(
      'Provide env=<id> arguments for non-interactive use: chiral table map <name> dev=<id> prod=<id>',
    );
  }

  if (!configResult) {
    throw new UserError(
      "Interactive mode requires config.json. Run 'chiral environment add <env>' first.",
    );
  }

  const config = configResult.config;
  const envs = Object.keys(config.environments);

  interface DiscoveredTableId {
    id: string;
    cachedName: string;
    env: string;
    workflows: string[];
  }

  const discovered: DiscoveredTableId[] = [];
  const hasAnySnapshots = listDeployments(chiralDir).length > 0;

  for (const env of envs) {
    const deploymentId = findLatestDeploymentForEnv(chiralDir, env);
    if (!deploymentId) continue;
    const workflows = readAllWorkflowsInDeployment(chiralDir, deploymentId);
    const tableIds = extractTableIds(workflows);
    for (const [id, info] of tableIds) {
      if (!isTableIdMapped(map, env, id)) {
        discovered.push({ id, cachedName: info.cachedName, env, workflows: info.workflows });
      }
    }
  }

  console.log();

  if (!hasAnySnapshots) {
    const firstEnv = envs[0] ?? 'dev';
    const secondEnv = envs[1] ?? 'prod';
    console.log(
      `  No snapshots found — chiral doesn't know what tables exist yet.\n\n` +
        `  ${chalk.dim('Run this first to discover your workflows:')}\n` +
        `    chiral adopt --env ${firstEnv}\n\n` +
        `  ${chalk.dim('Or map a table manually without snapshots:')}\n` +
        `    chiral table map <logical-name> ${firstEnv}=<id> ${secondEnv}=<id>\n`,
    );
    return;
  }

  if (discovered.length === 0) {
    console.log('  All Data Table IDs from snapshots are already mapped.\n');
    return;
  }

  let mappedCount = 0;
  const jsonResults: Array<{ logical_name: string; env_entries: Record<string, TableEntry> }> = [];

  for (const { id: tableId, cachedName, env: sourceEnv, workflows: usedIn } of discovered) {
    if (isTableIdMapped(map, sourceEnv, tableId)) continue;

    console.log(
      `  Unmapped Data Table ID: "${chalk.bold(tableId)}"  ${chalk.dim(`from ${sourceEnv}`)}`,
    );
    if (usedIn.length > 0) {
      console.log(`  ${chalk.dim('Used in: ' + usedIn.join(', '))}`);
    }

    const suggested = logicalName ?? (cachedName || tableId);
    const targetLogical = await input({
      message: '  Logical name (clear to skip):',
      default: suggested,
    });

    if (!targetLogical.trim()) {
      console.log(chalk.dim('  Skipped.\n'));
      continue;
    }

    validateLogicalName(targetLogical.trim());

    const envEntries: Record<string, TableEntry> = {};
    for (const env of envs) {
      const defaultId = env === sourceEnv ? tableId : '';
      const hint = defaultId
        ? chalk.dim(` [${defaultId}]`)
        : chalk.dim(' (Enter to skip)');
      const promptedId = await input({
        message: `  ID in ${chalk.cyan(env)}${hint}:`,
        default: defaultId,
      });
      const finalId = (promptedId.trim() || defaultId).trim();
      if (finalId) {
        const entryName =
          env === sourceEnv && cachedName ? cachedName : targetLogical.trim();
        envEntries[env] = { id: finalId, name: entryName };
      }
    }

    if (Object.keys(envEntries).length === 0) {
      console.log(chalk.dim('  Nothing saved for this table.\n'));
      continue;
    }

    const finalLogical = targetLogical.trim();
    for (const [env, entry] of Object.entries(envEntries)) {
      upsertTableEnvEntry(map, finalLogical, env, entry);
    }
    writeTableMap(chiralDir, map);
    writeAuditEntry(chiralDir, {
      event_id: crypto.randomUUID(),
      event_schema_version: 1,
      timestamp: new Date().toISOString(),
      actor,
      action: 'map',
      project: config.project,
      source_env: null,
      target_env: Object.keys(envEntries)[0] ?? '',
      workflow_ids: [],
      result: 'success',
      error: null,
      chiral_version: '0.1.0',
      match_method: 'manual',
      match_score: null,
      resource: 'table',
    });

    if (options.json) {
      jsonResults.push({ logical_name: finalLogical, env_entries: envEntries });
    } else {
      console.log(`\n  ${chalk.green('✓')} Mapped "${chalk.bold(finalLogical)}"`);
      for (const [env, entry] of Object.entries(envEntries)) {
        console.log(`    ${chalk.cyan(env)} → ${entry.id}`);
      }
      console.log();
    }
    mappedCount++;
  }

  if (options.json && jsonResults.length > 0) {
    printJson(jsonResults.length === 1 ? jsonResults[0] : jsonResults);
  }

  if (mappedCount > 0) {
    const syncResult = await syncToRemote(
      chiralDir,
      config,
      'chore(chiral): table map',
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

// ── table list ────────────────────────────────────────────────────────────────

interface UncoveredTableId {
  env: string;
  id: string;
  workflows: string[];
}

function collectUncovered(
  chiralDir: string,
  map: TablesMap,
  envs: string[],
): UncoveredTableId[] {
  if (listDeployments(chiralDir).length === 0) {
    throw new UserError("No snapshots found. Run 'chiral adopt --env <env>' first.");
  }
  const results: UncoveredTableId[] = [];
  for (const env of envs) {
    const deploymentId = findLatestDeploymentForEnv(chiralDir, env);
    if (!deploymentId) continue;
    const workflows = readAllWorkflowsInDeployment(chiralDir, deploymentId);
    const tableIds = extractTableIds(workflows);
    for (const [id, info] of tableIds) {
      if (!isTableIdMapped(map, env, id)) {
        results.push({ env, id, workflows: info.workflows });
      }
    }
  }
  return results;
}

function renderTableListHuman(
  entries: Array<[string, Record<string, TableEntry>]>,
  envList: string[],
): void {
  if (entries.length === 0) {
    console.log(chalk.dim('\n  No table mappings found.\n'));
    console.log(chalk.dim("  Run 'chiral table map' to map Data Table IDs across environments.\n"));
    return;
  }

  function cellText(entry: TableEntry | undefined): string {
    if (!entry) return '(not set)';
    return `${entry.id}  (${entry.name})`;
  }

  const C_LOGICAL = Math.max('LOGICAL NAME'.length, ...entries.map(([l]) => l.length));
  const C_ENVS = envList.map((env) =>
    Math.max(env.length, ...entries.map(([, m]) => cellText(m[env]).length)),
  );
  const widths = [C_LOGICAL, ...C_ENVS];

  const top = '  ┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const sep = '  ├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '  └' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
  const headerRow =
    '  │ ' +
    [
      padRight(chalk.dim('LOGICAL NAME'), C_LOGICAL),
      ...envList.map((env, i) => padRight(chalk.cyan(env), C_ENVS[i])),
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
      padRight(logicalStr, C_LOGICAL),
      ...envList.map((env, i) => {
        const entry = envMap[env];
        return padRight(entry ? cellText(entry) : chalk.dim('(not set)'), C_ENVS[i]);
      }),
    ];
    console.log('  │ ' + cells.join(' │ ') + ' │');
  }

  console.log(bot);
  console.log();
}

export async function runTableList(
  options: { env?: string; uncovered?: boolean; json?: boolean },
): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const map = loadTableMap(chiralDir);

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch {
    // fall back to deriving env list from tables.json
  }

  let envList: string[];
  if (configResult) {
    envList = Object.keys(configResult.config.environments);
  } else {
    const allEnvs = new Set<string>();
    for (const entry of Object.values(map.tables)) {
      for (const env of Object.keys(entry)) allEnvs.add(env);
    }
    envList = Array.from(allEnvs);
  }

  if (options.env && configResult && !configResult.config.environments[options.env]) {
    const available = Object.keys(configResult.config.environments).join(', ');
    throw new UserError(`Unknown environment "${options.env}". Available: ${available}`);
  }

  // ── --uncovered mode ──────────────────────────────────────────────────────
  if (options.uncovered) {
    const envs = options.env ? [options.env] : envList;
    const results = collectUncovered(chiralDir, map, envs);

    if (options.json) {
      printJson({ uncovered: results });
      return;
    }

    console.log('\n  Unmapped Data Table IDs (found in workflows but not in tables.json):\n');
    if (results.length === 0) {
      console.log('  All Data Table IDs in your workflow snapshots are mapped.\n');
      return;
    }

    const byEnv = new Map<string, UncoveredTableId[]>();
    for (const r of results) {
      const list = byEnv.get(r.env) ?? [];
      list.push(r);
      byEnv.set(r.env, list);
    }
    for (const [env, items] of byEnv) {
      console.log(`  ${chalk.cyan(env)}:`);
      for (const item of items) {
        const wfHint =
          item.workflows.length > 0 ? chalk.dim(`  (${item.workflows.join(', ')})`) : '';
        console.log(`    ${chalk.dim('–')} ${item.id}${wfHint}`);
      }
      console.log();
    }

    const sourceEnv = envList[0] ?? 'dev';
    console.log(
      chalk.dim(`  Run 'chiral table map <logical-name> ${sourceEnv}=<id>' to map them.\n`),
    );
    return;
  }

  // ── Default: mapped table ─────────────────────────────────────────────────
  let entries = Object.entries(map.tables);
  if (options.env) {
    entries = entries.filter(([, envMap]) => options.env! in envMap);
  }

  if (options.json) {
    printJson({ tables: options.env ? Object.fromEntries(entries) : map.tables });
    return;
  }

  renderTableListHuman(entries, envList);
}

// ── table unmap ───────────────────────────────────────────────────────────────

export async function runTableUnmap(
  logicalName: string,
  options: { env?: string; yes?: boolean; json?: boolean },
): Promise<void> {
  const actor = getGitActor();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const map = loadTableMap(chiralDir);

  if (!(logicalName in map.tables)) {
    console.error(`\n  ${chalk.red('✗')}  Table mapping "${logicalName}" not found in tables.json\n`);
    throw new ControlledExit(4);
  }

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch { /* best-effort */ }

  const existingEnvs = Object.keys(map.tables[logicalName] ?? {});

  if (options.env) {
    if (!map.tables[logicalName] || !(options.env in map.tables[logicalName])) {
      throw new UserError(`No mapping for "${logicalName}" in env "${options.env}"`);
    }
    removeTableEnvEntry(map, logicalName, options.env);
    writeTableMap(chiralDir, map);

    writeAuditEntry(chiralDir, {
      event_id: crypto.randomUUID(),
      event_schema_version: 1,
      timestamp: new Date().toISOString(),
      actor,
      action: 'unmap',
      project: configResult?.config.project ?? 'unknown',
      source_env: null,
      target_env: options.env,
      workflow_ids: [],
      result: 'success',
      error: null,
      chiral_version: '0.1.0',
      resource: 'table',
    });

    if (options.json) {
      printJson({ logical_name: logicalName, removed_envs: [options.env] });
    } else {
      console.log(`\n  ${chalk.green('✓')} Removed "${logicalName}" mapping for ${options.env}\n`);
    }
  } else {
    if (existingEnvs.length > 0 && !options.yes) {
      const envList = existingEnvs.join(', ');
      const confirmed = await confirm({
        message: `  Remove all mappings for "${logicalName}" (${envList})?`,
        default: false,
      });
      if (!confirmed) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    removeTableEnvEntry(map, logicalName);
    writeTableMap(chiralDir, map);

    writeAuditEntry(chiralDir, {
      event_id: crypto.randomUUID(),
      event_schema_version: 1,
      timestamp: new Date().toISOString(),
      actor,
      action: 'unmap',
      project: configResult?.config.project ?? 'unknown',
      source_env: null,
      target_env: '',
      workflow_ids: [],
      result: 'success',
      error: null,
      chiral_version: '0.1.0',
      resource: 'table',
    });

    if (options.json) {
      printJson({ logical_name: logicalName, removed_envs: existingEnvs });
    } else {
      console.log(`\n  ${chalk.green('✓')} Removed table mapping "${logicalName}"\n`);
    }
  }

  const syncResult = await syncToRemote(
    chiralDir,
    configResult?.config ?? ({ version: 1, project: 'unknown', environments: {} } as never),
    `chore(chiral): table unmap ${logicalName}`,
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

// ── Commander wiring ──────────────────────────────────────────────────────────

const tableMapCmd = new Command('map')
  .description('Map Data Table IDs across environments in tables.json')
  .argument('[args...]', 'Logical name and env=id pairs')
  .option('--validate', 'Verify table IDs exist in their n8n environments')
  .option('--dry-run', 'Print what would be written without saving')
  .option('--json', 'Emit the mapping entry as JSON instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  Interactive — discover and map unmapped table IDs:
    chiral table map

  Map a specific table non-interactively:
    chiral table map contacts dev=z1HfHUA6tctvw6O8 prod=pQ7rSt2uVwXy8zA9

  Validate that the IDs exist in each environment:
    chiral table map contacts dev=z1HfHUA6tctvw6O8 prod=pQ7rSt2uVwXy8zA9 --validate

  Preview without writing:
    chiral table map contacts dev=z1HfHUA6tctvw6O8 prod=pQ7rSt2uVwXy8zA9 --dry-run
`,
  )
  .action(async (args: string[], options: { validate?: boolean; dryRun?: boolean; json?: boolean }) => {
    await runTableMap(args, options);
  });

const tableListCmd = new Command('list')
  .description('List all Data Table ID mappings from tables.json')
  .option('--env <env>', 'Show only entries that include a mapping for this environment')
  .option('--uncovered', 'Show Data Table IDs found in workflow snapshots but not yet mapped')
  .option('--json', 'Emit machine-readable JSON instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  List all mapped tables:
    chiral table list

  Find table IDs used in workflows but not yet mapped:
    chiral table list --uncovered

  Machine-readable output for scripting:
    chiral table list --json | jq '.data.tables'
`,
  )
  .action(async (options: { env?: string; uncovered?: boolean; json?: boolean }) => {
    await runTableList(options);
  });

const tableUnmapCmd = new Command('unmap')
  .description('Remove a table mapping from tables.json')
  .argument('<logical-name>', 'Logical table name to remove')
  .option('--env <env>', "Remove only this environment's mapping; leaves others intact")
  .option('--yes', 'Skip confirmation prompt for full logical-entry removal')
  .option('--json', 'Emit result as JSON instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  Remove all env mappings for a logical table:
    chiral table unmap contacts --yes

  Remove only the staging mapping (prod mapping preserved):
    chiral table unmap contacts --env staging

  Interactive confirmation before removing all envs:
    chiral table unmap contacts
`,
  )
  .action(async (logicalName: string, options: { env?: string; yes?: boolean; json?: boolean }) => {
    await runTableUnmap(logicalName, options);
  });

export const tableCommand = new Command('table').description(
  'Manage Data Table ID mappings across environments',
);

tableCommand.addCommand(tableMapCmd);
tableCommand.addCommand(tableListCmd);
tableCommand.addCommand(tableUnmapCmd);
