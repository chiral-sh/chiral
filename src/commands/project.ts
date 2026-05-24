import { rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { UserError } from '../lib/errors.js';
import {
  listProjects,
  unregisterProject,
  renameProjectInIndex,
  clearSessionsForProject,
  readSession,
  pruneDeadSessions,
  getProjectPath,
  getProjectsDir,
} from '../lib/projects.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padRight(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - visibleLen(s)));
}

// ── project list ───────────────────────────────────────────────────────────────

export async function runProjectList(): Promise<void> {
  pruneDeadSessions();

  const projects = listProjects();
  if (projects.length === 0) {
    console.log("\n  No projects. Run 'chiral init <name>' to create one.\n");
    return;
  }

  const ppid = process.ppid;
  const session = ppid ? readSession(ppid) : null;
  const current = session?.project ?? (projects.length === 1 ? projects[0]!.name : null);

  const C_NAME = Math.max(7, ...projects.map((p) => p.name.length)) + 2;
  const C_PATH = Math.min(50, Math.max(10, ...projects.map((p) => p.path.length))) + 2;

  const bar = (l: string, s: string, r: string) =>
    `  ${l}${'─'.repeat(C_NAME + 2)}${s}${'─'.repeat(C_PATH + 2)}${s}${'─'.repeat(21)}${r}`;
  const row = (n: string, p: string, d: string) =>
    `  │ ${padRight(n, C_NAME)} │ ${padRight(p, C_PATH)} │ ${padRight(d, 19)} │`;

  console.log();
  console.log(bar('┌', '┬', '┐'));
  console.log(row(chalk.dim('name'), chalk.dim('path'), chalk.dim('created')));
  console.log(bar('├', '┼', '┤'));
  for (const p of projects) {
    const isCurrent = p.name === current;
    const nameCell = isCurrent ? chalk.bold(p.name) + chalk.green(' *') : p.name;
    const pathCell = chalk.dim(p.path.length > C_PATH ? '…' + p.path.slice(-(C_PATH - 1)) : p.path);
    const dateCell = chalk.dim(p.createdAt.slice(0, 10));
    console.log(row(nameCell, pathCell, dateCell));
  }
  console.log(bar('└', '┴', '┘'));
  console.log();
}

// ── project current ────────────────────────────────────────────────────────────

export async function runProjectCurrent(): Promise<void> {
  pruneDeadSessions();

  const projects = listProjects();
  if (projects.length === 0) {
    throw new UserError("No projects. Run 'chiral init <name>' to create one.");
  }

  const ppid = process.ppid;
  const session = ppid ? readSession(ppid) : null;

  if (session?.project) {
    console.log(`\n  ${chalk.bold(session.project)} ${chalk.dim('(session)')}\n`);
    return;
  }
  if (projects.length === 1) {
    console.log(`\n  ${chalk.bold(projects[0]!.name)} ${chalk.dim('(only project)')}\n`);
    return;
  }
  throw new UserError(
    `No active project. Run 'chiral use <name>' to select one.\n  Available: ${projects.map((p) => p.name).join(', ')}`,
  );
}

// ── project rename ─────────────────────────────────────────────────────────────

export async function runProjectRename(oldName: string, newName: string): Promise<void> {
  const oldPath = getProjectPath(oldName);
  if (!oldPath) {
    throw new UserError(`Project "${oldName}" not found. Run 'chiral project list' to see projects.`);
  }

  if (!newName.trim()) throw new UserError('New project name cannot be empty');
  if (/[/\\:*?"<>|]/.test(newName)) throw new UserError(`Invalid project name: "${newName}"`);

  const newPath = join(getProjectsDir(), newName);
  if (existsSync(newPath) && newPath !== oldPath) {
    throw new UserError(`Directory "${newPath}" already exists. Choose a different name.`);
  }

  // Rename directory on disk
  renameSync(oldPath, newPath);

  // Update index (throws if name conflict)
  try {
    renameProjectInIndex(oldName, newName);
  } catch (err) {
    // Roll back directory rename
    renameSync(newPath, oldPath);
    throw err;
  }

  // Update any session files pointing to the old name
  clearSessionsForProject(oldName);

  console.log(
    `\n  ${chalk.green('✓')}  Renamed ${chalk.bold(oldName)} → ${chalk.bold(newName)}\n`,
  );
}

// ── project delete ─────────────────────────────────────────────────────────────

export async function runProjectDelete(name: string, options: { yes?: boolean }): Promise<void> {
  const projectPath = getProjectPath(name);
  if (!projectPath) {
    throw new UserError(`Project "${name}" not found. Run 'chiral project list' to see projects.`);
  }

  if (!options.yes) {
    const confirmed = await input({
      message: `Type "${name}" to confirm deletion:`,
      validate: (v) => v === name || `Type exactly "${name}" to confirm`,
    });
    if (confirmed !== name) {
      console.log('\n  Cancelled.\n');
      return;
    }
  }

  // Remove directory
  if (existsSync(projectPath)) {
    rmSync(projectPath, { recursive: true, force: true });
  }

  // Unregister from index
  unregisterProject(name);

  // Clear sessions pointing to this project
  clearSessionsForProject(name);

  console.log(`\n  ${chalk.green('✓')}  Deleted project ${chalk.bold(name)}\n`);
}

// ── Command definitions ────────────────────────────────────────────────────────

export const projectCommand = new Command('project')
  .description('Manage chiral projects');

projectCommand
  .command('list')
  .description('List all projects')
  .addHelpText('after', `
Examples:
  List all projects:
    chiral project list
`)
  .action(async () => {
    await runProjectList();
  });

projectCommand
  .command('current')
  .description('Show the active project for this terminal session')
  .addHelpText('after', `
Examples:
  Show the active project:
    chiral project current
`)
  .action(async () => {
    await runProjectCurrent();
  });

projectCommand
  .command('rename <old-name> <new-name>')
  .description('Rename a project')
  .addHelpText('after', `
Examples:
  Rename a project:
    chiral project rename my-n8n production-n8n
`)
  .action(async (oldName: string, newName: string) => {
    await runProjectRename(oldName, newName);
  });

projectCommand
  .command('delete <name>')
  .description('Delete a project (removes all files — irreversible)')
  .option('--yes', 'Skip type-to-confirm prompt')
  .addHelpText('after', `
Examples:
  Delete a project (will prompt to type name to confirm):
    chiral project delete my-n8n

  Skip type-to-confirm:
    chiral project delete my-n8n --yes
`)
  .action(async (name: string, options: { yes?: boolean }) => {
    await runProjectDelete(name, options);
  });
