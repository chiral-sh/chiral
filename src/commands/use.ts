import chalk from 'chalk';
import { Command } from 'commander';
import { UserError } from '../lib/errors.js';
import {
  listProjects,
  writeSession,
  readSession,
  pruneDeadSessions,
  getProjectPath,
} from '../lib/projects.js';

// ── Run function ───────────────────────────────────────────────────────────────

export async function runUse(projectName?: string, options: { json?: boolean } = {}): Promise<void> {
  pruneDeadSessions();

  const projects = listProjects();
  if (projects.length === 0) {
    throw new UserError("No projects found. Run 'chiral init <name>' to create one.");
  }

  // No argument - show project list with current selection marked
  if (!projectName) {
    const ppid = process.ppid;
    const session = ppid ? readSession(ppid) : null;
    const current = session?.project ?? (projects.length === 1 ? projects[0].name : null);

    if (options.json) {
      const currentPath = current ? getProjectPath(current) : null;
      console.log(JSON.stringify({ status: 'ok', data: { project: current ?? null, path: currentPath ?? null } }));
      return;
    }

    console.log('\n  Projects:\n');
    for (const p of projects) {
      const isCurrent = p.name === current;
      const marker = isCurrent ? chalk.green('*') : ' ';
      const label = isCurrent ? chalk.bold(p.name) : p.name;
      const suffix = isCurrent ? chalk.dim('  (current)') : '';
      console.log(`    ${marker} ${label}${suffix}`);
    }
    console.log();
    return;
  }

  // Find the project case-insensitively
  const lower = projectName.toLowerCase();
  const match = projects.find((p) => p.name.toLowerCase() === lower);
  if (!match) {
    const available = projects.map((p) => p.name).join(', ');
    throw new UserError(
      `Project "${projectName}" not found.\n  Available: ${available}`,
    );
  }

  // Verify the project directory still exists
  const projectPath = getProjectPath(match.name);
  if (!projectPath) {
    throw new UserError(`Project "${match.name}" is registered but its directory is missing.`);
  }

  const ppid = process.ppid;
  if (!ppid) {
    throw new UserError('Cannot determine parent process ID - session scoping is unavailable.');
  }

  writeSession(ppid, match.name);

  if (options.json) {
    console.log(JSON.stringify({ status: 'ok', data: { project: match.name, path: projectPath } }));
    return;
  }

  console.log(
    `\n  ${chalk.green('✓')}  Using project ${chalk.bold(match.name)} ${chalk.dim('(for this terminal session)')}\n`,
  );
}

export const useCommand = new Command('use')
  .description('Select the active project for this terminal session')
  .argument('[name]', 'Project name to activate (lists projects if omitted)')
  .addHelpText(
    'after',
    `
Examples:
  List all projects (show which is current):
    chiral use

  Switch to a project for this terminal session:
    chiral use my-n8n

  Use CHIRAL_PROJECT env var for one-off commands (no session write):
    CHIRAL_PROJECT=my-n8n chiral pull --env dev
`,
  )
  .option('--json', 'Output result as JSON')
  .action(async (nameArg: string | undefined, options: { json?: boolean }) => {
    await runUse(nameArg, options);
  });
