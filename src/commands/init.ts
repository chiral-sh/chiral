import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { UserError } from '../lib/errors.js';
import { createFlightdeckDirectory } from '../state/init.js';

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function runInit(
  options: { project?: string },
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

  createFlightdeckDirectory(flightdeckDir, projectName);

  const file = (path: string, note?: string) =>
    `  ${chalk.green('✓')}  ${chalk.dim(path)}${note ? '  ' + chalk.dim('— ' + note) : ''}`;

  console.log(`\n  ${chalk.bold(projectName)}\n`);
  console.log(file('.flightdeck/config.example.json', 'fill in your environments here'));
  console.log(file('.flightdeck/.gitignore', 'keeps config.json out of git'));
  console.log(file('.flightdeck/credentials.json'));
  console.log(file('.flightdeck/audit.jsonl'));
  console.log(file('.flightdeck/locks/'));
  console.log(file('.flightdeck/snapshots/'));
  console.log(`\n  ${chalk.dim('Next:')} flightdeck configure\n`);
}

export const initCommand = new Command('init')
  .description('Initialize .flightdeck/ in the current Git repository')
  .option('--project <name>', 'Project name (skips interactive prompt)')
  .action(async (options) => {
    await runInit(options);
  });
