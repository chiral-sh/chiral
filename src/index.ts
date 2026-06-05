#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import chalk from 'chalk';
const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
import { ExitPromptError } from '@inquirer/core';
import { UserError, ControlledExit } from './lib/errors.js';
import { printJsonError, isJsonFlagActive } from './lib/output.js';
import { cloneCommand } from './commands/clone.js';
import { initCommand } from './commands/init.js';
import { adoptCommand } from './commands/adopt.js';
import { pullCommand } from './commands/pull.js';
import { diffCommand } from './commands/diff.js';
import { pushCommand } from './commands/push.js';
import { workflowCommand } from './commands/workflow.js';
import { credentialCommand } from './commands/credential.js';
import { teamCommand } from './commands/team.js';
import { useCommand } from './commands/use.js';
import { projectCommand } from './commands/project.js';
import { environmentCommand } from './commands/environment.js';
import { remoteCommand } from './commands/remote.js';
import { statusCommand } from './commands/status.js';
import { completionCommand, internalCompleteEnvsCommand, internalCompleteWorkflowsCommand } from './commands/completion.js';
import { lockCommand, unlockCommand } from './commands/lock.js';

const program = new Command();

// Align continuation lines under the first line's text. The "  ✗  " prefix is
// 5 columns wide, so any newline-separated lines (e.g. Commander's "(Did you
// mean ...?)" suggestion) must be indented 5 spaces to line up.
function indentContinuation(message: string): string {
  return message.replace(/\n/g, '\n     ');
}

program
  .name('chiral')
  .description('Safer production deployments for self-hosted n8n Community Edition')
  .version(version)
  .option('--debug', 'print full stack trace on unexpected errors')
  .enablePositionalOptions();

program.addCommand(initCommand);
program.addCommand(cloneCommand);
program.addCommand(useCommand);
program.addCommand(projectCommand);
program.addCommand(environmentCommand);
program.addCommand(remoteCommand);
program.addCommand(statusCommand);
program.addCommand(adoptCommand);
program.addCommand(pullCommand);
program.addCommand(diffCommand);
program.addCommand(pushCommand);
program.addCommand(workflowCommand);
program.addCommand(lockCommand);
program.addCommand(unlockCommand);
program.addCommand(credentialCommand);
program.addCommand(teamCommand);
program.addCommand(completionCommand);
program.addCommand(internalCompleteEnvsCommand);
program.addCommand(internalCompleteWorkflowsCommand);

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
    if (isJsonFlagActive()) {
      printJsonError('usage_error', message, false);
    } else {
      console.error(`  ${chalk.red('✗')}  ${indentContinuation(message)}\n`);
    }
    process.exit(1);
  }
  if (err instanceof UserError) {
    const alreadyDisplayed = (err as unknown as Record<string, unknown>).__alreadyDisplayed === true;
    if (!alreadyDisplayed) {
      if (isJsonFlagActive()) {
        printJsonError('user_error', err.message, false);
      } else {
        console.error(`  ${chalk.red('✗')}  ${indentContinuation(err.message)}`);
        if (err.hint) console.error(chalk.dim(err.hint));
        console.error();
      }
    }
    process.exit(1);
  }
  const debug = process.argv.includes('--debug');
  const message = err instanceof Error ? err.message : String(err);
  if (isJsonFlagActive()) {
    printJsonError('unexpected_error', message, false);
  } else {
    console.error(`  ${chalk.red('✗')}  Unexpected error: ${message}\n`);
    if (debug && err instanceof Error && err.stack) {
      console.error(chalk.dim(err.stack));
    }
  }
  process.exit(2);
}
