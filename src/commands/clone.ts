import chalk from 'chalk';
import ora from 'ora';
import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { input, password, confirm } from '@inquirer/prompts';
import { parseConfigExample } from '../lib/config.js';
import { writeConfig } from '../lib/config.js';
import type { Config } from '../lib/config.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError, ControlledExit } from '../lib/errors.js';
import {
  getProjectsDir,
  registerProject,
  unregisterProject,
  projectExists,
  getProjectPath,
  writeSession,
} from '../lib/projects.js';
import { readInitEvent } from '../state/audit.js';
import { loadWorkflowMap } from '../state/workflows.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CloneOptions {
  dir?: string;
  skipTest?: boolean;
  json?: boolean;
}

// ── Output mode ───────────────────────────────────────────────────────────────

type OutputMode = 'human' | 'json';

function resolveOutputMode(options: CloneOptions): OutputMode {
  if (options.json || !process.stdout.isTTY) return 'json';
  return 'human';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveNameFromUrl(repoUrl: string): string {
  // Extract last path segment, strip .git suffix
  const segment = repoUrl.split('/').filter(Boolean).pop() ?? 'repo';
  return segment.endsWith('.git') ? segment.slice(0, -4) : segment;
}

// ── Run function ──────────────────────────────────────────────────────────────

export async function runClone(
  repoUrl: string,
  options: CloneOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  const outputMode = resolveOutputMode(options);

  // ── 1. Derive tentative target dir ───────────────────────────────────────
  const projectsDir = getProjectsDir();
  let targetDir: string;
  if (options.dir) {
    targetDir = options.dir;
  } else {
    const tentativeName = deriveNameFromUrl(repoUrl);
    targetDir = join(projectsDir, tentativeName);
  }

  // ── 2. Directory collision check ─────────────────────────────────────────
  if (existsSync(targetDir)) {
    throw new UserError(
      `Directory '${basename(targetDir)}' already exists. Use --dir to specify a different location.`,
    );
  }

  let spinner;
  if (outputMode === 'human') {
    console.log();
    spinner = ora({ text: `  Cloning ${chalk.cyan(repoUrl)}…`, color: 'cyan' }).start();
  }

  // ── 3. Git clone ──────────────────────────────────────────────────────────
  try {
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['clone', repoUrl, targetDir], { cwd });
    if (spinner) {
      spinner.succeed(chalk.green('  Repository cloned'));
    }
  } catch (err) {
    if (spinner) {
      spinner.fail(chalk.red('  Clone failed'));
    }
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new UserError(
      `Git clone failed: ${msg}\nCheck that you have access to the repository and the URL is correct.`,
    );
  }

  let cleanupDir = targetDir;
  let projectRegistered = false;
  let currentProjectName = '';
  const collectedEnvs: Record<string, { url: string; apiKey: string }> = {};
  let example: ReturnType<typeof parseConfigExample> | undefined;

  try {
    // ── 4. Detect .chiral/ ────────────────────────────────────────────────────
    const chiralDir = join(targetDir, '.chiral');
    if (!existsSync(chiralDir)) {
      throw new UserError(
        "This repo doesn't appear to be a chiral project. Run 'chiral init' to set one up.",
      );
    }

  // ── 5. Parse config.example.json ─────────────────────────────────────────
  example = parseConfigExample(chiralDir);
  const projectName = example.project;
  currentProjectName = projectName;

  if (projectExists(projectName)) {
    const existingPath = getProjectPath(projectName);
    if (existingPath && existsSync(existingPath)) {
      try {
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], { cwd: existingPath });
        const existingRepoUrl = stdout.trim();
        
        const normalizeGitUrl = (u: string) => {
          let normalized = u.trim().replace(/\.git$/, '');
          normalized = normalized.replace(/^git@([^:]+):/, 'https://$1/');
          normalized = normalized.replace(/\/$/, '');
          return normalized.toLowerCase();
        };

        if (normalizeGitUrl(existingRepoUrl) === normalizeGitUrl(repoUrl)) {
          throw new UserError(
            `You have already cloned this repository. Run 'chiral use ${projectName}' to switch to it.`,
          );
        }
      } catch {
        // Fall back to standard name collision message
      }
    }

    throw new UserError(
      `A project named "${projectName}" already exists in your registry. Rename it with 'chiral project rename ${projectName} <new-name>' before cloning this repository.`,
    );
  }

  // Rename clone dir to match project name (unless --dir was specified)
  if (!options.dir) {
    const finalDir = join(projectsDir, projectName);
    if (finalDir !== targetDir) {
      if (existsSync(finalDir)) {
        throw new UserError(
          `Directory '${projectName}' already exists. Use --dir to specify a different location.`,
        );
      }
      mkdirSync(projectsDir, { recursive: true });
      renameSync(targetDir, finalDir);
      targetDir = finalDir;
      cleanupDir = finalDir;
    }
  }

  const finalChiralDir = join(targetDir, '.chiral');

  // ── 6. Idempotency check ──────────────────────────────────────────────────
  if (existsSync(join(finalChiralDir, 'config.json'))) {
    console.log(
      `  Credentials already configured. Run 'chiral environment configure' to update them.`,
    );
    registerProject(projectName, targetDir);
    const ppid = process.ppid;
    if (ppid) writeSession(ppid, projectName);
    return;
  }

  // ── 7. Project summary ────────────────────────────────────────────────────
  if (outputMode === 'human') {
    console.log();
    const envNames = Object.keys(example.envs);
    console.log(
      `  ${chalk.bold(projectName)}  ${chalk.dim(`${envNames.length} environment${envNames.length === 1 ? '' : 's'}: ${envNames.join(', ')}`)}`,
    );
    const initEvent = readInitEvent(finalChiralDir);
    if (initEvent) {
      const date = new Date(initEvent.timestamp).toLocaleDateString();
      console.log(`  ${chalk.dim(`Configured by ${initEvent.actor} on ${date}`)}`);
    }
    console.log();
  }

  // ── 7.5 JSON mode: validate all env vars before any state is written ────────
  if (outputMode === 'json') {
    for (const [envName] of Object.entries(example.envs)) {
      const envUpper = envName.toUpperCase();
      const urlVar = `CHIRAL_URL_${envUpper}`;
      const keyVar = `CHIRAL_API_KEY_${envUpper}`;
      if (!process.env[urlVar] || !process.env[keyVar]) {
        throw new UserError(`--json mode requires ${urlVar} and ${keyVar} to be set.`);
      }
    }
  }

  // ── 8. Pre-loop Registration ──────────────────────────────────────────────
  registerProject(projectName, targetDir);
  projectRegistered = true;
  const ppid = process.ppid;
  if (ppid) writeSession(ppid, projectName);

  // ── 9. Credential collection and testing ──────────────────────────────────
  for (const [envName, envExample] of Object.entries(example.envs)) {
    const envUpper = envName.toUpperCase();
    const urlVar = `CHIRAL_URL_${envUpper}`;
    const keyVar = `CHIRAL_API_KEY_${envUpper}`;

    const urlFromEnv = process.env[urlVar];
    const keyFromEnv = process.env[keyVar];

    let url = '';
    let apiKey = '';

    if (urlFromEnv && keyFromEnv) {
      url = urlFromEnv;
      apiKey = keyFromEnv;
    } else {
      // --json mode requires env vars; abort if any are missing
      if (outputMode === 'json') {
        throw new UserError(
          `--json mode requires ${urlVar} and ${keyVar} to be set.`,
        );
      }

      // Interactive prompts
      console.log(`  ${chalk.bold(envName)} environment:`);
      url = await input({
        message: `  n8n URL for ${envName}:`,
        default: envExample.url,
        validate: (v) => {
          try {
            new URL(v);
            return true;
          } catch {
            return 'Please enter a valid URL (e.g. https://n8n.example.com)';
          }
        },
      });

      const keyInput = await password({
        message: `  API key for ${envName}:`,
        mask: '•',
        validate: (v) => v.trim() !== '' || 'API key cannot be empty',
      });
      apiKey = keyInput.trim();
    }

    if (!options.skipTest && outputMode !== 'json') {
      const spinnerTest = ora({ text: '  Testing connection…', color: 'cyan' }).start();
      const client = new N8nClient({ url, apiKey }, envName);
      try {
        const { workflowCount } = await client.testConnection();
        spinnerTest.succeed(chalk.green('  Connected') + chalk.dim(` - ${workflowCount} workflow${workflowCount === 1 ? '' : 's'} found`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spinnerTest.fail(chalk.red(`  ${msg}`));
        if (err instanceof UserError && err.hint) console.error('\n' + err.hint + '\n');
        const proceed = await confirm({ message: '  Save anyway?', default: false });
        if (!proceed) throw new ControlledExit(0);
      }
    }

    collectedEnvs[envName] = { url, apiKey };
    
    // ── Progressive save ──
    const environments: Config['environments'] = {};
    for (const [name, creds] of Object.entries(collectedEnvs)) {
      environments[name] = { url: creds.url, apiKey: creds.apiKey };
    }
    const config: Config = {
      version: 1,
      project: projectName,
      environments,
      ...(example.gitSync !== undefined ? { gitSync: example.gitSync as Config['gitSync'] } : {}),
    };
    writeConfig(finalChiralDir, config);

    if (outputMode !== 'json') {
      console.log();
    }
  }

  // ── 12. Output ────────────────────────────────────────────────────────────
  if (outputMode === 'json') {
    const wfMap = loadWorkflowMap(finalChiralDir);
    const workflowsFound = Object.keys(wfMap.workflows).length;
    console.log(
      JSON.stringify({
        status: 'ok',
        data: {
          project: projectName,
          path: targetDir,
          environments: Object.keys(collectedEnvs),
          workflows_found: workflowsFound,
        },
      }),
    );
  } else {
    const firstEnv = Object.keys(collectedEnvs)[0];
    console.log(`  ${chalk.green('✓')} Credentials saved → ${chalk.dim(`${targetDir}/.chiral/config.json`)}`);
    console.log();
    if (firstEnv) {
      console.log(`  ${chalk.dim('Next:')} chiral pull --env ${firstEnv}`);
    }
    console.log();
  }
  } catch (err) {
    const envsSaved = Object.keys(collectedEnvs).length;
    if (envsSaved === 0) {
      // Atomic abort: No environments saved, clean up completely
      if (projectRegistered && currentProjectName) {
        unregisterProject(currentProjectName);
      }
      if (existsSync(cleanupDir)) {
        rmSync(cleanupDir, { recursive: true, force: true });
      }
    } else {
      // Progressive save partial success
      console.log(
        `\n  ${chalk.yellow('⚠')} Project saved partially. ${envsSaved} environment${envsSaved === 1 ? '' : 's'} configured.`
      );
      if (example) {
        const missingEnvs = Object.keys(example.envs).filter(e => !collectedEnvs[e]);
        if (missingEnvs.length > 0) {
          console.log(`  To configure the rest later, run: ${chalk.cyan(`chiral environment add ${missingEnvs[0]}`)}\n`);
        }
      }
      
      // If the error was an intentional exit, just exit. Otherwise, re-throw to log the real error.
      if (err instanceof ControlledExit) process.exit(err.code);
      if (err instanceof Error && err.name === 'ExitPromptError') process.exit(1);
    }
    throw err;
  }
}

// ── Command definition ────────────────────────────────────────────────────────

export const cloneCommand = new Command('clone')
  .description('Clone a chiral project repo and configure your local credentials')
  .argument('<repo-url>', 'Git repository URL to clone')
  .option('--dir <path>', 'Clone into this directory instead of the default location')
  .option('--skip-test', 'Skip the n8n connection test after entering credentials')
  .option('--json', 'Output machine-readable JSON (requires CHIRAL_URL_<ENV> and CHIRAL_API_KEY_<ENV> env vars)')
  .addHelpText('after', `
Examples:
  Clone a project interactively:
    chiral clone https://github.com/acme/n8n-workflows

  Clone to a specific directory:
    chiral clone https://github.com/acme/n8n-workflows --dir ~/projects/acme

  Clone non-interactively (CI/agent use):
    CHIRAL_URL_DEV=https://dev.n8n.io CHIRAL_API_KEY_DEV=my-key \\
      chiral clone https://github.com/acme/n8n-workflows --json

Exit codes:
  0  Success
  1  General error (bad config, directory exists, git failure)
  2  Usage error (invalid flags)
  `)
  .action(async (repoUrl: string, options: CloneOptions) => {
    await runClone(repoUrl, options);
  });
