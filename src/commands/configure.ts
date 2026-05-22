import { input, password, confirm } from '@inquirer/prompts';
import ora from 'ora';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  findFlightdeckDir,
  writeConfig,
  readProjectNameFromExample,
  loadConfigAndDir,
  type Config,
} from '../lib/config.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError } from '../lib/errors.js';

// ─── helpers ────────────────────────────────────────────────────────────────

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

// ─── summary table ──────────────────────────────────────────────────────────

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
    const result = results.find((r) => r.name === name);
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

// ─── main logic ─────────────────────────────────────────────────────────────

export async function runConfigure(
  options: { env?: string; skipTest?: boolean },
  cwd: string = process.cwd(),
): Promise<void> {
  const flightdeckDir = findFlightdeckDir(cwd);
  if (!flightdeckDir) {
    throw new UserError("No .flightdeck/ found. Run 'flightdeck init' first.");
  }

  // Load existing config or start fresh from config.example.json
  let project: string;
  let environments: Record<string, { url: string; apiKey: string }> = {};
  let licenseKey: string | undefined;

  const configPath = join(flightdeckDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const { config } = loadConfigAndDir(flightdeckDir);
      project = config.project;
      environments = { ...config.environments };
      licenseKey = config.licenseKey;

      console.log(`\n  ${chalk.bold(project)} ${chalk.dim('— current configuration')}\n`);
      for (const [name, env] of Object.entries(environments)) {
        console.log(
          `  ${chalk.cyan(name.padEnd(14))} ${chalk.dim(truncateUrl(env.url, 44))}  ${chalk.dim(maskKey(env.apiKey))}`,
        );
      }
      console.log();
    } catch {
      project = readProjectNameFromExample(flightdeckDir);
    }
  } else {
    project = readProjectNameFromExample(flightdeckDir);
  }

  const results: EnvResult[] = [];
  const singleEnvMode = Boolean(options.env);
  let isFirst = true;
  let keepGoing = true;

  while (keepGoing) {
    // ── env name ──────────────────────────────────────────────────────────
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

    // ── URL ───────────────────────────────────────────────────────────────
    const url = await input({
      message: '  n8n URL:',
      default: existing?.url,
      validate: validateUrl,
    });

    // ── API key ───────────────────────────────────────────────────────────
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

    // ── connection test ───────────────────────────────────────────────────
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

        const saveAnyway = await confirm({ message: '  Save anyway?', default: false });
        if (!saveAnyway) {
          results.push({ name: envName, url, status: 'skipped' });
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

    // ── save env ──────────────────────────────────────────────────────────
    environments[envName] = { url, apiKey };
    results.push({ name: envName, url, workflowCount, status });

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

  // ── write config.json ─────────────────────────────────────────────────────
  const config: Config = {
    version: 1,
    project,
    environments,
    ...(licenseKey ? { licenseKey } : {}),
  };
  writeConfig(flightdeckDir, config);
  console.log('\n  ' + chalk.green('✓') + ' Saved .flightdeck/config.json  ' + chalk.dim('(mode 600)'));

  // ── summary ───────────────────────────────────────────────────────────────
  printSummary(project, environments, results);

  const firstNew = results.find((r) => r.status === 'connected')?.name ?? results[0]?.name;
  if (firstNew) {
    console.log(`\n  ${chalk.dim('Next:')} flightdeck adopt --env ${firstNew}\n`);
  }
}

export const configureCommand = new Command('configure')
  .description('Set up or update environment connections in .flightdeck/config.json')
  .option('--env <env>', 'Configure a specific environment (skips env name prompt)')
  .option('--skip-test', 'Skip the connection test')
  .action(async (options) => {
    await runConfigure(options);
  });
