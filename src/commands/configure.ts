import { input, password, confirm } from '@inquirer/prompts';
import ora from 'ora';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  findChiralDir,
  writeConfig,
  readProjectNameFromExample,
  loadConfigAndDir,
  type GitSync,
} from '../lib/config.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError } from '../lib/errors.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConfigureOptions {
  env?: string;
  skipTest?: boolean;
  remote?: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

// Flag interaction matrix:
//   --env        : single-env mode — skips env name prompt, exits after one env
//   --skip-test  : skip connection test; composes with all other flags
//   --remote     : update git sync remote; composes with --env and --skip-test
//
// --remote + --env    : additive — updates gitSync then falls through to configure the named env
// --remote + --skip-test: allowed — skip-test applies to env loop if it runs; irrelevant if
//                          --remote triggers an early return (no envs, --env not set)
function validateOptions(_options: ConfigureOptions): void {
  // No invalid combinations currently. Structure required by CLI guidelines.
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskKey(key: string): string {
  if (key.length <= 4) return '••••';
  return '••••••••' + key.slice(-4);
}

function truncateUrl(url: string, max = 36): string {
  return url.length > max ? url.slice(0, max - 1) + '…' : url;
}

function validateUrl(val: string): string | boolean {
  try {
    new URL(val);
    return true;
  } catch {
    return 'Enter a valid URL (e.g. https://n8n.example.com)';
  }
}

// Strip ANSI codes to get the visible character count for correct table padding.
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

function printSummary(
  project: string,
  allEnvs: Record<string, { url: string; apiKey: string }>,
  results: EnvResult[],
  gitSync?: GitSync,
): void {
  const names = Object.keys(allEnvs);
  const C_ENV = Math.max(5, ...names.map((n) => n.length)) + 2;
  const C_URL = 36;
  const C_ST = 20;

  const bar = (l: string, s: string, r: string) =>
    `  ${l}${'─'.repeat(C_ENV + 2)}${s}${'─'.repeat(C_URL + 2)}${s}${'─'.repeat(C_ST + 2)}${r}`;

  const row = (e: string, u: string, s: string) =>
    `  │ ${padRight(e, C_ENV)} │ ${padRight(u, C_URL)} │ ${padRight(s, C_ST)} │`;

  console.log(`\n  ${chalk.bold(project)}`);
  if (gitSync) {
    console.log(
      chalk.dim(`  Git sync → ${gitSync.remote} (${gitSync.branch})`),
    );
  }
  console.log();
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

// ── Git sync helpers ──────────────────────────────────────────────────────────

function readGitSyncFromExample(chiralDir: string): GitSync | undefined {
  const examplePath = join(chiralDir, 'config.example.json');
  try {
    const raw = JSON.parse(readFileSync(examplePath, 'utf-8'));
    if (raw?.gitSync?.enabled && raw.gitSync.remote) {
      return {
        enabled: Boolean(raw.gitSync.enabled),
        remote: String(raw.gitSync.remote),
        branch: typeof raw.gitSync.branch === 'string' ? raw.gitSync.branch : 'main',
      };
    }
  } catch {
    // config.example.json missing or unparseable — no gitSync to carry
  }
  return undefined;
}

// ── Main logic ────────────────────────────────────────────────────────────────

export async function runConfigure(
  options: ConfigureOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  validateOptions(options);

  const chiralDir = findChiralDir(cwd);
  if (!chiralDir) {
    throw new UserError("No .chiral/ found. Run 'chiral init' first.");
  }

  // Load existing config or start fresh from config.example.json
  let project: string;
  let environments: Record<string, { url: string; apiKey: string }> = {};
  let licenseKey: string | undefined;
  let gitSync: GitSync | undefined;

  const configPath = join(chiralDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const { config } = loadConfigAndDir(chiralDir);
      project = config.project;
      environments = { ...config.environments };
      licenseKey = config.licenseKey;
      gitSync = config.gitSync;

      console.log(`\n  ${chalk.bold(project)} ${chalk.dim('— current configuration')}\n`);
      for (const [name, env] of Object.entries(environments)) {
        console.log(
          `  ${chalk.cyan(name.padEnd(14))} ${chalk.dim(truncateUrl(env.url, 44))}  ${chalk.dim(maskKey(env.apiKey))}`,
        );
      }
      if (gitSync) {
        console.log(
          chalk.dim(`\n  Git sync → ${gitSync.remote} (${gitSync.branch})`),
        );
      }
      console.log();
    } catch {
      project = readProjectNameFromExample(chiralDir);
    }
  } else {
    project = readProjectNameFromExample(chiralDir);
    // Carry gitSync from config.example.json if init wrote it there
    gitSync = readGitSyncFromExample(chiralDir);
  }

  // ── --remote: update or enable gitSync ───────────────────────────────────────
  // Early return (remote-only mode) only when --env is NOT also set AND
  // environments already exist — otherwise fall through so --env can be handled.
  if (options.remote) {
    const currentBranch = gitSync?.branch ?? 'main';
    gitSync = { enabled: true, remote: options.remote, branch: currentBranch };
    console.log(
      `\n  ${chalk.green('✓')}  Git sync remote set → ${chalk.cyan(options.remote)} ${chalk.dim(`(${currentBranch})`)}`,
    );

    const hasEnvs = Object.keys(environments).length > 0;
    if (!options.env && hasEnvs) {
      // Remote-only update: persist, show summary, hint, done.
      writeConfig(chiralDir, {
        version: 1,
        project,
        environments,
        ...(licenseKey ? { licenseKey } : {}),
        gitSync,
      });
      console.log('  ' + chalk.green('✓') + '  Saved .chiral/config.json  ' + chalk.dim('(mode 600)'));
      printSummary(project, environments, [], gitSync);
      const firstEnv = Object.keys(environments)[0];
      if (firstEnv) {
        console.log(`\n  ${chalk.dim('Next:')} chiral adopt --env ${firstEnv}\n`);
      }
      return;
    }
    // else: fall through — --env was provided, or no envs exist yet
  }

  // ── Env collection loop ───────────────────────────────────────────────────────
  const results: EnvResult[] = [];
  const singleEnvMode = Boolean(options.env);
  let isFirst = true;
  let keepGoing = true;

  while (keepGoing) {
    // ── env name ────────────────────────────────────────────────────────────
    let envName: string;
    if (isFirst && options.env) {
      envName = options.env;
    } else {
      envName = await input({
        message: 'Environment name:',
        default: isFirst ? 'dev' : undefined,
        validate: (v) => (v.trim() ? true : 'Name cannot be empty'),
      });
    }
    envName = envName.trim();

    const isUpdating = envName in environments;
    const existing = environments[envName];

    console.log(
      `\n  ${chalk.bold(isUpdating ? 'Updating' : 'Configuring')} ${chalk.cyan(envName)}\n`,
    );

    // ── URL ──────────────────────────────────────────────────────────────────
    const url = await input({
      message: '  n8n URL:',
      default: existing?.url,
      validate: validateUrl,
    });

    // ── API key ──────────────────────────────────────────────────────────────
    console.log(
      chalk.dim(
        '  Scopes needed: workflow:list  workflow:read  workflow:create  workflow:update  workflow:activate\n' +
        '                 credential:list  tag:list  tag:create  (n8n Settings → API)',
      ),
    );
    const keyHint = existing
      ? chalk.dim(`  (${maskKey(existing.apiKey)} — Enter to keep)`)
      : '';
    const keyInput = await password({
      message: `  API key${keyHint}:`,
      mask: '•',
    });
    const apiKey = keyInput || existing?.apiKey || '';
    if (!apiKey) {
      throw new UserError('API key is required');
    }

    // ── Connection test ──────────────────────────────────────────────────────
    let workflowCount: number | undefined;
    let status: EnvResult['status'] = 'skipped';

    if (!options.skipTest) {
      const spinner = ora({ text: '  Testing connection…', color: 'cyan' }).start();
      try {
        const client = new N8nClient({ url, apiKey }, envName);
        ({ workflowCount } = await client.testConnection());
        spinner.succeed(
          chalk.green('  Connected') +
          chalk.dim(` — ${workflowCount} workflow${workflowCount === 1 ? '' : 's'} found`),
        );
        status = 'connected';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spinner.fail(chalk.red(`  ${msg}`));
        if (err instanceof UserError && err.hint) {
          console.error('\n' + err.hint + '\n');
        }

        const saveAnyway = await confirm({ message: '  Save anyway?', default: false });
        if (!saveAnyway) {
          results.push({ name: envName, url: url.replace(/\/+$/, ''), status: 'skipped' });
          if (!singleEnvMode) {
            const more = await confirm({ message: '\n  Add another environment?', default: false });
            if (!more) break;
            isFirst = false;
            continue;
          }
          break;
        }
        status = 'unreachable';
      }
    }

    // ── Save env — write immediately so Ctrl+C never loses confirmed work ────
    const normalizedUrl = url.replace(/\/+$/, '');
    environments[envName] = { url: normalizedUrl, apiKey };
    results.push({ name: envName, url: normalizedUrl, workflowCount, status });

    writeConfig(chiralDir, {
      version: 1,
      project,
      environments,
      ...(licenseKey ? { licenseKey } : {}),
      ...(gitSync ? { gitSync } : {}),
    });

    isFirst = false;

    if (singleEnvMode) {
      keepGoing = false;
    } else {
      console.log();
      keepGoing = await confirm({ message: '  Add another environment?', default: false });
    }
  }

  if (Object.keys(environments).length === 0) {
    console.log(chalk.dim('\n  Nothing saved.\n'));
    return;
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  printSummary(project, environments, results, gitSync);

  const firstNew = results.find((r) => r.status === 'connected')?.name ?? results[0]?.name;
  if (firstNew) {
    console.log(`\n  ${chalk.dim('Next:')} chiral adopt --env ${firstNew}\n`);
  }
}

export const configureCommand = new Command('configure')
  .description('Set up or update environment connections in .chiral/config.json')
  .option('--env <env>', 'Configure a specific environment (skips env name prompt)')
  .option('--skip-test', 'Skip the connection test')
  .option('--remote <remote>', 'Set or update the git remote for auto-sync (e.g. "origin")')
  .addHelpText(
    'after',
    `
Flag combinations:
  --remote and --env are additive: --remote updates the git sync remote and --env
    configures the named environment in the same invocation.
  --skip-test composes with any other flag.
  --remote alone (with existing environments) updates the remote and exits immediately.

Examples:
  Configure all environments interactively:
    chiral configure

  Update a single environment:
    chiral configure --env prod

  Configure without testing the connection:
    chiral configure --env dev --skip-test

  Update the git sync remote:
    chiral configure --remote origin

  Update the git sync remote and reconfigure prod in one command:
    chiral configure --remote origin --env prod
`,
  )
  .action(async (options) => {
    await runConfigure(options);
  });
