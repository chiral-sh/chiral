import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import ora from 'ora';
import { loadConfigAndDir } from '../lib/config.js';
import { getGitActor } from '../lib/git.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError, ControlledExit } from '../lib/errors.js';
import { printJson } from '../lib/output.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DoctorOptions {
  env?: string;
  json?: boolean;
  quiet?: boolean;
}

export interface CheckResult {
  name: string;
  category: 'system' | 'project' | 'connectivity';
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  hint?: string;
  _isNetworkError?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_N8N_VERSION = '1.0.0';
const NETWORK_ERROR_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'];

const DISPLAY_LABELS: Record<string, string> = {
  'git-installed': 'git installed',
  'git-email': 'git email configured',
  'node-version': 'node version',
  'project-directory': 'project directory',
  'config-json': 'config.json present',
  'config-valid': 'config schema valid',
  'no-duplicate-urls': 'no duplicate URLs',
};

function displayLabel(name: string): string {
  if (DISPLAY_LABELS[name]) return DISPLAY_LABELS[name];
  const m = /^env-(.+)-reachable$/.exec(name);
  if (m) return `${m[1]} reachable`;
  return name;
}

// ── Check functions ───────────────────────────────────────────────────────────

function checkGitInstalled(): CheckResult {
  try {
    const out = execSync('git --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return { name: 'git-installed', category: 'system', status: 'pass', message: out };
  } catch {
    return {
      name: 'git-installed',
      category: 'system',
      status: 'fail',
      message: 'git not found',
      hint: 'Install git from https://git-scm.com/downloads',
    };
  }
}

function checkGitEmail(): CheckResult {
  try {
    const email = getGitActor();
    return { name: 'git-email', category: 'system', status: 'pass', message: email };
  } catch {
    return {
      name: 'git-email',
      category: 'system',
      status: 'fail',
      message: 'git user.email not configured',
      hint: 'Run: git config --global user.email "you@example.com"',
    };
  }
}

function checkNodeVersion(): CheckResult {
  const vStr = process.version;
  const major = parseInt(vStr.replace(/^v/, ''), 10);
  if (isNaN(major)) {
    return {
      name: 'node-version',
      category: 'system',
      status: 'warn',
      message: `Unknown Node version: ${vStr}`,
      hint: 'Install Node.js ≥ 20 from https://nodejs.org',
    };
  }
  if (major < 20) {
    return {
      name: 'node-version',
      category: 'system',
      status: 'fail',
      message: `${vStr} (required: >=20)`,
      hint: 'Upgrade Node.js to v20 or later from https://nodejs.org',
    };
  }
  return { name: 'node-version', category: 'system', status: 'pass', message: `${vStr} (required: >=20)` };
}

function isVersionBelow(version: string, min: string): boolean {
  const parts = version.split('.');
  const minParts = min.split('.');
  const major = parseInt(parts[0] ?? '0', 10);
  const minor = parseInt(parts[1] ?? '0', 10);
  const minMajor = parseInt(minParts[0] ?? '0', 10);
  const minMinor = parseInt(minParts[1] ?? '0', 10);
  if (isNaN(major) || isNaN(minMajor)) return false;
  if (major !== minMajor) return major < minMajor;
  return minor < minMinor;
}

// ── Run function ──────────────────────────────────────────────────────────────

export async function runDoctor(options: DoctorOptions, cwd?: string): Promise<void> {
  const outputMode: 'human' | 'json' = options.json ? 'json' : 'human';

  // Pre-load config for --env validation and project/connectivity checks.
  // Done before any check results are pushed so --env errors surface first.
  let configResult: ReturnType<typeof loadConfigAndDir> | undefined;
  let configLoadError: Error | undefined;
  try {
    configResult = loadConfigAndDir(cwd);
  } catch (err) {
    configLoadError = err instanceof Error ? err : new Error(String(err));
  }

  // Validate --env before any checks run
  if (options.env && configResult) {
    if (!configResult.config.environments[options.env]) {
      const available = Object.keys(configResult.config.environments).join(', ');
      throw new UserError(`Unknown environment "${options.env}". Available: ${available}`);
    }
  }

  const checks: CheckResult[] = [];

  // ── System checks ─────────────────────────────────────────────────────────

  const gitInstalled = checkGitInstalled();
  checks.push(gitInstalled);

  if (gitInstalled.status !== 'fail') {
    checks.push(checkGitEmail());
  }

  checks.push(checkNodeVersion());

  // ── Project checks ────────────────────────────────────────────────────────

  if (configResult) {
    const { config, chiralDir } = configResult;

    checks.push({ name: 'project-directory', category: 'project', status: 'pass', message: chiralDir });
    checks.push({ name: 'config-json', category: 'project', status: 'pass', message: 'config.json found' });
    checks.push({ name: 'config-valid', category: 'project', status: 'pass', message: 'schema valid' });

    const urlToEnvs = new Map<string, string[]>();
    for (const [envName, env] of Object.entries(config.environments)) {
      const existing = urlToEnvs.get(env.url) ?? [];
      existing.push(envName);
      urlToEnvs.set(env.url, existing);
    }
    const duplicates = [...urlToEnvs.entries()].filter(([, names]) => names.length > 1);
    if (duplicates.length > 0) {
      const pairs = duplicates.map(([, names]) => names.join(' and ')).join('; ');
      checks.push({
        name: 'no-duplicate-urls',
        category: 'project',
        status: 'warn',
        message: `${pairs} share the same URL`,
        hint: 'Each environment should have a unique n8n instance URL.',
      });
    } else {
      checks.push({ name: 'no-duplicate-urls', category: 'project', status: 'pass', message: 'all URLs unique' });
    }

    // ── Connectivity checks ───────────────────────────────────────────────

    const envNames = options.env ? [options.env] : Object.keys(config.environments);

    for (const envName of envNames) {
      const envConfig = config.environments[envName];
      const client = new N8nClient(envConfig, envName);

      const spinner = process.stdout.isTTY
        ? ora({ text: `  Checking ${envName} connectivity…`, color: 'cyan' }).start()
        : null;

      try {
        const { workflowCount, n8nVersion } = await client.testConnection();
        if (spinner) spinner.stop();

        if (n8nVersion && isVersionBelow(n8nVersion, MIN_N8N_VERSION)) {
          checks.push({
            name: `env-${envName}-reachable`,
            category: 'connectivity',
            status: 'warn',
            message: `${workflowCount} workflow${workflowCount === 1 ? '' : 's'} found (n8n v${n8nVersion} — below recommended v${MIN_N8N_VERSION})`,
            hint: `Upgrade n8n to v${MIN_N8N_VERSION} or later to avoid API compatibility issues.`,
          });
        } else {
          checks.push({
            name: `env-${envName}-reachable`,
            category: 'connectivity',
            status: 'pass',
            message: `${workflowCount} workflow${workflowCount === 1 ? '' : 's'} found`,
          });
        }
      } catch (err) {
        if (spinner) spinner.stop();

        const message = err instanceof Error ? err.message : String(err);
        const code = (err as NodeJS.ErrnoException).code ?? '';
        const isNetwork =
          NETWORK_ERROR_CODES.includes(code) ||
          message.toLowerCase().includes('timeout') ||
          message.toLowerCase().includes('connection refused') ||
          message.toLowerCase().includes('cannot reach');

        checks.push({
          name: `env-${envName}-reachable`,
          category: 'connectivity',
          status: 'fail',
          message,
          hint: `Check that n8n is running and the URL in config.json is correct.\n           Run: chiral environment configure ${envName}`,
          _isNetworkError: isNetwork,
        });
      }
    }
  } else if (configLoadError) {
    const msg = configLoadError.message;
    if (msg.includes('Invalid config')) {
      checks.push({
        name: 'config-valid',
        category: 'project',
        status: 'fail',
        message: msg,
        hint: "Run 'chiral environment add' to reconfigure.",
      });
    } else if (msg.includes('valid JSON') || msg.includes('Could not read')) {
      checks.push({
        name: 'config-json',
        category: 'project',
        status: 'fail',
        message: msg,
        hint: "Run 'chiral environment add' to create the config.",
      });
    } else {
      checks.push({
        name: 'project-directory',
        category: 'project',
        status: 'warn',
        message: 'Not in a chiral project directory',
      });
    }
  }

  // ── Exit code ─────────────────────────────────────────────────────────────

  const hasNetworkFail = checks.some(
    c => c.category === 'connectivity' && c.status === 'fail' && c._isNetworkError,
  );
  const hasRequiredFail = checks.some(c => c.status === 'fail');
  const exitCode = hasNetworkFail ? 5 : hasRequiredFail ? 1 : 0;

  // ── Output ────────────────────────────────────────────────────────────────

  const passCount = checks.filter(c => c.status === 'pass').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const failCount = checks.filter(c => c.status === 'fail').length;

  if (outputMode === 'json') {
    const jsonChecks = checks.map(({ _isNetworkError: _n, ...rest }) => rest);
    printJson({ checks: jsonChecks, summary: { pass: passCount, warn: warnCount, fail: failCount } });
  } else {
    const icon = (status: CheckResult['status']): string => {
      if (status === 'pass') return chalk.green('✓');
      if (status === 'warn') return chalk.yellow('⚠');
      return chalk.red('✗');
    };

    const categories: Array<{ heading: string; key: CheckResult['category'] }> = [
      { heading: 'System', key: 'system' },
      { heading: 'Project', key: 'project' },
      { heading: 'Connectivity', key: 'connectivity' },
    ];

    console.log();

    for (const { heading, key } of categories) {
      const catChecks = checks.filter(c => c.category === key);
      const visible = options.quiet ? catChecks.filter(c => c.status !== 'pass') : catChecks;
      if (catChecks.length === 0 || (options.quiet && visible.length === 0)) continue;

      console.log(`  ${chalk.bold(heading)}`);
      for (const check of visible) {
        const nameCol = displayLabel(check.name).padEnd(22);
        const msgPart = check.message ? `  ${chalk.dim(check.message)}` : '';
        console.log(`  ${icon(check.status)} ${nameCol}${msgPart}`);
        if (check.hint) {
          console.log();
          console.log(`      ${check.hint}`);
          console.log();
        }
      }
      console.log();
    }

    const warnLabel = warnCount === 1 ? '1 warning' : `${warnCount} warnings`;
    const failLabel = failCount === 1 ? '1 failed' : `${failCount} failed`;
    console.log(`  ${passCount} passed, ${warnLabel}, ${failLabel}.`);
    console.log();
  }

  if (exitCode === 5) throw new ControlledExit(5);
  if (exitCode === 1) throw new ControlledExit(1);
}

// ── Command definition ────────────────────────────────────────────────────────

export const doctorCommand = new Command('doctor')
  .description('Run diagnostic checks on system prerequisites, project health, and environment connectivity')
  .option('--env <name>', 'Run connectivity check for one environment only')
  .option('--json', 'Emit standard JSON envelope to stdout instead of human-readable output')
  .option('--quiet', 'Suppress passing checks in human output (non-pass checks still shown)')
  .addHelpText(
    'after',
    `
Examples:
  Run all checks:
    chiral doctor

  Check a single environment only:
    chiral doctor --env prod

  CI preflight gate (exits 1 on failure, 5 on network error):
    chiral doctor --quiet

  Machine-readable output:
    chiral doctor --json
`,
  )
  .action(async (opts: DoctorOptions) => {
    await runDoctor(opts);
  });
