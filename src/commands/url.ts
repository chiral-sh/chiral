import chalk from 'chalk';
import { Command } from 'commander';
import { input, confirm } from '@inquirer/prompts';
import { loadConfigAndDir, findChiralDir } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure } from '../lib/git-sync.js';
import { UserError } from '../lib/errors.js';
import { getGitActor } from '../lib/git.js';
import { padRight, getChiralVersion } from '../lib/cli.js';
import { printJson } from '../lib/output.js';
import {
  loadUrlMap,
  writeUrlMap,
  validateUrlValue,
  extractUrlsFromSnapshots,
  deriveUrlLogicalName,
} from '../state/url-map.js';
import { listDeployments } from '../state/snapshots.js';
import { writeAuditEntry } from '../state/audit.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ParsedUrlMapArgs {
  logicalName: string | undefined;
  perEnvValues: Record<string, string>;
}

function parseUrlMapArgs(
  args: string[],
  flagEnv?: string,
  flagValue?: string,
): ParsedUrlMapArgs {
  const perEnvValues: Record<string, string> = {};
  let logicalName: string | undefined;

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
      perEnvValues[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
    } else {
      if (logicalName !== undefined) {
        throw new UserError(`Unexpected argument "${arg}" — did you mean <env>=<url>?`);
      }
      logicalName = arg;
    }
  }

  const hasPositionalPairs = Object.keys(perEnvValues).length > 0;
  const hasFlagMode = flagEnv !== undefined || flagValue !== undefined;

  if (hasPositionalPairs && hasFlagMode) {
    throw new UserError('Cannot mix positional env=value pairs with --env/--value flags');
  }
  if (flagValue !== undefined && flagEnv === undefined) {
    throw new UserError('--value requires --env <name>');
  }
  if (flagEnv !== undefined && flagValue === undefined) {
    throw new UserError('--env requires --value <url>');
  }
  if (flagEnv !== undefined && flagValue !== undefined) {
    perEnvValues[flagEnv] = flagValue;
  }

  return { logicalName, perEnvValues };
}

// ── url map ───────────────────────────────────────────────────────────────────

