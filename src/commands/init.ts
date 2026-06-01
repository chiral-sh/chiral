import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { UserError } from '../lib/errors.js';
import {
  getProjectsDir,
  registerProject,
  projectExists,
  writeSession,
} from '../lib/projects.js';
import { createChiralDirectory } from '../state/init.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InitOptions {
  project?: string;
  noGit?: boolean;
  json?: boolean;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function getGitActor(): string {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    throw new UserError(
      'git config user.email is not set - configure it before running chiral init',
    );
  }
}

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
  console.log(file(`${projectDir}/.chiral/config.example.json`, 'fill in your environments here'));
  console.log(file(`${projectDir}/.chiral/.gitignore`, 'keeps config.json out of git'));
  console.log(file(`${projectDir}/.chiral/credentials.json`));
  console.log(file(`${projectDir}/.chiral/audit.jsonl`));
  console.log(file(`${projectDir}/.chiral/locks/`));
  console.log(file(`${projectDir}/.chiral/snapshots/`));

  if (gitInitDone) {
    console.log(`\n  ${chalk.green('✓')}  Git initialized → ${chalk.dim(projectDir)}`);
  }

  console.log(`\n  ${chalk.dim('Next:')} chiral environment add dev\n`);
}

export const initCommand = new Command('init')
  .description('Create a new managed chiral project')
  .argument('[name]', 'Project name (skips interactive prompt)')
  .option('--project <name>', 'Project name (alternative to positional argument)')
  .option('--no-git', 'Skip automatic git init inside the project folder')
  .option('--json', 'Output result as JSON')
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
`,
  )
  .action(async (nameArg: string | undefined, options: { project?: string; noGit?: boolean; json?: boolean }) => {
    const resolvedName = nameArg ?? options.project;
    await runInit({ project: resolvedName, noGit: options.noGit, json: options.json });
  });
