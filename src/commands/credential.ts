import chalk from 'chalk';
import { input } from '@inquirer/prompts';
import { Command } from 'commander';
import { loadConfigAndDir, findChiralDir } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure} from '../lib/git-sync.js';
import { UserError } from '../lib/errors.js';
import { getGitActor } from '../lib/git.js';
import { padRight, getChiralVersion, normalizedSimilarity, renderBoxTable } from '../lib/cli.js';
import { printJson } from '../lib/output.js';
import {
  loadCredentials,
  writeCredentials,
  deriveCredentialLogicalName,
  extractCredentialsFromSnapshots,
} from '../state/credentials.js';
import {
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  listDeployments,
} from '../state/snapshots.js';
import { writeAuditEntry } from '../state/audit.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ParsedCredentialMapArgs {
  logicalName: string | undefined;
  uniformName: string | undefined;
  perEnvNames: Record<string, string>;
}

function parseCredentialMapArgs(args: string[]): ParsedCredentialMapArgs {
  const perEnvNames: Record<string, string> = {};
  let logicalName: string | undefined;
  let uniformName: string | undefined;
  let plainCount = 0;

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
      perEnvNames[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
    } else if (eqIdx === 0) {
      throw new UserError(`Invalid argument "${arg}" - env=name format requires a non-empty env name before "="`);
    } else {
      plainCount++;
      if (plainCount === 1) logicalName = arg;
      else if (plainCount === 2) uniformName = arg;
      else throw new UserError(`Unexpected argument "${arg}" - did you mean <env>=<name>?`);
    }
  }

  return { logicalName, uniformName, perEnvNames };
}

/**
 * Exact cross-env auto-fill: given a source credential name, try to find a matching
 * credential in the target env's snapshot using deterministic pattern matching.
 */
function buildExactCrossEnvFill(
  sourceName: string,
  targetEnv: string,
  envCredentials: Map<string, string[]>,
  configuredEnvNames: string[],
): string | null {
  const base = deriveCredentialLogicalName(sourceName, configuredEnvNames);
  const candidates = envCredentials.get(targetEnv) ?? [];
  const envLower = targetEnv.toLowerCase();
  const baseLower = base.toLowerCase();

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower === `${envLower}_${baseLower}`) return candidate;
    if (lower === `${baseLower}_${envLower}`) return candidate;
    if (lower === baseLower) return candidate;
  }
  return null;
}


/**
 * Fuzzy cross-env fill using normalized edit distance.  Returns best candidate with
 * similarity >= 0.65, or null if no candidate meets the threshold.
 */
function buildSmartCrossEnvFill(
  sourceName: string,
  targetEnv: string,
  envCredentials: Map<string, string[]>,
  configuredEnvNames: string[],
): { name: string; score: number } | null {
  const base = deriveCredentialLogicalName(sourceName, configuredEnvNames);
  const candidates = envCredentials.get(targetEnv) ?? [];

  let best: { name: string; score: number } | null = null;
  for (const candidate of candidates) {
    const candidateBase = deriveCredentialLogicalName(candidate, configuredEnvNames);
    const score = normalizedSimilarity(base.toLowerCase(), candidateBase.toLowerCase());
    if (score >= 0.65 && (!best || score > best.score)) {
      best = { name: candidate, score };
    }
  }
  return best;
}

// ── Coverage summary ──────────────────────────────────────────────────────────

interface CoverageSummary {
  coveredWorkflows: number;
  totalWorkflows: number;
}

