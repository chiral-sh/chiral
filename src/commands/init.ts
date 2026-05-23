import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { UserError } from '../lib/errors.js';
import { createFlightdeckDirectory } from '../state/init.js';
import type { GitSync } from '../lib/config.js';

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function detectRemote(cwd: string): string | null {
  try {
    const out = execSync('git remote -v', { cwd, encoding: 'utf-8', stdio: 'pipe' });
    const match = out.match(/^(\S+)\s+(\S+)\s+\(fetch\)/m);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

function detectBranch(cwd: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, encoding: 'utf-8', stdio: 'pipe',
    }).trim() || 'main';
  } catch {
    return 'main';
  }
}

export async function runInit(
  options: { project?: string; remote?: string; solo?: boolean },
  cwd: string = process.cwd(),
): Promise<void> {
  if (!isGitRepo(cwd)) {
    throw new UserError('flightdeck init must be run inside a Git repository');
  }

  const flightdeckDir = join(cwd, '.flightdeck');
  if (existsSync(flightdeckDir)) {
    throw new UserError('Already initialized. Delete .flightdeck/ to start over.');
  }

  let projectName = options.project?.trim() ?? '';
  if (!projectName) {
    projectName = await input({
      message: 'Project name:',
      default: basename(cwd),
      validate: (v) => (v.trim() ? true : 'Project name cannot be empty'),
    });
    projectName = projectName.trim();
  }
  if (!projectName) {
    throw new UserError('Project name is required');
  }

  // ── Git sync setup ─────────────────────────────────────────────────────────
  let gitSync: GitSync | undefined;

  if (!options.solo) {
    const detectedBranch = detectBranch(cwd);

    if (options.remote) {
      // Non-interactive: remote provided via flag, branch auto-detected
      gitSync = { enabled: true, remote: options.remote, branch: detectedBranch };
    } else {
      const wantsSync = await confirm({
        message: 'Enable git sync? (auto-commits state changes to your team remote after each operation)',
        default: true,
      });

      if (wantsSync) {
        const detected = detectRemote(cwd);
        const remoteAnswer = await input({
          message: 'Git remote name or URL:',
          default: detected ?? 'origin',
          validate: (v) => (v.trim() ? true : 'Remote cannot be empty'),
        });

        gitSync = {
          enabled: true,
          remote: remoteAnswer.trim(),
          branch: detectedBranch,
        };
      }
    }
  }

  createFlightdeckDirectory(flightdeckDir, projectName, gitSync);

  // ── Output ─────────────────────────────────────────────────────────────────
  const file = (path: string, note?: string) =>
    `  ${chalk.green('✓')}  ${chalk.dim(path)}${note ? '  ' + chalk.dim('— ' + note) : ''}`;

  console.log(`\n  ${chalk.bold(projectName)}\n`);
  console.log(file('.flightdeck/config.example.json', 'fill in your environments here'));
  console.log(file('.flightdeck/.gitignore', 'keeps config.json out of git'));
  console.log(file('.flightdeck/credentials.json'));
  console.log(file('.flightdeck/audit.jsonl'));
  console.log(file('.flightdeck/locks/'));
  console.log(file('.flightdeck/snapshots/'));

  if (gitSync) {
    console.log(
      `\n  ${chalk.green('✓')}  Git sync enabled → ${chalk.cyan(gitSync.remote)} ${chalk.dim(`[${gitSync.branch}]`)}`,
    );
    console.log(chalk.dim('     State changes will be committed and pushed automatically.'));
  }

  console.log(`\n  ${chalk.dim('Next:')} flightdeck configure\n`);
}

export const initCommand = new Command('init')
  .description('Initialize .flightdeck/ in the current Git repository')
  .option('--project <name>', 'Project name (skips interactive prompt)')
  .option('--remote <remote>', 'Git remote name or URL for team sync (skips interactive git sync prompt)')
  .option('--solo', 'Skip git sync setup entirely')
  .addHelpText(
    'after',
    `
Examples:
  Initialize with an interactive project name prompt:
    flightdeck init

  Initialize with a specific project name:
    flightdeck init --project my-n8n

  Initialize with git sync pre-configured:
    flightdeck init --project my-n8n --remote origin

  Initialize without git sync (solo use):
    flightdeck init --solo
`,
  )
  .action(async (options) => {
    await runInit(options);
  });
