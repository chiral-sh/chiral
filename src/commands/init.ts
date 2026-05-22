import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
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

async function promptProjectName(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Project name: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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

  let projectName = options.project ?? '';
  if (!projectName) {
    projectName = await promptProjectName();
  }
  if (!projectName) {
    throw new UserError('Project name is required');
  }

  createFlightdeckDirectory(flightdeckDir, projectName);

  console.log('✓ Created .flightdeck/');
  console.log('✓ Created .flightdeck/config.example.json');
  console.log('✓ Created .flightdeck/.gitignore');
  console.log('');
  console.log('Next: copy config.example.json to config.json and fill in your API keys.');
  console.log('Then run: flightdeck adopt --env dev');
}

export const initCommand = new Command('init')
  .description('Initialize .flightdeck/ in the current Git repository')
  .option('--project <name>', 'Project name (skips interactive prompt)')
  .action(async (options) => {
    await runInit(options);
  });