function computeCoverageSummary(
  chiralDir: string,
  envs: string[],
  credentials: ReturnType<typeof loadCredentials>,
): CoverageSummary {
  let covered = 0;
  let total = 0;

  for (const env of envs) {
    let deploymentId: string | undefined;
    try {
      deploymentId = findLatestDeploymentForEnv(chiralDir, env);
    } catch {
      continue;
    }
    if (!deploymentId) continue;

    let workflows: ReturnType<typeof readAllWorkflowsInDeployment>['workflows'];
    try {
      workflows = readAllWorkflowsInDeployment(chiralDir, deploymentId).workflows;
    } catch {
      continue;
    }

    for (const workflow of workflows) {
      const nodes = (workflow as Record<string, unknown>)['nodes'];
      if (!Array.isArray(nodes)) continue;

      // Collect all credential names in this workflow
      const credNames: string[] = [];
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue;
        const nodeObj = node as Record<string, unknown>;
        const creds = nodeObj['credentials'];
        if (typeof creds !== 'object' || creds === null) continue;
        for (const credValue of Object.values(creds as Record<string, unknown>)) {
          if (typeof credValue !== 'object' || credValue === null) continue;
          const cv = credValue as Record<string, unknown>;
          const name = cv['name'];
          if (typeof name === 'string') credNames.push(name);
        }
      }

      total++;
      if (credNames.length === 0) {
        covered++;
        continue;
      }
      const allResolved = credNames.every((name) =>
        Object.values(credentials.credentials).some((envMap) => envMap[env] === name),
      );
      if (allResolved) covered++;
    }
  }

  return { coveredWorkflows: covered, totalWorkflows: total };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMapped(
  credentials: ReturnType<typeof loadCredentials>,
  env: string,
  name: string,
): boolean {
  return Object.values(credentials.credentials).some((envMap) => envMap[env] === name);
}

// ── credential map ────────────────────────────────────────────────────────────

