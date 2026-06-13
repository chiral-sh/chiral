import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { UserError } from '../lib/errors.js';
import { getGitActor } from '../lib/git.js';
import {
  getProjectsDir,
  registerProject,
  projectExists,
  writeSession,
} from '../lib/projects.js';
import { createChiralDirectory } from '../state/init.js';
import { generateScript, getInstallPath, getChiralCommands } from '../lib/completion.js';

const CHIRAL_VERSION = '0.1.0';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InitOptions {
  project?: string;
  noGit?: boolean;
  json?: boolean;
  installCompletion?: boolean;
  noInstallCompletion?: boolean;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function isGitInstalled(): boolean {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function runGitInit(dir: string): void {
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
  } catch {
    // non-fatal - user can run git init themselves
  }
}

// ── Run function ──────────────────────────────────────────────────────────────

export async function runInit(options: InitOptions): Promise<void> {
  // Determine project name
  let projectName = options.project?.trim() ?? '';
  if (!projectName) {
    projectName = await input({
      message: 'Project name:',
      validate: (v) => {
        if (!v.trim()) return 'Project name cannot be empty';
        if (/[/\\:*?"<>|]/.test(v)) return 'Project name cannot contain / \\ : * ? " < > |';
        return true;
      },
    });
    projectName = projectName.trim();
  }
  if (!projectName) throw new UserError('Project name is required');
  if (/[/\\:*?"<>|]/.test(projectName)) {
    throw new UserError(`Invalid project name: "${projectName}"`);
  }

  const ownerEmail = getGitActor();

  // Free tier: enforce 1-project limit (no license check yet - placeholder)
  // TODO: re-enable once paid tier / license gate is wired up (see CLAUDE.md Phase 5)
  // const projectCount = getProjectCount();
  // if (projectCount >= 1) {
  //   throw new UserError(
  //     `Free tier allows 1 project. You already have ${projectCount} project${projectCount === 1 ? '' : 's'}.\n` +
  //     `  Run 'chiral project list' to see your projects, or upgrade to create more.`,
  //   );
  // }

  // Case-insensitive collision check
  if (projectExists(projectName)) {
    throw new UserError(
      `A project named "${projectName}" already exists. Run 'chiral project list' to see your projects.`,
    );
  }

  // Create directory under global projects dir
  const projectsDir = getProjectsDir();
  const projectDir = join(projectsDir, projectName);
  if (existsSync(projectDir)) {
    throw new UserError(
      `Directory "${projectDir}" already exists. Choose a different project name or remove the directory.`,
    );
  }

  mkdirSync(projectDir, { recursive: true });

  const chiralDir = join(projectDir, '.chiral');
  createChiralDirectory(chiralDir, projectName, undefined, ownerEmail);

  // Register in global index and auto-select for this terminal session
  registerProject(projectName, projectDir);
  const ppid = process.ppid;
  if (ppid) writeSession(ppid, projectName);

  // Run git init unless --no-git or git not installed
  let gitInitDone = false;
  if (!options.noGit && isGitInstalled()) {
    runGitInit(projectDir);
    gitInitDone = true;
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  if (options.json) {
    console.log(JSON.stringify({ status: 'ok', data: { project: projectName, path: projectDir, created: true } }));
    return;
  }

  const file = (path: string, note?: string) =>
    `  ${chalk.green('✓')}  ${chalk.dim(path)}${note ? '  ' + chalk.dim('- ' + note) : ''}`;

  console.log(`\n  ${chalk.bold(projectName)}\n`);
  console.log(file(`${projectDir}/.chiral/config.example.json`));
  console.log(file(`${projectDir}/.chiral/.gitignore`, 'keeps config.json out of git'));
  console.log(file(`${projectDir}/.chiral/credentials.json`));
  console.log(file(`${projectDir}/.chiral/audit.jsonl`));
  console.log(file(`${projectDir}/.chiral/locks/`));
  console.log(file(`${projectDir}/.chiral/snapshots/`));

  if (gitInitDone) {
    console.log(`\n  ${chalk.green('✓')}  Git initialized → ${chalk.dim(projectDir)}`);
  }

  if (!options.noInstallCompletion && !options.json) {
    const shellEnv = process.env['SHELL'];
    if (shellEnv) {
      const shellName = basename(shellEnv);
      if (['bash', 'zsh', 'fish'].includes(shellName)) {
        try {
          let shouldInstall = options.installCompletion ?? false;
          if (!shouldInstall && process.stdout.isTTY) {
            shouldInstall = await confirm({
              message: 'Enable tab completion for chiral?',
              default: true,
            });
          }
          if (shouldInstall) {
            const commands = getChiralCommands();
            const script = generateScript(shellName, commands, CHIRAL_VERSION);
            const installPath = getInstallPath(shellName);
            mkdirSync(dirname(installPath), { recursive: true });
            writeFileSync(installPath, script, 'utf-8');
            console.log(`  ${chalk.green('✓')}  Tab completion enabled → ${chalk.dim(installPath)}`);
            if (shellName === 'zsh') {
              const home = dirname(dirname(installPath));
              const zshrc = join(home, '.zshrc');
              const hasEntry = existsSync(zshrc) && readFileSync(zshrc, 'utf-8').includes('fpath=(~/.zfunc');
              if (!hasEntry) {
                console.log('');
                console.log('  Add this line to ~/.zshrc to enable completions:');
                console.log('    fpath=(~/.zfunc $fpath)');
                console.log('    autoload -Uz compinit && compinit');
              }
            }
          }
        } catch {
          // silently skip - init must never fail due to completion setup
        }
      }
    }
  }

  console.log(`\n  ${chalk.dim('Next:')} chiral environment add dev\n`);
}

export const initCommand = new Command('init')
  .description('Create a new managed chiral project')
  .argument('[name]', 'Project name (skips interactive prompt)')
  .option('--project <name>', 'Project name (alternative to positional argument)')
  .option('--no-git', 'Skip automatic git init inside the project folder')
  .option('--json', 'Output result as JSON')
  .option('--install-completion', 'Install shell completion without prompting (non-interactive)')
  .option('--no-install-completion', 'Skip the tab completion prompt')
  .addHelpText(
    'after',
    `
Examples:
  Create a project interactively:
    chiral init

  Create a project with a specific name:
    chiral init my-n8n

  Create without running git init:
    chiral init my-n8n --no-git

  Create and auto-install completion without prompting (CI / scripts):
    chiral init my-n8n --install-completion
`,
  )
  .action(async (nameArg: string | undefined, options: { project?: string; noGit?: boolean; json?: boolean; installCompletion?: boolean; noInstallCompletion?: boolean }) => {
    const resolvedName = nameArg ?? options.project;
    await runInit({ project: resolvedName, noGit: options.noGit, json: options.json, installCompletion: options.installCompletion, noInstallCompletion: options.noInstallCompletion });
  });
