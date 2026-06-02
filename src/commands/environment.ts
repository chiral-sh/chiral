import { input, password, confirm } from '@inquirer/prompts';
import ora from 'ora';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  writeConfig,
  updateConfigExampleEnvs,
  readProjectNameFromExample,
  loadConfigAndDir,
  type Config,
  type GitSync,
} from '../lib/config.js';
import { resolveActiveProject } from '../lib/projects.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError } from '../lib/errors.js';

// ── Output mode ───────────────────────────────────────────────────────────────

type OutputMode = 'human' | 'json';

function resolveOutputMode(options: { json?: boolean }): OutputMode {
  if (options.json || !process.stdout.isTTY) return 'json';
  return 'human';
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function maskKey(key: string): string {
  if (key.length <= 4) return '••••';
  return '••••••••' + key.slice(-4);
}

function truncateUrl(url: string, max = 36): string {
  return url.length > max ? url.slice(0, max - 1) + '…' : url;
}

function validateUrl(val: string): string | boolean {
  try { new URL(val); return true; } catch { return 'Enter a valid URL (e.g. https://n8n.example.com)'; }
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padRight(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - visibleLen(s)));
}

// ── Summary table ─────────────────────────────────────────────────────────────

interface EnvResult {
  name: string;
  url: string;
  workflowCount?: number;
  status: 'connected' | 'unreachable' | 'skipped';
}

function printEnvTable(
  project: string,
  allEnvs: Record<string, { url: string; apiKey: string }>,
  results: EnvResult[],
): void {
  const names = Object.keys(allEnvs);
  const C_ENV = Math.max(5, ...names.map((n) => n.length)) + 2;
  const C_URL = 36;
  const C_ST = 20;

  const bar = (l: string, s: string, r: string) =>
    `  ${l}${'─'.repeat(C_ENV + 2)}${s}${'─'.repeat(C_URL + 2)}${s}${'─'.repeat(C_ST + 2)}${r}`;
  const row = (e: string, u: string, s: string) =>
    `  │ ${padRight(e, C_ENV)} │ ${padRight(u, C_URL)} │ ${padRight(s, C_ST)} │`;

  console.log(`\n  ${chalk.bold(project)}\n`);
  console.log(bar('┌', '┬', '┐'));
  console.log(row(chalk.dim('env'), chalk.dim('url'), chalk.dim('status')));
  console.log(bar('├', '┼', '┤'));

  for (const [name, env] of Object.entries(allEnvs)) {
    const result = results.findLast((r) => r.name === name);
    let statusStr: string;
    if (!result) {
      statusStr = chalk.dim('─ existing');
    } else if (result.status === 'connected') {
      const n = result.workflowCount ?? 0;
      statusStr = chalk.green(`✓ ${n} workflow${n === 1 ? '' : 's'}`);
    } else if (result.status === 'unreachable') {
      statusStr = chalk.red('✗ unreachable');
    } else {
      statusStr = chalk.yellow('⚠ not tested');
    }
    console.log(row(chalk.cyan(name), chalk.dim(truncateUrl(env.url)), statusStr));
  }

  console.log(bar('└', '┴', '┘'));
}

// ── Load existing config (partial-OK - creates blank if missing) ───────────────

interface LoadedState {
  project: string;
  chiralDir: string;
  environments: Record<string, { url: string; apiKey: string }>;
  licenseKey?: string;
  gitSync?: GitSync;
}

function loadState(): LoadedState {
  let resolved: ReturnType<typeof resolveActiveProject>;
  try {
    resolved = resolveActiveProject();
  } catch {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }
  const { chiralDir } = resolved;

  const configPath = join(chiralDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      // Pass the already-resolved project to avoid a second resolveActiveProject() call,
      // which would race with touchSession()'s async write on the same session file.
      const { config } = loadConfigAndDir(resolved);
      return {
        project: config.project,
        chiralDir,
        environments: { ...config.environments },
        licenseKey: config.licenseKey,
        gitSync: config.gitSync,
      };
    } catch {
      // config.json exists but is invalid - fall through to example
    }
  }

  const project = readProjectNameFromExample(chiralDir);
  return { project, chiralDir, environments: {} };
}

function saveState(state: LoadedState): void {
  const config: Config = {
    version: 1,
    project: state.project,
    environments: state.environments,
    ...(state.licenseKey ? { licenseKey: state.licenseKey } : {}),
    ...(state.gitSync ? { gitSync: state.gitSync } : {}),
  };
  writeConfig(state.chiralDir, config);
}

// ── environment add ────────────────────────────────────────────────────────────