export async function runCredentialMap(
  args: string[],
  options: { smart?: boolean; dryRun?: boolean; json?: boolean },
): Promise<void> {
  const actor = getGitActor();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const credentials = loadCredentials(chiralDir);
  const { logicalName, uniformName, perEnvNames } = parseCredentialMapArgs(args);
  const isNonInteractive = uniformName !== undefined || Object.keys(perEnvNames).length > 0;

  // Load config once (best-effort) for --smart check and non-interactive env resolution
  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch { /* config not required in non-interactive mode */ }

  // ── --smart license check ──────────────────────────────────────────────────
  if (options.smart && !configResult?.config.licenseKey) {
    throw new UserError(
      '--smart requires a paid license. Add licenseKey to config.json.',
    );
  }

  // ── Non-interactive modes (3 & 4) ─────────────────────────────────────────
  if (isNonInteractive) {
    if (!logicalName) {
      throw new UserError('Logical name is required in non-interactive mode');
    }

    const envList = configResult ? Object.keys(configResult.config.environments) : [];
    const envMap: Record<string, string> = { ...perEnvNames };

    // Apply uniform name to all configured envs that don't already have a per-env override
    if (uniformName !== undefined) {
      for (const env of (envList.length > 0 ? envList : Object.keys(perEnvNames))) {
        if (!(env in envMap)) envMap[env] = uniformName;
      }
    }

    if (Object.keys(envMap).length === 0) {
      throw new UserError(
        'No environments resolved. Specify env=name pairs or ensure config.json is present.',
      );
    }

    // Warn about unknown envs
    if (configResult) {
      for (const env of Object.keys(envMap)) {
        if (!(env in configResult.config.environments)) {
          console.error(chalk.yellow(`  ⚠ "${env}" is not in config.json - written anyway.`));
        }
      }
    }

    if (options.dryRun) {
      if (options.json) {
        printJson({ logical_name: logicalName, env_names: envMap, dry_run: true });
      } else {
        console.log('\n  Dry run - would write:');
        console.log(`    ${chalk.bold(logicalName)}`);
        for (const [env, name] of Object.entries(envMap)) {
          console.log(`      ${chalk.cyan(env)} → ${name}`);
        }
        console.log();
      }
      return;
    }

    // Upsert into credentials.json
    if (!credentials.credentials[logicalName]) credentials.credentials[logicalName] = {};
    Object.assign(credentials.credentials[logicalName], envMap);
    writeCredentials(chiralDir, credentials);

    writeAuditEntry(chiralDir, {
      event_id: crypto.randomUUID(),
      event_schema_version: 1,
      timestamp: new Date().toISOString(),
      actor,
      action: 'map',
      project: configResult?.config.project ?? 'unknown',
      source_env: null,
      target_env: Object.keys(envMap)[0] ?? '',
      workflow_ids: [],
      result: 'success',
      error: null,
      chiral_version: getChiralVersion(),
      match_method: 'manual',
      match_score: null,
    });

    if (options.json) {
      printJson({ logical_name: logicalName, env_names: envMap });
    } else {
      console.log(`\n  ${chalk.green('✓')} Saved "${chalk.bold(logicalName)}"`);
      const envPad = Math.max(...Object.keys(envMap).map((e) => e.length)) + 2;
      for (const [env, name] of Object.entries(envMap)) {
        console.log(`    ${padRight(chalk.cyan(env), envPad)} → ${name}`);
      }
      console.log();
    }

    const syncResult = await syncToRemote(
      chiralDir,
      configResult?.config ?? { version: 1, project: 'unknown', environments: {} } as never,
      `chore(chiral): credential map ${logicalName}`,
    );
    if (!syncResult.skipped && !syncResult.nothingToCommit) {
      if (syncResult.success) {
        console.log(formatSyncSuccess(syncResult));
      } else {
        for (const line of formatSyncFailure(syncResult)) console.error(chalk.yellow(line));
      }
      console.log();
    }
    return;
  }

  // ── Interactive modes (1 & 2) ──────────────────────────────────────────────
  if (!configResult) {
    throw new UserError(
      "Interactive mode requires config.json. Run 'chiral environment add <env>' first.",
    );
  }

  const config = configResult.config;
  const envs = Object.keys(config.environments);
  const configuredEnvNames = envs;

  // Discover credentials from snapshots
  const allDiscovered = extractCredentialsFromSnapshots(chiralDir, envs);
  const hasSnapshots = listDeployments(chiralDir).length > 0;

  // Build unmapped list (filter to just the named one if mode 2)
  let unmapped = allDiscovered.filter((d) => !isMapped(credentials, d.env, d.name));
  if (logicalName !== undefined) {
    unmapped = unmapped.filter(
      (d) => d.name === logicalName || deriveCredentialLogicalName(d.name, configuredEnvNames) === logicalName,
    );
  }

  // Build per-env credential lists for auto-fill
  const envCredentials = new Map<string, string[]>();
  for (const env of envs) {
    envCredentials.set(env, allDiscovered.filter((d) => d.env === env).map((d) => d.name));
  }

  if (!options.json) console.log();

  if (unmapped.length === 0 && !hasSnapshots) {
    const firstEnv = envs[0] ?? 'dev';
    const secondEnv = envs[1] ?? 'prod';
    console.log(
      `  No snapshots found - chiral doesn't know what credentials exist yet.\n\n` +
      `  ${chalk.dim('Run this first to discover your credentials:')}\n` +
      `    chiral adopt ${firstEnv}\n\n` +
      `  ${chalk.dim('Or map a credential manually without snapshots:')}\n` +
      `    chiral credential map <logical-name> ${firstEnv}="<name in ${firstEnv}>" ${secondEnv}="<name in ${secondEnv}>"\n`,
    );
    return;
  }

  if (unmapped.length === 0) {
    if (!options.json) {
      console.log('  All credentials in your snapshots are mapped.\n');
    }
    return;
  }

  // Group by source env for display summary
  if (!options.json) {
    const byEnv = new Map<string, typeof unmapped>();
    for (const d of unmapped) {
      const list = byEnv.get(d.env) ?? [];
      list.push(d);
      byEnv.set(d.env, list);
    }
    for (const [env, creds] of byEnv) {
      const namePad = Math.max(...creds.map((c) => c.name.length));
      console.log(`  Found ${creds.length} unmapped credential${creds.length !== 1 ? 's' : ''} in your ${chalk.cyan(env)} workflows:\n`);
      for (const c of creds) {
        const wfList = c.workflowNames.slice(0, 2).join(', ');
        const extra = c.workflowNames.length > 2 ? `, +${c.workflowNames.length - 2} more` : '';
        const wfCount = c.workflowNames.length;
        const wfLabel = `used in ${wfCount} workflow${wfCount !== 1 ? 's' : ''}`;
        console.log(`    ${padRight(chalk.bold(c.name), namePad)} ${chalk.dim(`${wfLabel}  (${wfList}${extra})`)}`);
      }
      console.log();
    }
  }

  const jsonResults: Array<{ logical_name: string; env_names: Record<string, string> }> = [];
  let mappedCount = 0;

  // Deduplicate: process each unique (sourceEnv, name) once
  const processed = new Set<string>();

  for (const discovered of unmapped) {
    const key = `${discovered.env}::${discovered.name}`;
    if (processed.has(key)) continue;

    // Re-check: may have been covered by a previous iteration's upsert
    if (isMapped(credentials, discovered.env, discovered.name)) {
      processed.add(key);
      continue;
    }

    if (!options.json) {
      console.log(`  Mapping "${chalk.bold(discovered.name)}"  ${chalk.dim(`from ${discovered.env}`)}`);
    }

    // Suggest logical name
    const suggested = deriveCredentialLogicalName(discovered.name, configuredEnvNames);
    const rawLogical = logicalName ?? (await input({
      message: `  Logical name [${suggested}]:`,
      default: suggested,
    })).trim();
    const targetLogical = rawLogical || suggested;

    // Build env names: source env pre-filled, others via auto-fill
    const envNames: Record<string, string> = {};

    for (const env of envs) {
      if (env === discovered.env) {
        // Source env: pre-fill with the discovered name
        const hint = chalk.dim(`  [${discovered.name}]`);
        const answer = await input({
          message: `  Name in ${chalk.cyan(env)}${hint}:`,
          default: discovered.name,
        });
        const value = answer.trim() || discovered.name;
        if (value) envNames[env] = value;
      } else {
        // Other envs: try exact cross-env auto-fill first
        const exactFill = buildExactCrossEnvFill(
          discovered.name,
          env,
          envCredentials,
          configuredEnvNames,
        );

        let defaultValue: string | undefined;
        let badge = '';

        if (exactFill) {
          defaultValue = exactFill;
          badge = chalk.dim('  ← auto-detected');
        } else if (options.smart) {
          // Fuzzy fill for non-standard patterns
          const fuzzyFill = buildSmartCrossEnvFill(
            discovered.name,
            env,
            envCredentials,
            configuredEnvNames,
          );
          if (fuzzyFill) {
            defaultValue = fuzzyFill.name;
            const pct = Math.round(fuzzyFill.score * 100);
            badge = chalk.dim(`  ← ${pct}% match (fuzzy)`);
          }
        }

        if (defaultValue) {
          const answer = await input({
            message: `  Name in ${chalk.cyan(env)}${badge}:`,
            default: defaultValue,
          });
          const value = answer.trim() || defaultValue;
          if (value) envNames[env] = value;
        } else {
          const answer = await input({
            message: `  Name in ${chalk.cyan(env)}${chalk.dim('  (not set, Enter to skip)')}:`,
            default: '',
          });
          const value = answer.trim();
          if (value) envNames[env] = value;
        }
      }
    }

    if (Object.keys(envNames).length === 0) {
      if (!options.json) console.log(chalk.dim('  Skipped.\n'));
      processed.add(key);
      continue;
    }

    if (!options.dryRun) {
      // Upsert immediately (atomicity)
      if (!credentials.credentials[targetLogical]) credentials.credentials[targetLogical] = {};
      Object.assign(credentials.credentials[targetLogical], envNames);
      writeCredentials(chiralDir, credentials);

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
        match_method: options.smart ? 'fuzzy' : 'manual',
        match_score: null,
      });
    }

    if (options.json) {
      jsonResults.push({ logical_name: targetLogical, env_names: envNames });
    } else {
      console.log(`\n  ${chalk.green('✓')} Saved "${chalk.bold(targetLogical)}"`);
      const envPad = Math.max(...Object.keys(envNames).map((e) => e.length)) + 2;
      for (const env of envs) {
        const name = envNames[env];
        if (name) {
          console.log(`    ${padRight(chalk.cyan(env), envPad)} → ${name}`);
        } else {
          console.log(`    ${padRight(chalk.cyan(env), envPad)} → ${chalk.dim('(not set)')}`);
        }
      }
      const missingEnvs = envs.filter((e) => !envNames[e]);
      if (missingEnvs.length > 0) {
        console.log(
          chalk.dim(
            `\n  Note: no mapping set for ${missingEnvs.join(', ')} - add it before pushing to ${missingEnvs.join('/')}.`,
          ),
        );
      }
      console.log();
    }

    mappedCount++;
    processed.add(key);

    // If mode 2 (logicalName provided), stop after first match
    if (logicalName !== undefined) break;
  }

  if (options.json && jsonResults.length > 0) {
    printJson(jsonResults.length === 1 ? jsonResults[0] : jsonResults);
  }

  // Coverage summary (only when interactive work was done)
  if (mappedCount > 0 && !options.dryRun && !options.json) {
    const summary = computeCoverageSummary(chiralDir, envs, credentials);
    if (summary.totalWorkflows > 0) {
      const uncovered = summary.totalWorkflows - summary.coveredWorkflows;
      if (uncovered === 0) {
        console.log(
          `  ${chalk.green('Coverage:')} All ${summary.totalWorkflows} workflows fully covered.\n`,
        );
      } else {
        console.log(
          `  ${chalk.yellow('Coverage:')} ${summary.coveredWorkflows} of ${summary.totalWorkflows} workflows fully covered.`,
        );
        console.log(
          chalk.dim(
            `  ${uncovered} workflow${uncovered !== 1 ? 's' : ''} still have unmapped credentials - run 'chiral credential list --uncovered'.\n`,
          ),
        );
      }
    }
  }

  if (mappedCount > 0 && !options.dryRun) {
    const syncResult = await syncToRemote(
      chiralDir,
      config,
      `chore(chiral): credential map`,
    );
    if (!options.json && !syncResult.skipped && !syncResult.nothingToCommit) {
      if (syncResult.success) {
        console.log(formatSyncSuccess(syncResult));
      } else {
        for (const line of formatSyncFailure(syncResult)) console.error(chalk.yellow(line));
      }
      console.log();
    }
  }
}

