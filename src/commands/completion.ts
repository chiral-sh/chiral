import { Command } from 'commander';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { generateScript, getInstallPath, getChiralCommands } from '../lib/completion.js';
import { loadConfigAndDir } from '../lib/config.js';
import { UserError } from '../lib/errors.js';

const VERSION = '0.1.0';

export interface CompletionOptions {
  install?: boolean;
}

export async function runCompletion(shell: string, options: CompletionOptions): Promise<void> {
  const commands = getChiralCommands();
  const script = generateScript(shell, commands, VERSION);

  if (!options.install) {
    process.stdout.write(script);
    return;
  }

  const installPath = getInstallPath(shell);
  const installDir = path.dirname(installPath);

  try {
    mkdirSync(installDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UserError(`Failed to create directory "${installDir}": ${msg}`);
  }

  try {
    writeFileSync(installPath, script, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UserError(`Failed to write completion script to ${installPath}: ${msg}`);
  }

  console.log(`  ✓ Completion script installed → ${installPath}`);

  if (shell === 'zsh') {
    const home = path.dirname(path.dirname(installPath));
    const zshrc = path.join(home, '.zshrc');
    const hasEntry = existsSync(zshrc) && readFileSync(zshrc, 'utf-8').includes('fpath=(~/.zfunc');
    if (!hasEntry) {
      console.log('');
      console.log('  Add this line to ~/.zshrc to enable completions:');
      console.log('    fpath=(~/.zfunc $fpath)');
      console.log('    autoload -Uz compinit && compinit');
    }
  }
}

export async function runCompleteEnvs(): Promise<void> {
  try {
    const { config } = loadConfigAndDir();
    process.stdout.write(Object.keys(config.environments).join('\n') + '\n');
  } catch {
    process.exit(0);
  }
}

export const completionCommand = new Command('completion')
  .description('Print shell completion script for bash, zsh, or fish')
  .argument('<shell>', 'Shell type: bash, zsh, or fish')
  .option('--install', 'Write the script to the user-local path instead of printing it')
  .action(async (shell: string, options: CompletionOptions) => {
    await runCompletion(shell, options);
  });

export const internalCompleteEnvsCommand = new Command('_complete_envs')
  .helpOption(false)
  .addHelpCommand(false)
  .action(async () => {
    await runCompleteEnvs();
  });
