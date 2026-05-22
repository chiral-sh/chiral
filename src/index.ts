#!/usr/bin/env node
import { Command } from 'commander';
import { UserError } from './lib/errors.js';
import { initCommand } from './commands/init.js';
import { adoptCommand } from './commands/adopt.js';

const program = new Command();

program
  .name('flightdeck')
  .description('Safer production deployments for self-hosted n8n Community Edition')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(adoptCommand);
// program.addCommand(pullCommand);
// program.addCommand(diffCommand);
// program.addCommand(pushCommand);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof UserError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${message}`);
  process.exit(2);
}