// ── credential list ───────────────────────────────────────────────────────────

export async function runCredentialList(
  options: { uncovered?: boolean; env?: string; json?: boolean },
): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const credentials = loadCredentials(chiralDir);

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch {
    // fall back to env names derived from credentials.json
  }

  // Build env list: prefer config order, fall back to union of all envs in credentials.json
  let envList: string[];
  if (configResult) {
    envList = Object.keys(configResult.config.environments);
  } else {
    const allEnvs = new Set<string>();
    for (const entry of Object.values(credentials.credentials)) {
      for (const env of Object.keys(entry)) allEnvs.add(env);
    }
    envList = Array.from(allEnvs);
  }

  // Validate --env
  if (options.env) {
    if (configResult && !(options.env in configResult.config.environments)) {
      const available = Object.keys(configResult.config.environments).join(', ');
      throw new UserError(`Unknown environment "${options.env}". Available: ${available}`);
    }
  }

  // ── --uncovered mode ──────────────────────────────────────────────────────
  if (options.uncovered) {
    if (listDeployments(chiralDir).length === 0) {
      throw new UserError("No snapshots found. Run 'chiral adopt <env>' first.");
    }

    const targetEnvs = options.env ? [options.env] : envList;
    const discovered = extractCredentialsFromSnapshots(chiralDir, targetEnvs);

    // Filter to those not already in credentials.json for their env
    const uncovered = discovered.filter((d) => !isMapped(credentials, d.env, d.name));

    if (options.json) {
      printJson(uncovered.map((d) => ({ env: d.env, name: d.name, workflows: d.workflowNames })));
      return;
    }

    if (uncovered.length === 0) {
      console.log('\n  All credentials in your workflow snapshots are mapped.\n');
      return;
    }

    console.log('\n  Unmapped credentials (used in workflows but not in credentials.json):\n');

    const byEnv = new Map<string, typeof uncovered>();
    for (const d of uncovered) {
      const list = byEnv.get(d.env) ?? [];
      list.push(d);
      byEnv.set(d.env, list);
    }
    for (const [env, creds] of byEnv) {
      const namePad = Math.max(...creds.map((c) => c.name.length));
      console.log(`  ${chalk.cyan(env)}:`);
      for (const c of creds) {
        console.log(
          `    ${chalk.dim('–')} ${padRight(c.name, namePad)} ${chalk.dim(`(${c.workflowNames.join(', ')})`)}`
        );
      }
      console.log();
    }

    console.log(chalk.dim("  Run 'chiral credential map' to map them.\n"));
    return;
  }

  // ── Default: box-drawing table ────────────────────────────────────────────
  let entries = Object.entries(credentials.credentials);
  if (options.env) {
    entries = entries.filter(([, envMap]) => options.env! in envMap);
  }

  if (options.json) {
    if (options.env) {
      printJson({ version: credentials.version, credentials: Object.fromEntries(entries) });
    } else {
      printJson(credentials);
    }
    return;
  }

  if (entries.length === 0) {
    console.log(chalk.dim('\n  No credentials mapped. Run chiral credential map to add one.\n'));
    return;
  }

  const C_LOGICAL = Math.max('LOGICAL NAME'.length, ...entries.map(([l]) => l.length));
  const C_ENVS = envList.map((env) =>
    Math.max(env.length, ...entries.map(([, m]) => (m[env] ?? '(not set)').length)),
  );
  const widths = [C_LOGICAL, ...C_ENVS];
  const headers = [chalk.dim('LOGICAL NAME'), ...envList.map((env) => chalk.cyan(env))];
  const rows = entries.map(([logical, envMap]) => ({
    label: logical,
    hasGap: envList.some((env) => !(env in envMap)),
    cells: envList.map((env) => envMap[env] ?? chalk.dim('(not set)')),
  }));
  renderBoxTable(widths, headers, rows);
}

