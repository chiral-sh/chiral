import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { UserError } from '../lib/errors.js';
import { createChiralDirectory } from '../state/init.js';
import type { GitSync } from '../lib/config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InitOptions {
  project?: string;
  remote?: string;
  solo?: boolean;
}

// ── Validation ────────────────────────────────────────────────────────────────

// Flag interaction matrix:
//   --project  : composes with everything — just skips the name prompt
//   --remote   : sets up git sync non-interactively; mutually exclusive with --solo
//   --solo     : skips git sync setup entirely; mutually exclusive with --remote
function validateOptions(options: InitOptions): void {
  if (options.remote && options.solo) {
    throw new UserError(
      '--remote and --solo cannot be used together — --remote sets up git sync, --solo skips it',
    );
  }
}

// ── Git helpers ───────────────────────────────────────────────────────────────

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
  options: InitOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  validateOptions(options);

  if (!isGitRepo(cwd)) {
    throw new UserError('chiral init must be run inside a Git repository');
  }

  const chiralDir = join(cwd, '.chiral');
  if (existsSync(chiralDir)) {
    throw new UserError('Already initialized. Delete .chiral/ to start over.');
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

  createChiralDirectory(chiralDir, projectName, gitSync);

  // ── Output ─────────────────────────────────────────────────────────────────
  const file = (path: string, note?: string) =>
    `  ${chalk.green('✓')}  ${chalk.dim(path)}${note ? '  ' + chalk.dim('— ' + note) : ''}`;

  console.log(`\n  ${chalk.bold(projectName)}\n`);
  console.log(file('.chiral/config.example.json', 'fill in your environments here'));
  console.log(file('.chiral/.gitignore', 'keeps config.json out of git'));
  console.log(file('.chiral/credentials.json'));
  console.log(file('.chiral/audit.jsonl'));
  console.log(file('.chiral/locks/'));
  console.log(file('.chiral/snapshots/'));

  if (gitSync) {
    console.log(
      `\n  ${chalk.green('✓')}  Git sync enabled → ${chalk.cyan(gitSync.remote)} ${chalk.dim(`[${gitSync.branch}]`)}`,
    );
    console.log(chalk.dim('     State changes will be committed and pushed automatically.'));
  }

  console.log(`\n  ${chalk.dim('Next:')} chiral configure\n`);
}

export const initCommand = new Command('init')
  .description('Initialize .chiral/ in the current Git repository')
  .option('--project <name>', 'Project name (skips interactive prompt)')
  .option('--remote <remote>', 'Git remote name or URL for team sync (skips interactive git sync prompt)')
  .option('--solo', 'Skip git sync setup entirely')
  .addHelpText(
    'after',
    `
Flag combinations:
  --remote and --solo are mutually exclusive — --remote sets up git sync, --solo skips it.
  --project composes with any other flag.

Examples:
  Initialize with an interactive project name prompt:
    chiral init

  Initialize with a specific project name:
    chiral init --project my-n8n

  Initialize with git sync pre-configured:
    chiral init --project my-n8n --remote origin

  Initialize without git sync (solo use):
    chiral init --solo
`,
  )
  .action(async (options) => {
    await runInit(options);
  });