export async function runEnvironmentAdd(
  envName: string | undefined,
  options: { skipTest?: boolean; url?: string; apiKey?: string; json?: boolean },
): Promise<void> {
  const outputMode = resolveOutputMode(options);
  const state = loadState();

  // Determine env name
  let name = envName?.trim() ?? '';
  if (!name) {
    if (outputMode === 'json') {
      throw new UserError('Environment name is required in non-interactive mode. Pass it as an argument: chiral environment add <name> --url <url> --api-key <key>');
    }
    name = await input({
      message: 'Environment name:',
      default: Object.keys(state.environments).length === 0 ? 'dev' : undefined,
      validate: (v) => (v.trim() ? true : 'Name cannot be empty'),
    });
    name = name.trim();
  }

  if (name in state.environments) {
    throw new UserError(
      `Environment "${name}" already exists. Run 'chiral environment configure ${name}' to update it.`,
    );
  }

  // Resolve URL: flag → env var → prompt
  const envUpper = name.toUpperCase();
  const urlFromEnv = process.env[`CHIRAL_URL_${envUpper}`];
  const keyFromEnv = process.env[`CHIRAL_API_KEY_${envUpper}`];

  let url = options.url ?? urlFromEnv ?? '';
  let apiKey = options.apiKey ?? keyFromEnv ?? '';

  if (outputMode === 'json') {
    if (!url) {
      throw new UserError(
        `--url is required in non-interactive mode. Pass --url <url> or set CHIRAL_URL_${envUpper}.`,
      );
    }
    try { new URL(url); } catch {
      throw new UserError(`Invalid URL: "${url}". Must be a valid URL (e.g. https://n8n.example.com).`);
    }
    if (!apiKey) {
      throw new UserError(
        `--api-key is required in non-interactive mode. Pass --api-key <key> or set CHIRAL_API_KEY_${envUpper}.`,
      );
    }
  } else {
    if (!url) {
      console.log(`\n  ${chalk.bold('Adding')} ${chalk.cyan(name)}\n`);
      url = await input({
        message: '  n8n URL:',
        validate: validateUrl,
      });
    }
    if (!apiKey) {
      console.log(
        chalk.dim(
          '  Scopes needed: workflow:list  workflow:read  workflow:create  workflow:update  workflow:activate\n' +
          '                 credential:list  tag:list  tag:create  (n8n Settings → API)',
        ),
      );
      const keyInput = await password({ message: '  API key:', mask: '•' });
      if (!keyInput) throw new UserError('API key is required');
      apiKey = keyInput;
    }
  }

  const normalizedUrl = url.replace(/\/+$/, '');
  let connected = false;
  let workflowCount: number | undefined;
  let status: EnvResult['status'] = 'skipped';

  if (!options.skipTest) {
    if (outputMode === 'json') {
      try {
        const client = new N8nClient({ url: normalizedUrl, apiKey }, name);
        ({ workflowCount } = await client.testConnection());
        connected = true;
        status = 'connected';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new UserError(`Connection test failed: ${msg}`);
      }
    } else {
      const spinner = ora({ text: '  Testing connection…', color: 'cyan' }).start();
      try {
        const client = new N8nClient({ url: normalizedUrl, apiKey }, name);
        ({ workflowCount } = await client.testConnection());
        spinner.succeed(chalk.green('  Connected') + chalk.dim(` - ${workflowCount} workflow${workflowCount === 1 ? '' : 's'} found`));
        connected = true;
        status = 'connected';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spinner.fail(chalk.red(`  ${msg}`));
        if (err instanceof UserError && err.hint) console.error('\n' + err.hint + '\n');
        const saveAnyway = await confirm({ message: '  Save anyway?', default: false });
        if (!saveAnyway) {
          console.log(chalk.dim('\n  Environment not saved.\n'));
          return;
        }
        status = 'unreachable';
      }
    }
  }

  state.environments[name] = { url: normalizedUrl, apiKey };
  saveState(state);

  updateConfigExampleEnvs(state.chiralDir, (envs) => {
    envs[name] = { url: normalizedUrl, apiKey: `YOUR_${name.toUpperCase()}_API_KEY` };
  });

  if (outputMode === 'json') {
    console.log(JSON.stringify({ status: 'ok', data: { env: name, url: normalizedUrl, connected } }));
    return;
  }

  const results: EnvResult[] = [{ name, url: normalizedUrl, workflowCount, status }];
  printEnvTable(state.project, state.environments, results);
  console.log(`\n  ${chalk.dim('Next:')} chiral adopt --env ${name}\n`);
}

