import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  findChiralDir,
  writeConfig,
  loadConfigAndDir,
  readProjectNameFromExample,
  updateExampleGitSync,
  type Config,
  type GitSync,
} from '../lib/config.js';
import { formatAge } from '../lib/cli.js';
import { readAuditLog } from '../state/audit.js';
import { UserError } from '../lib/errors.js';
import { simpleGit } from 'simple-git';

// ── Helpers ────────────────────────────────────────────────────────────────────

interface RemoteState {
  project: string;
  chiralDir: string;
  environments: Record<string, { url: string; apiKey: string }>;
  licenseKey?: string;
  gitSync?: GitSync;
}

function loadRemoteState(): RemoteState {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const configPath = join(chiralDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const { config } = loadConfigAndDir();
      return {
        project: config.project,
        chiralDir,
        environments: config.environments,
        licenseKey: config.licenseKey,
        gitSync: config.gitSync,
      };
    } catch (err) {
      throw new UserError(
        `config.json is invalid and cannot be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const project = readProjectNameFromExample(chiralDir);
  return { project, chiralDir, environments: {} };
}

function saveRemoteState(state: RemoteState): void {
  const config: Config = {
    version: 1,
    project: state.project,
    environments: state.environments,
    ...(state.licenseKey !== undefined ? { licenseKey: state.licenseKey } : {}),
    ...(state.gitSync ? { gitSync: state.gitSync } : {}),
  };
  writeConfig(state.chiralDir, config);

  // Mirror gitSync into config.example.json so cloners see the remote
  updateExampleGitSync(state.chiralDir, state.gitSync);
}

function getLastSync(chiralDir: string): string {
  try {
    const entries = readAuditLog(chiralDir);
    const last = entries.filter((e) => e.result === 'success').at(-1);
    if (!last) return 'never';
    const ageSeconds = (Date.now() - new Date(last.timestamp).getTime()) / 1000;
    if (ageSeconds < 60) return 'just now';
    return formatAge(ageSeconds, 'long');
  } catch {
    return 'unknown';
  }
}

// ── remote (no subcommand) ─────────────────────────────────────────────────────

export async function runRemoteStatus(): Promise<void> {
  const state = loadRemoteState();
  const gs = state.gitSync;

  console.log(`\n  ${chalk.bold('Git sync')}\n`);

  if (!gs) {
    console.log(chalk.dim('  Not configured. Run \'chiral remote set\' to set up a remote.\n'));
    return;
  }

  const statusLabel = gs.enabled ? chalk.green('✓ enabled') : chalk.yellow('⚠ disabled');
  const lastSync = getLastSync(state.chiralDir);

  console.log(`  remote   ${chalk.cyan(gs.remote)}`);
  console.log(`  branch   ${chalk.cyan(gs.branch)}`);
  console.log(`  status   ${statusLabel}`);
  console.log(chalk.dim(`\n  Last sync: ${lastSync}\n`));
}

// ── remote set ─────────────────────────────────────────────────────────────────

export async function runRemoteSet(options: { url?: string; branch?: string }): Promise<void> {
  const state = loadRemoteState();
  const existing = state.gitSync;

  let remote = options.url;
  let branch = options.branch;

  const git = simpleGit(resolve(state.chiralDir, '..'));

  let currentBranch = 'main';
  try {
    const branches = await git.branchLocal();
    if (branches.current) {
      currentBranch = branches.current;
    }
  } catch {
    // ignore
  }

  // Interactive mode when neither flag is provided
  let isInteractive = false;
  if (!remote && !branch) {
    isInteractive = true;
    remote = await input({
      message: 'Git remote URL or name:',
      default: existing?.remote ?? 'origin',
      validate: (v) => (v.trim() ? true : 'Remote cannot be empty'),
    });
  }

  if (!remote && !isInteractive && !existing?.remote) {
    throw new UserError(
      "No remote configured. Pass --url to set one, or run 'chiral remote set' for interactive setup.",
    );
  }

  // If we have a remote but no branch, try to detect the remote's default branch
  if (remote && !branch) {
    let detectedBranch = currentBranch;
    try {
      const remoteInfo = await git.listRemote(['--symref', remote.trim(), 'HEAD']);
      const match = remoteInfo.match(/ref: refs\/heads\/([^\s]+)\s+HEAD/);
      if (match) {
        detectedBranch = match[1];
      }
    } catch {
      // ignore
    }

    if (isInteractive) {
      branch = await input({
        message: 'Branch:',
        default: existing?.branch ?? detectedBranch,
        validate: (v) => (v.trim() ? true : 'Branch cannot be empty'),
      });
    } else {
      branch = detectedBranch;
    }
  }

  state.gitSync = {
    enabled: existing?.enabled ?? true,
    remote: (remote ?? existing?.remote ?? 'origin').trim(),
    branch: (branch ?? existing?.branch ?? currentBranch).trim(),
  };
  saveRemoteState(state);

  console.log(
    `\n  ${chalk.green('✓')}  Git sync configured → ${chalk.cyan(state.gitSync.remote)} ${chalk.dim(`[${state.gitSync.branch}]`)}\n`,
  );
}

// ── remote enable ──────────────────────────────────────────────────────────────

export async function runRemoteEnable(): Promise<void> {
  const state = loadRemoteState();

  if (!state.gitSync) {
    throw new UserError("No remote configured. Run 'chiral remote set' first.");
  }

  state.gitSync = { ...state.gitSync, enabled: true };
  saveRemoteState(state);

  console.log(
    `\n  ${chalk.green('✓')}  Git sync enabled → ${chalk.cyan(state.gitSync.remote)} ${chalk.dim(`[${state.gitSync.branch}]`)}\n`,
  );
}

// ── remote disable ─────────────────────────────────────────────────────────────

export async function runRemoteDisable(): Promise<void> {
  const state = loadRemoteState();

  if (!state.gitSync) {
    throw new UserError("No remote configured. Nothing to disable.");
  }

  state.gitSync = { ...state.gitSync, enabled: false };
  saveRemoteState(state);

  console.log(
    `\n  ${chalk.yellow('⚠')}  Git sync disabled. Run 'chiral remote enable' to resume.\n`,
  );
}

// ── remote remove ──────────────────────────────────────────────────────────────

export async function runRemoteRemove(options: { yes?: boolean }): Promise<void> {
  const state = loadRemoteState();

  if (!state.gitSync) {
    throw new UserError("No remote configured. Nothing to remove.");
  }

  if (!options.yes) {
    await input({
      message: 'Type "remove" to confirm:',
      validate: (v) => v === 'remove' || 'Type exactly "remove" to confirm',
    });
  }

  delete state.gitSync;
  saveRemoteState(state);

  console.log(
    `\n  ${chalk.green('✓')}  Git sync removed. Run 'chiral remote set' to configure a new remote.\n`,
  );
}

// ── Command definitions ────────────────────────────────────────────────────────

export const remoteCommand = new Command('remote')
  .description('Manage git sync configuration for the active project')
  .action(async () => {
    await runRemoteStatus();
  });

remoteCommand
  .command('set')
  .description('Set or update the git remote and/or branch')
  .option('--url <url>', 'Git remote URL or name')
  .option('--branch <branch>', 'Branch to sync to')
  .addHelpText('after', `
Examples:
  Interactive setup:
    chiral remote set

  Set URL only:
    chiral remote set --url https://github.com/org/repo.git

  Set branch only:
    chiral remote set --branch develop
`)
  .action(async (options: { url?: string; branch?: string }) => {
    await runRemoteSet(options);
  });

remoteCommand
  .command('enable')
  .description('Re-enable git sync (uses saved config)')
  .addHelpText('after', `
Examples:
  Re-enable git sync:
    chiral remote enable
`)
  .action(async () => {
    await runRemoteEnable();
  });

remoteCommand
  .command('disable')
  .description('Pause git sync (keeps config intact)')
  .addHelpText('after', `
Examples:
  Pause git sync without removing config:
    chiral remote disable
`)
  .action(async () => {
    await runRemoteDisable();
  });

remoteCommand
  .command('remove')
  .description('Remove the git sync configuration entirely')
  .option('--yes', 'Skip type-to-confirm prompt')
  .addHelpText('after', `
Examples:
  Remove git sync config (will prompt to confirm):
    chiral remote remove

  Skip confirmation:
    chiral remote remove --yes
`)
  .action(async (options: { yes?: boolean }) => {
    await runRemoteRemove(options);
  });