export async function runUrlMap(
  args: string[],
  options: { env?: string; value?: string; exact?: boolean; json?: boolean },
): Promise<void> {
  const actor = getGitActor();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const { logicalName, perEnvValues } = parseUrlMapArgs(args, options.env, options.value);
  const isNonInteractive = Object.keys(perEnvValues).length > 0;

  if (!isNonInteractive) {
    // ── Interactive discovery mode ──────────────────────────────────────────────
    let configResult: ReturnType<typeof loadConfigAndDir>;
    try {
      configResult = loadConfigAndDir();
    } catch {
      throw new UserError(
        "Interactive mode requires config.json. Run 'chiral environment add <env>' first.",
      );
    }

    const config = configResult.config;
    const envs = Object.keys(config.environments);
    const urlMapData = loadUrlMap(chiralDir);
    const hasSnapshots = listDeployments(chiralDir).length > 0;
    const allDiscovered = extractUrlsFromSnapshots(chiralDir, envs);

    function isMapped(env: string, urlValue: string): boolean {
      return Object.values(urlMapData.urls).some((entry) => entry.values[env] === urlValue);
    }

    const unmapped = allDiscovered.filter((d) => !isMapped(d.env, d.value));

    if (options.json) {
      printJson({
        candidates: unmapped.map((d) => ({
          value: d.value,
          hostname: d.hostname,
          env: d.env,
          workflow_names: d.workflowNames,
          suggested_key: deriveUrlLogicalName(d.value),
        })),
      });
      return;
    }

    console.log();

    if (unmapped.length === 0) {
      if (!hasSnapshots) {
        const firstEnv = envs[0] ?? 'dev';
        const secondEnv = envs[1] ?? 'prod';
        console.log(
          `  No snapshots found — chiral doesn't know what URLs exist yet.\n\n` +
            `  ${chalk.dim('Run this first to discover your URLs:')}\n` +
            `    chiral adopt --env ${firstEnv}\n\n` +
            `  ${chalk.dim('Or map a URL manually without snapshots:')}\n` +
            `    chiral url map <logical> ${firstEnv}=<url> ${secondEnv}=<url>\n`,
        );
      } else {
        console.log('  All URLs in your snapshots are mapped.\n');
      }
      return;
    }

    // Summary of discovered unmapped URLs grouped by env
    const byEnv = new Map<string, typeof unmapped>();
    for (const d of unmapped) {
      const list = byEnv.get(d.env) ?? [];
      list.push(d);
      byEnv.set(d.env, list);
    }
    for (const [env, urls] of byEnv) {
      console.log(
        `  Found ${urls.length} unmapped URL${urls.length !== 1 ? 's' : ''} in your ${chalk.cyan(env)} workflows:\n`,
      );
      for (const u of urls) {
        const wfList = u.workflowNames.slice(0, 2).join(', ');
        const extra = u.workflowNames.length > 2 ? `, +${u.workflowNames.length - 2} more` : '';
        const wfCount = u.workflowNames.length;
        const wfLabel = `used in ${wfCount} workflow${wfCount !== 1 ? 's' : ''}`;
        console.log(
          `    ${padRight(chalk.bold(u.value), 50)} ${chalk.dim(`${wfLabel}  (${wfList}${extra})`)}`,
        );
      }
      console.log();
    }

    let mappedCount = 0;
    const processed = new Set<string>();

    for (const discovered of unmapped) {
      const key = `${discovered.env}::${discovered.value}`;
      if (processed.has(key)) continue;
      if (isMapped(discovered.env, discovered.value)) {
        processed.add(key);
        continue;
      }

      console.log(
        `  Mapping "${chalk.bold(discovered.value)}"  ${chalk.dim(`from ${discovered.env}`)}`,
      );

      const suggested = deriveUrlLogicalName(discovered.value);
      const rawLogical = (
        await input({ message: `  Logical name [${suggested}]:`, default: suggested })
      ).trim();
      const targetLogical = rawLogical || suggested;

      const envValues: Record<string, string> = {};

      for (const env of envs) {
        if (env === discovered.env) {
          const hint = chalk.dim(`  [${discovered.value}]`);
          const answer = await input({
            message: `  URL in ${chalk.cyan(env)}${hint}:`,
            default: discovered.value,
          });
          const value = answer.trim() || discovered.value;
          if (value) {
            try {
              validateUrlValue(value);
              envValues[env] = value;
            } catch (err) {
              if (err instanceof UserError) {
                console.log(chalk.yellow(`  ⚠ ${err.message} — skipping ${env}`));
              } else throw err;
            }
          }
        } else {
          const answer = await input({
            message: `  URL in ${chalk.cyan(env)}${chalk.dim('  (Enter to skip)')}:`,
            default: '',
          });
          const value = answer.trim();
          if (value) {
            try {
              validateUrlValue(value);
              envValues[env] = value;
            } catch (err) {
              if (err instanceof UserError) {
                console.log(chalk.yellow(`  ⚠ ${err.message} — skipping ${env}`));
              } else throw err;
            }
          }
        }
      }

      if (Object.keys(envValues).length === 0) {
        console.log(chalk.dim('  Skipped.\n'));
        processed.add(key);
        continue;
      }

      // Upsert immediately (atomicity — partial progress preserved on Ctrl+C)
      if (!urlMapData.urls[targetLogical]) urlMapData.urls[targetLogical] = { values: {} };
      Object.assign(urlMapData.urls[targetLogical].values, envValues);
      writeUrlMap(chiralDir, urlMapData);

      writeAuditEntry(chiralDir, {
        event_id: crypto.randomUUID(),
        event_schema_version: 1,
        timestamp: new Date().toISOString(),
        actor,
        action: 'map',
        project: config.project,
        source_env: null,
        target_env: Object.keys(envValues)[0] ?? '',
        workflow_ids: [],
        result: 'success',
        error: null,
        chiral_version: getChiralVersion(),
        match_method: 'manual',
        match_score: null,
      });

      console.log(`\n  ${chalk.green('✓')} Saved "${chalk.bold(targetLogical)}"`);
      const envPad = Math.max(...Object.keys(envValues).map((e) => e.length)) + 2;
      for (const env of envs) {
        const url = envValues[env];
        if (url) {
          console.log(`    ${padRight(chalk.cyan(env), envPad)} → ${url}`);
        } else {
          console.log(`    ${padRight(chalk.cyan(env), envPad)} → ${chalk.dim('(not set)')}`);
        }
      }
      console.log();

      mappedCount++;
      processed.add(key);
    }

    if (mappedCount > 0) {
      const syncResult = await syncToRemote(
        chiralDir,
        config,
        `chore(chiral): url map`,
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

  if (!logicalName) {
    throw new UserError('Logical name is required: chiral url map <logical> <env>=<url> ...');
  }

  // Validate all values before any write
  for (const value of Object.values(perEnvValues)) {
    validateUrlValue(value);
  }

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch {
    // config.json not required for non-interactive
  }

  // Warn on envs absent from config (but still write)
  if (configResult) {
    for (const env of Object.keys(perEnvValues)) {
      if (!(env in configResult.config.environments)) {
        console.log(chalk.yellow(`  ⚠ "${env}" is not in config.json — written anyway.`));
      }
    }
  }

  const urlMap = loadUrlMap(chiralDir);
  if (!urlMap.urls[logicalName]) {
    urlMap.urls[logicalName] = { values: {} };
  }
  Object.assign(urlMap.urls[logicalName].values, perEnvValues);
  if (options.exact) {
    urlMap.urls[logicalName].exact = true;
  }
  writeUrlMap(chiralDir, urlMap);

  writeAuditEntry(chiralDir, {
    event_id: crypto.randomUUID(),
    event_schema_version: 1,
    timestamp: new Date().toISOString(),
    actor,
    action: 'map',
    project: configResult?.config.project ?? 'unknown',
    source_env: null,
    target_env: Object.keys(perEnvValues)[0] ?? '',
    workflow_ids: [],
    result: 'success',
    error: null,
    chiral_version: getChiralVersion(),
    match_method: 'manual',
    match_score: null,
  });

  const entry = urlMap.urls[logicalName];
  if (options.json) {
    printJson({
      logical_name: logicalName,
      values: entry.values,
      exact: entry.exact ?? false,
    });
  } else {
    console.log(`\n  ${chalk.green('✓')} Saved "${chalk.bold(logicalName)}"`);
    const envPad = Math.max(...Object.keys(perEnvValues).map((e) => e.length)) + 2;
    for (const [env, url] of Object.entries(perEnvValues)) {
      console.log(`    ${padRight(chalk.cyan(env), envPad)} → ${url}`);
    }
    if (options.exact) {
      console.log(chalk.dim('    (exact match — full URL must match)'));
    }
    console.log();
  }

  const syncResult = await syncToRemote(
    chiralDir,
    configResult?.config ?? ({ version: 1, project: 'unknown', environments: {} } as never),
    `chore(chiral): url map ${logicalName}`,
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

// ── url list ──────────────────────────────────────────────────────────────────

export async function runUrlList(options: { env?: string; json?: boolean }): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const urlMapData = loadUrlMap(chiralDir);

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch {
    // fall back to env names derived from url-map.json
  }

  // Build env list: prefer config order, fall back to union of all envs in url-map.json
  let envList: string[];
  if (configResult) {
    envList = Object.keys(configResult.config.environments);
  } else {
    const allEnvs = new Set<string>();
    for (const entry of Object.values(urlMapData.urls)) {
      for (const env of Object.keys(entry.values)) allEnvs.add(env);
    }
    envList = Array.from(allEnvs);
  }

  // Validate --env against config
  if (options.env) {
    if (configResult && !(options.env in configResult.config.environments)) {
      const available = Object.keys(configResult.config.environments).join(', ');
      throw new UserError(`Unknown environment "${options.env}". Available: ${available}`);
    }
  }

  let entries = Object.entries(urlMapData.urls);
  if (options.env) {
    entries = entries.filter(([, entry]) => options.env! in entry.values);
  }

  if (options.json) {
    printJson({ urls: Object.fromEntries(entries) });
    return;
  }

  if (entries.length === 0) {
    console.log(chalk.dim('\n  No URL mappings registered. Run chiral url map to add one.\n'));
    return;
  }

  const C_LOGICAL = Math.max('LOGICAL NAME'.length, ...entries.map(([l]) => l.length));
  const C_ENVS = envList.map((env) =>
    Math.max(env.length, ...entries.map(([, e]) => (e.values[env] ?? '(not set)').length)),
  );
  const widths = [C_LOGICAL, ...C_ENVS];
  const pad = padRight;

  const top = '  ┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const sep = '  ├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '  └' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
  const headerRow =
    '  │ ' +
    [
      pad(chalk.dim('LOGICAL NAME'), C_LOGICAL),
      ...envList.map((env, i) => pad(chalk.cyan(env), C_ENVS[i])),
    ].join(' │ ') +
    ' │';

  console.log();
  console.log(top);
  console.log(headerRow);
  console.log(sep);

  for (const [logical, entry] of entries) {
    const hasGap = envList.some((env) => !(env in entry.values));
    const logicalStr = hasGap ? chalk.yellow(logical) : logical;
    const cells = [
      pad(logicalStr, C_LOGICAL),
      ...envList.map((env, i) => {
        const url = entry.values[env];
        return pad(url ?? chalk.dim('(not set)'), C_ENVS[i]);
      }),
    ];
    console.log('  │ ' + cells.join(' │ ') + ' │');
  }

  console.log(bot);
  console.log();
}

// ── url unmap ─────────────────────────────────────────────────────────────────

export async function runUrlUnmap(
  logicalName: string,
  options: { env?: string; yes?: boolean; json?: boolean },
): Promise<void> {
  const actor = getGitActor();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const urlMapData = loadUrlMap(chiralDir);

  if (!(logicalName in urlMapData.urls)) {
    throw new UserError(
      `URL mapping "${logicalName}" not found. Run 'chiral url list' to see registered mappings.`,
    );
  }

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch { /* best-effort */ }

  const entry = urlMapData.urls[logicalName];
  const existingEnvs = Object.keys(entry.values);

  if (options.env) {
    if (!(options.env in entry.values)) {
      throw new UserError(
        `No mapping for "${logicalName}" in env "${options.env}". Run 'chiral url list' to see registered mappings.`,
      );
    }
    delete entry.values[options.env];
    // Prune empty parent entry
    if (Object.keys(entry.values).length === 0) {
      delete urlMapData.urls[logicalName];
    }
    writeUrlMap(chiralDir, urlMapData);

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
      chiral_version: getChiralVersion(),
      match_method: 'manual',
      match_score: null,
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

    delete urlMapData.urls[logicalName];
    writeUrlMap(chiralDir, urlMapData);

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
      chiral_version: getChiralVersion(),
      match_method: 'manual',
      match_score: null,
    });

    if (options.json) {
      printJson({ logical_name: logicalName, removed_envs: existingEnvs });
    } else {
      console.log(`\n  ${chalk.green('✓')} Removed URL mapping "${logicalName}"\n`);
    }
  }

  const syncResult = await syncToRemote(
    chiralDir,
    configResult?.config ?? ({ version: 1, project: 'unknown', environments: {} } as never),
    `chore(chiral): url unmap ${logicalName}`,
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

const urlMapCmd = new Command('map')
  .description('Register or update URL mappings in url-map.json')
  .argument('[args...]', 'Logical name and env=url pairs')
  .option('--env <name>', 'Environment name (use with --value for a single env)')
  .option('--value <url>', 'URL value for --env (use with --env)')
  .option('--exact', 'Match the full URL string instead of scheme+host prefix')
  .option('--json', 'Emit result as JSON instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  Map URL for two environments:
    chiral url map api_base dev=https://api.dev.example.com prod=https://api.example.com

  Map a single env via flags:
    chiral url map api_base --env dev --value https://api.dev.example.com

  Exact full-URL matching (opt-in):
    chiral url map webhook dev=https://hooks.dev.example.com/path --exact
`,
  )
  .action(
    async (
      args: string[],
      options: { env?: string; value?: string; exact?: boolean; json?: boolean },
    ) => {
      await runUrlMap(args, options);
    },
  );

const urlListCmd = new Command('list')
  .description('List all URL mappings')
  .option('--env <env>', 'Filter to entries that include this environment')
  .option('--json', 'Emit result as JSON instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  List all URL mappings:
    chiral url list

  Filter to prod entries:
    chiral url list --env prod

  Machine-readable output:
    chiral url list --json
`,
  )
  .action(async (options: { env?: string; json?: boolean }) => {
    await runUrlList(options);
  });

const urlUnmapCmd = new Command('unmap')
  .description('Remove a URL mapping entry or a single env from an entry')
  .argument('<logical>', 'Logical name of the URL mapping to remove')
  .option('--env <env>', 'Remove only this environment from the entry')
  .option('--yes', 'Skip confirmation prompt for full entry removal')
  .option('--json', 'Emit result as JSON instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  Remove all env mappings for a logical name:
    chiral url unmap api_base

  Remove only the prod mapping (leave other envs):
    chiral url unmap api_base --env prod

  Skip confirmation in CI:
    chiral url unmap api_base --yes
`,
  )
  .action(async (logicalName: string, options: { env?: string; yes?: boolean; json?: boolean }) => {
    await runUrlUnmap(logicalName, options);
  });

export const urlCommand = new Command('url').description(
  'Manage URL mappings across environments',
);

urlCommand.addCommand(urlMapCmd);
urlCommand.addCommand(urlListCmd);
urlCommand.addCommand(urlUnmapCmd);