// ── credential unmap ──────────────────────────────────────────────────────────

export async function runCredentialUnmap(
  logicalName: string,
  options: { env?: string },
): Promise<void> {
  const actor = getGitActor();
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const credentials = loadCredentials(chiralDir);

  if (!(logicalName in credentials.credentials)) {
    throw new UserError(
      `Credential "${logicalName}" not found in credentials.json`,
    );
  }

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try {
    configResult = loadConfigAndDir();
  } catch { /* best-effort */ }

  if (options.env) {
    const entry = credentials.credentials[logicalName];
    if (!entry || !(options.env in entry)) {
      throw new UserError(
        `No mapping for "${logicalName}" in env "${options.env}"`,
      );
    }
    delete entry[options.env];
    // Clean up empty entry
    if (Object.keys(entry).length === 0) {
      delete credentials.credentials[logicalName];
    }
  } else {
    delete credentials.credentials[logicalName];
  }

  writeCredentials(chiralDir, credentials);

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
      `\n  ${chalk.green('✓')} Removed credential "${logicalName}"\n`,
    );
  }

  const syncResult = await syncToRemote(
    chiralDir,
    configResult?.config ?? { version: 1, project: 'unknown', environments: {} } as never,
    `chore(chiral): credential unmap ${logicalName}`,
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

const credentialMapCmd = new Command('map')
  .description('Register or update credential name mappings in credentials.json')
  .argument('[args...]', 'Logical name, uniform name, or env=name pairs')
  .option('--smart', 'Paid: enable fuzzy cross-env matching for non-standard naming patterns (requires license)')
  .option('--dry-run', 'Print what would be written without saving')
  .option('--json', 'Emit result as JSON instead of human output')
  .addHelpText(
    'after',
    `
Examples:
  Interactive - discover and map unmapped credentials:
    chiral credential map

  Map by name, fill envs interactively:
    chiral credential map postgres

  Uniform name across all environments:
    chiral credential map postgres postgres

  Per-environment names:
    chiral credential map postgres dev=dev_postgres prod=prod_postgres

  Fuzzy cross-env matching (requires license):
    chiral credential map --smart
`,
  )
  .action(async (args: string[], options: { smart?: boolean; dryRun?: boolean; json?: boolean }) => {
    await runCredentialMap(args, options);
  });

const credentialListCmd = new Command('list')
  .description('Display all mapped credentials and their per-env names')
  .option('--uncovered', 'Show credentials found in workflow snapshots but not yet mapped')
  .option('--env <env>', 'Filter to entries that include a mapping for this environment')
  .option('--json', 'Emit machine-readable JSON')
  .addHelpText(
    'after',
    `
Examples:
  List all credential mappings:
    chiral credential list

  Find credentials used in workflows but not yet mapped:
    chiral credential list --uncovered

  Filter to entries for a specific environment:
    chiral credential list --env prod
`,
  )
  .action(async (options: { uncovered?: boolean; env?: string; json?: boolean }) => {
    await runCredentialList(options);
  });

const credentialUnmapCmd = new Command('unmap')
  .description('Remove an entire credential entry or a single env mapping')
  .argument('<logical-name>', 'Logical credential identifier to remove')
  .option('--env <env>', "Remove only this environment's mapping; leave others intact")
  .addHelpText(
    'after',
    `
Examples:
  Remove the entire credential entry:
    chiral credential unmap postgres

  Remove only the staging mapping:
    chiral credential unmap postgres --env staging
`,
  )
  .action(async (logicalName: string, options: { env?: string }) => {
    await runCredentialUnmap(logicalName, options);
  });

export const credentialCommand = new Command('credential')
  .description('Manage credential name mappings across environments');

credentialCommand.addCommand(credentialMapCmd);
credentialCommand.addCommand(credentialListCmd);
credentialCommand.addCommand(credentialUnmapCmd);
