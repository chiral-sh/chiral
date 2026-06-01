#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import chalk from 'chalk';
import { ExitPromptError } from '@inquirer/core';
import { UserError, ControlledExit } from './lib/errors.js';
import { cloneCommand } from './commands/clone.js';
import { initCommand } from './commands/init.js';
import { adoptCommand } from './commands/adopt.js';
import { pullCommand } from './commands/pull.js';
import { diffCommand } from './commands/diff.js';
import { pushCommand } from './commands/push.js';
import { workflowCommand } from './commands/workflow.js';
import { credentialCommand } from './commands/credential.js';
import { useCommand } from './commands/use.js';
import { projectCommand } from './commands/project.js';
import { environmentCommand } from './commands/environment.js';
import { remoteCommand } from './commands/remote.js';

const program = new Command();

program
  .name('chiral')
  .description('Safer production deployments for self-hosted n8n Community Edition')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(cloneCommand);
program.addCommand(useCommand);
program.addCommand(projectCommand);
program.addCommand(environmentCommand);
program.addCommand(remoteCommand);
program.addCommand(adoptCommand);
program.addCommand(pullCommand);
program.addCommand(diffCommand);
program.addCommand(pushCommand);
program.addCommand(workflowCommand);
program.addCommand(credentialCommand);

// Global protection against Commander eagerly eating flags as option values.
// Catches cases like `--remote --solo` where Commander assigns '--solo' as the
// string value for --remote instead of rejecting it.
program.hook('preAction', (_thisCmd, actionCmd) => {
  const opts = actionCmd.opts();
  for (const [key, value] of Object.entries(opts)) {
    if (typeof value === 'string' && value.startsWith('-')) {
      const opt = actionCmd.options.find((o) => o.attributeName() === key);
      const flagName = opt ? (opt.long || opt.short || key) : key;
      throw new UserError(
        `Option '${flagName}' requires a value, but received '${value}' which looks like another flag. Did you forget to provide a value?`,
      );
    }
  }
});

// addCommand() does not call copyInheritedSettings, so _exitCallback and
// _outputConfiguration are not inherited by subcommands. Apply both recursively
// after all commands are registered so Commander routes parse errors (conflicts,
// missing args, unknown flags) through our catch block instead of writing its
// own "error: ..." to stderr and calling process.exit directly.
function configureErrorHandling(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({ outputError: () => { } });
  for (const sub of cmd.commands) {
    configureErrorHandling(sub);
  }
}
configureErrorHandling(program);

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
  if (err instanceof CommanderError) {
    if (err.exitCode === 0 || err.code === 'commander.help') process.exit(0); // --help, --version, no-subcommand: output already written
    // Commander bakes "error: " into the message - strip it for our formatter
    const message = err.message.replace(/^error:\s*/, '');
    console.error(`\n  ${chalk.red('✗')}  ${message}\n`);
    process.exit(1);
  }
  if (err instanceof UserError) {
    console.error(`\n  ${chalk.red('✗')}  ${err.message}`);
    if (err.hint) console.error(chalk.dim(err.hint));
    console.error();
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${chalk.red('✗')}  Unexpected error: ${message}\n`);
  process.exit(2);
}