// ── environment configure ──────────────────────────────────────────────────────

export async function runEnvironmentConfigure(
  envName: string,
  options: { skipTest?: boolean; url?: string; apiKey?: string; json?: boolean },
): Promise<void> {
  const outputMode = resolveOutputMode(options);
  const state = loadState();

  const existing = state.environments[envName];
  if (!existing) {
    throw new UserError(
      `Environment "${envName}" not found. Run 'chiral environment add ${envName}' to create it.`,
    );
  }

  // Resolve URL and API key: flag → env var → existing value (for non-interactive) or prompt
  const envUpper = envName.toUpperCase();
  const urlFromEnv = process.env[`CHIRAL_URL_${envUpper}`];
  const keyFromEnv = process.env[`CHIRAL_API_KEY_${envUpper}`];

  let url = options.url ?? urlFromEnv ?? '';
  let apiKey = options.apiKey ?? keyFromEnv ?? '';

  if (outputMode === 'json') {
    // In JSON mode, fall back to existing values when flags/env vars are absent
    if (!url) url = existing.url;
    if (!apiKey) apiKey = existing.apiKey;
  } else {
    console.log(`\n  ${chalk.bold('Updating')} ${chalk.cyan(envName)}\n`);
    if (!url) {
      url = await input({
        message: '  n8n URL:',
        default: existing.url,
        validate: validateUrl,
      });
    }
    if (!apiKey) {
      console.log(chalk.dim(`  Current key: ${maskKey(existing.apiKey)} - Enter to keep`));
      const keyInput = await password({ message: '  API key:', mask: '•' });
      apiKey = keyInput || existing.apiKey;
    }
  }

  if (!url) throw new UserError('URL is required.');
  try { new URL(url); } catch {
    throw new UserError(`Invalid URL: "${url}". Must be a valid URL (e.g. https://n8n.example.com).`);
  }
  if (!apiKey) throw new UserError('API key is required.');

  const normalizedUrl = url.replace(/\/+$/, '');
  let connected = false;
  let workflowCount: number | undefined;
  let status: EnvResult['status'] = 'skipped';

  if (!options.skipTest) {
    if (outputMode === 'json') {
      try {
        const client = new N8nClient({ url: normalizedUrl, apiKey }, envName);
        ({ workflowCount } = await client.testConnection());
        connected = true;
        status = 'connected';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new UserError(`Connection test failed: ${msg}`);
      }
    } else {
      const spinner = ora({ text: '  Testing connection…', color: 'cyan' }).start();
      try {
        const client = new N8nClient({ url: normalizedUrl, apiKey }, envName);
        ({ workflowCount } = await client.testConnection());
        spinner.succeed(chalk.green('  Connected') + chalk.dim(` - ${workflowCount} workflow${workflowCount === 1 ? '' : 's'} found`));
        connected = true;
        status = 'connected';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spinner.fail(chalk.red(`  ${msg}`));
        if (err instanceof UserError && err.hint) console.error('\n' + err.hint + '\n');
        const saveAnyway = await confirm({ message: '  Save anyway?', default: false });
        if (!saveAnyway) {
          console.log(chalk.dim('\n  No changes saved.\n'));
          return;
        }
        status = 'unreachable';
      }
    }
  }

  state.environments[envName] = { url: normalizedUrl, apiKey };
  saveState(state);

  updateConfigExampleEnvs(state.chiralDir, (envs) => {
    const existingKey = envs[envName]?.apiKey as string | undefined;
    envs[envName] = {
      url: normalizedUrl,
      apiKey: existingKey || `YOUR_${envName.toUpperCase()}_API_KEY`,
    };
  });

  if (outputMode === 'json') {
    console.log(JSON.stringify({ status: 'ok', data: { env: envName, url: normalizedUrl, connected } }));
    return;
  }

  const results: EnvResult[] = [{ name: envName, url: normalizedUrl, workflowCount, status }];
  printEnvTable(state.project, state.environments, results);
  console.log(`\n  ${chalk.dim('Next:')} chiral adopt --env ${envName}\n`);
}

// ── environment list ──────────────────────────────────────────────────────────

export async function runEnvironmentList(options: { json?: boolean } = {}): Promise<void> {
  const outputMode = resolveOutputMode(options);
  const state = loadState();

  if (outputMode === 'json') {
    const data = Object.entries(state.environments).map(([env, cfg]) => ({
      env,
      url: cfg.url,
    }));
    console.log(JSON.stringify({ status: 'ok', data }));
    return;
  }

  if (Object.keys(state.environments).length === 0) {
    console.log(
      `\n  ${chalk.bold(state.project)} - no environments configured.\n` +
      `  Run 'chiral environment add <name>' to add one.\n`,
    );
    return;
  }

  printEnvTable(state.project, state.environments, []);
  console.log();
}

