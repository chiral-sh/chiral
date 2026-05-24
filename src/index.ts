#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { ExitPromptError } from '@inquirer/core';
import { UserError, ControlledExit } from './lib/errors.js';
import { initCommand } from './commands/init.js';
import { adoptCommand } from './commands/adopt.js';
import { configureCommand } from './commands/configure.js';
import { pullCommand } from './commands/pull.js';
import { diffCommand } from './commands/diff.js';
import { pushCommand } from './commands/push.js';
import { workflowCommand } from './commands/workflow.js';

const program = new Command();

program
  .name('flightdeck')
  .description('Safer production deployments for self-hosted n8n Community Edition')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(configureCommand);
program.addCommand(adoptCommand);
program.addCommand(pullCommand);
program.addCommand(diffCommand);
program.addCommand(pushCommand);
program.addCommand(workflowCommand);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof ExitPromptError) {
    console.error('\n  Cancelled.\n');
    process.exit(130);
  }
  if (err instanceof ControlledExit) {
    process.exit(err.code);
  }
  if (err instanceof UserError) {
    console.error(`\n  ${chalk.red('✗')}  ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${chalk.red('✗')}  Unexpected error: ${message}\n`);
  process.exit(2);
}