// ── environment rename ─────────────────────────────────────────────────────────

export async function runEnvironmentRename(
  oldName: string,
  newName: string,
  options: { json?: boolean } = {},
): Promise<void> {
  const outputMode = resolveOutputMode(options);
  const state = loadState();

  if (!(oldName in state.environments)) {
    throw new UserError(`Environment "${oldName}" not found.`);
  }
  if (newName in state.environments) {
    throw new UserError(`Environment "${newName}" already exists.`);
  }
  if (!newName.trim()) throw new UserError('New environment name cannot be empty');

  const renameInFile = (filePath: string): void => {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      if (typeof raw !== 'object' || raw === null) return;
      // Rename top-level key if present (for credentials.json / workflows.json per-env keys)
      const inner = raw['credentials'] ?? raw['workflows'] ?? raw['envs'];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const obj = inner as Record<string, unknown>;
        if (oldName in obj) {
          obj[newName] = obj[oldName];
          delete obj[oldName];
        }
      }
      writeFileSync(filePath + '.tmp', JSON.stringify(raw, null, 2) + '\n', 'utf-8');
      renameSync(filePath + '.tmp', filePath);
    } catch {
      // best-effort - leave the file unchanged if we can't parse it
    }
  };

  const { chiralDir } = state;
  renameInFile(join(chiralDir, 'credentials.json'));
  renameInFile(join(chiralDir, 'workflows.json'));
  renameInFile(join(chiralDir, 'fingerprints.json'));

  // Update config
  const envData = state.environments[oldName];
  delete state.environments[oldName];
  state.environments[newName] = envData;
  saveState(state);

  updateConfigExampleEnvs(state.chiralDir, (envs) => {
    if (oldName in envs) {
      const existingKey = envs[oldName]?.apiKey as string | undefined;
      const apiKey = existingKey?.replace(oldName.toUpperCase(), newName.toUpperCase()) || `YOUR_${newName.toUpperCase()}_API_KEY`;
      envs[newName] = { ...envs[oldName], apiKey };
      delete envs[oldName];
    }
  });

  if (outputMode === 'json') {
    console.log(JSON.stringify({ status: 'ok', data: { old_name: oldName, new_name: newName } }));
    return;
  }

  console.log(`\n  ${chalk.green('✓')}  Renamed environment ${chalk.cyan(oldName)} → ${chalk.cyan(newName)}\n`);
}

// ── environment delete ─────────────────────────────────────────────────────────

export async function runEnvironmentDelete(
  envName: string,
  options: { yes?: boolean; dryRun?: boolean; json?: boolean },
): Promise<void> {
  const outputMode = resolveOutputMode(options);
  const state = loadState();

  if (!(envName in state.environments)) {
    throw new UserError(`Environment "${envName}" not found.`);
  }

  if (options.dryRun) {
    if (outputMode === 'json') {
      console.log(JSON.stringify({ status: 'ok', data: { env: envName, would_delete: true } }));
    } else {
      console.log(`\n  ${chalk.bold('Dry run')} — would delete environment ${chalk.cyan(envName)}\n`);
    }
    return;
  }

  const isProd = envName.toLowerCase().includes('prod');

  if (!options.yes) {
    if (outputMode === 'json') {
      throw new UserError(`Pass --yes to confirm deletion in non-interactive mode.`);
    }
    if (isProd) {
      const confirmed = await input({
        message: `Type "${envName}" to confirm deletion:`,
        validate: (v) => v === envName || `Type exactly "${envName}" to confirm`,
      });
      if (confirmed !== envName) {
        console.log('\n  Cancelled.\n');
        return;
      }
    } else {
      const ok = await confirm({
        message: `Delete environment "${envName}"?`,
        default: false,
      });
      if (!ok) {
        console.log('\n  Cancelled.\n');
        return;
      }
    }
  }

  delete state.environments[envName];
  saveState(state);

  updateConfigExampleEnvs(state.chiralDir, (envs) => {
    delete envs[envName];
  });

  if (outputMode === 'json') {
    console.log(JSON.stringify({ status: 'ok', data: { env: envName, deleted: true } }));
    return;
  }

  console.log(`\n  ${chalk.green('✓')}  Deleted environment ${chalk.cyan(envName)}\n`);
}

// ── Command definitions ────────────────────────────────────────────────────────

export const environmentCommand = new Command('environment')
  .description('Manage n8n environment connections');

environmentCommand
  .command('add [name]')
  .description('Add a new environment connection')
  .option('--url <url>', 'n8n instance URL (non-interactive)')
  .option('--api-key <key>', 'n8n API key (non-interactive)')
  .option('--skip-test', 'Skip the connection test')
  .option('--json', 'Output result as JSON')
  .addHelpText('after', `
Environment variables:
  CHIRAL_URL_<ENV>      n8n URL for the named environment (e.g. CHIRAL_URL_PROD)
  CHIRAL_API_KEY_<ENV>  API key for the named environment (e.g. CHIRAL_API_KEY_PROD)

Examples:
  Add an environment interactively:
    chiral environment add

  Add a named environment:
    chiral environment add dev

  Non-interactive (CI/agent use):
    chiral environment add prod --url https://n8n.prod.com --api-key \$KEY --json

  Using environment variables:
    CHIRAL_URL_PROD=https://n8n.prod.com CHIRAL_API_KEY_PROD=\$KEY \\
      chiral environment add prod --json

Exit codes:
  0  Success
  1  General error (env already exists, connection failed)
  2  Usage error (missing required flags in non-interactive mode)
`)
  .action(async (nameArg: string | undefined, options: { skipTest?: boolean; url?: string; apiKey?: string; json?: boolean }) => {
    await runEnvironmentAdd(nameArg, options);
  });

environmentCommand
  .command('configure <name>')
  .description('Update URL or API key for an existing environment')
  .option('--url <url>', 'New n8n instance URL')
  .option('--api-key <key>', 'New n8n API key')
  .option('--skip-test', 'Skip the connection test')
  .option('--json', 'Output result as JSON')
  .addHelpText('after', `
Environment variables:
  CHIRAL_URL_<ENV>      n8n URL for the named environment (e.g. CHIRAL_URL_PROD)
  CHIRAL_API_KEY_<ENV>  API key for the named environment (e.g. CHIRAL_API_KEY_PROD)

Examples:
  Update an existing environment interactively:
    chiral environment configure dev

  Update URL only (non-interactive):
    chiral environment configure dev --url https://new-n8n.example.com --json

  Update both URL and key (non-interactive):
    chiral environment configure prod --url https://n8n.prod.com --api-key \$KEY --json

Exit codes:
  0  Success
  1  General error (env not found, connection failed)
  2  Usage error (invalid URL)
`)
  .action(async (name: string, options: { skipTest?: boolean; url?: string; apiKey?: string; json?: boolean }) => {
    await runEnvironmentConfigure(name, options);
  });

environmentCommand
  .command('list')
  .description('List all configured environments')
  .option('--json', 'Output result as JSON')
  .addHelpText('after', `
Examples:
  Show all environments:
    chiral environment list

  Output as JSON:
    chiral environment list --json

Exit codes:
  0  Success
  1  No active project found
`)
  .action(async (options: { json?: boolean }) => {
    await runEnvironmentList(options);
  });

environmentCommand
  .command('rename <old-name> <new-name>')
  .description('Rename an environment (updates all state files atomically)')
  .option('--json', 'Output result as JSON')
  .addHelpText('after', `
Examples:
  Rename dev to staging:
    chiral environment rename dev staging

  Output as JSON:
    chiral environment rename dev staging --json

Exit codes:
  0  Success
  1  Error (env not found, new name already exists)
`)
  .action(async (oldName: string, newName: string, options: { json?: boolean }) => {
    await runEnvironmentRename(oldName, newName, options);
  });

environmentCommand
  .command('delete <name>')
  .description('Delete an environment from config (type-to-confirm for prod)')
  .option('--yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Show what would be deleted without making changes')
  .option('--json', 'Output result as JSON (requires --yes for actual deletion)')
  .addHelpText('after', `
Examples:
  Delete an environment (will prompt to confirm):
    chiral environment delete staging

  Skip confirmation:
    chiral environment delete staging --yes

  Preview what would be deleted:
    chiral environment delete staging --dry-run

  Non-interactive (agent use):
    chiral environment delete staging --yes --json

  Dry run as JSON:
    chiral environment delete staging --dry-run --json

Exit codes:
  0  Success (or no-op for dry-run)
  1  Error (env not found)
  2  Usage error (--json without --yes for actual deletion)
`)
  .action(async (name: string, options: { yes?: boolean; dryRun?: boolean; json?: boolean }) => {
    await runEnvironmentDelete(name, options);
  });
