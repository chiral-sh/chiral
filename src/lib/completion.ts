import os from 'node:os';
import path from 'node:path';
import { UserError } from './errors.js';

export interface FlagInfo {
  long: string;
  description: string;
  takesValue: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
  flags: FlagInfo[];
}

export function getChiralCommands(): CommandInfo[] {
  return [
    {
      name: 'init',
      description: 'Initialize a new chiral project',
      flags: [
        { long: '--project', description: 'Project name', takesValue: true },
        { long: '--no-git', description: 'Skip automatic git init', takesValue: false },
        { long: '--json', description: 'Output result as JSON', takesValue: false },
      ],
    },
    {
      name: 'clone',
      description: 'Clone an existing chiral project from a git repository',
      flags: [
        { long: '--dir', description: 'Clone into this directory', takesValue: true },
        { long: '--skip-test', description: 'Skip the n8n connection test', takesValue: false },
        { long: '--json', description: 'Output machine-readable JSON', takesValue: false },
      ],
    },
    {
      name: 'use',
      description: 'Switch the active chiral project',
      flags: [
        { long: '--json', description: 'Output result as JSON', takesValue: false },
      ],
    },
    {
      name: 'project',
      description: 'Manage chiral projects',
      flags: [
        { long: '--json', description: 'Output result as JSON', takesValue: false },
        { long: '--yes', description: 'Skip type-to-confirm prompt', takesValue: false },
      ],
    },
    {
      name: 'environment',
      description: 'Manage n8n environments within a project',
      flags: [
        { long: '--url', description: 'n8n instance URL', takesValue: true },
        { long: '--api-key', description: 'n8n API key', takesValue: true },
        { long: '--skip-test', description: 'Skip the connection test', takesValue: false },
        { long: '--json', description: 'Output result as JSON', takesValue: false },
        { long: '--yes', description: 'Skip confirmation prompt', takesValue: false },
        { long: '--dry-run', description: 'Show what would be deleted without making changes', takesValue: false },
      ],
    },
    {
      name: 'remote',
      description: 'Configure git remote for sync',
      flags: [
        { long: '--url', description: 'Git remote URL or name', takesValue: true },
        { long: '--branch', description: 'Branch to sync to', takesValue: true },
        { long: '--yes', description: 'Skip type-to-confirm prompt', takesValue: false },
      ],
    },
    {
      name: 'adopt',
      description: 'Adopt an existing n8n environment into chiral management',
      flags: [
        { long: '--env', description: 'Environment name', takesValue: true },
        { long: '--json', description: 'Output result as JSON', takesValue: false },
      ],
    },
    {
      name: 'pull',
      description: 'Sync workflow snapshots from an n8n environment',
      flags: [
        { long: '--env', description: 'Environment to pull from', takesValue: true },
        { long: '--tag', description: 'Only pull workflows with this tag', takesValue: true },
        { long: '--pattern', description: 'Glob pattern matched against workflow names', takesValue: true },
        { long: '--id', description: 'Pull a single workflow by its n8n ID', takesValue: true },
        { long: '--verbose', description: 'Expand updated workflows named node changes', takesValue: false },
        { long: '--no-pager', description: 'Disable the pager', takesValue: false },
        { long: '--only-active', description: 'Only pull currently active workflows', takesValue: false },
        { long: '--name-only', description: 'Print only changed workflow names', takesValue: false },
        { long: '--json', description: 'Output a machine-readable JSON summary', takesValue: false },
        { long: '--exit-code', description: 'Exit 1 if changes were detected', takesValue: false },
      ],
    },
    {
      name: 'diff',
      description: 'Show differences between two n8n environments',
      flags: [
        { long: '--source', description: 'Source environment', takesValue: true },
        { long: '--target', description: 'Target environment', takesValue: true },
        { long: '--tag', description: 'Filter to workflows with this tag', takesValue: true },
        { long: '--pattern', description: 'Glob pattern matched against workflow names', takesValue: true },
        { long: '--show-unchanged', description: 'Include identical workflows in output', takesValue: false },
        { long: '--name-only', description: 'Print only differing workflow names', takesValue: false },
        { long: '--json', description: 'Output a machine-readable JSON summary', takesValue: false },
        { long: '--explain', description: 'Drill into one modified workflow named node changes', takesValue: true },
        { long: '--verbose', description: 'Expand all modified workflows named node changes', takesValue: false },
        { long: '--no-pager', description: 'Disable the pager', takesValue: false },
        { long: '--exit-code', description: 'Exit 1 if any differences found', takesValue: false },
      ],
    },
    {
      name: 'push',
      description: 'Push local workflow snapshots to an n8n environment',
      flags: [
        { long: '--source', description: 'Source environment', takesValue: true },
        { long: '--target', description: 'Target environment', takesValue: true },
        { long: '--dry-run', description: 'Preview changes only - no writes made', takesValue: false },
        { long: '--tag', description: 'Only push workflows with this tag', takesValue: true },
        { long: '--pattern', description: 'Glob pattern matched against workflow names', takesValue: true },
        { long: '--json', description: 'Output machine-readable JSON', takesValue: false },
        { long: '--yes', description: 'Skip all confirmation prompts', takesValue: false },
        { long: '--no-activate', description: 'Do not reactivate workflows after push', takesValue: false },
        { long: '--gated', description: 'Gate push on smoke tests passing (paid)', takesValue: false },
      ],
    },
    {
      name: 'workflow',
      description: 'Manage workflow logical name mappings',
      flags: [
        { long: '--validate', description: 'Verify workflow names exist in their n8n environments', takesValue: false },
        { long: '--dry-run', description: 'Print what would be written without saving', takesValue: false },
        { long: '--json', description: 'Emit machine-readable JSON', takesValue: false },
        { long: '--prune', description: 'Remove stale entries', takesValue: false },
        { long: '--yes', description: 'Auto-accept confirmations', takesValue: false },
        { long: '--env', description: 'Filter by environment', takesValue: true },
      ],
    },
    {
      name: 'credential',
      description: 'Manage credential logical name mappings',
      flags: [
        { long: '--smart', description: 'Enable fuzzy cross-env matching (paid)', takesValue: false },
        { long: '--dry-run', description: 'Print what would be written without saving', takesValue: false },
        { long: '--json', description: 'Emit machine-readable JSON', takesValue: false },
        { long: '--uncovered', description: 'Show credentials not yet mapped', takesValue: false },
        { long: '--env', description: 'Filter by environment', takesValue: true },
      ],
    },
    {
      name: 'status',
      description: 'Show the current project status',
      flags: [
        { long: '--json', description: 'Output result as JSON', takesValue: false },
      ],
    },
    {
      name: 'completion',
      description: 'Print shell completion script for bash, zsh, or fish',
      flags: [
        { long: '--install', description: 'Write the script to the user-local path instead of printing it', takesValue: false },
      ],
    },
  ];
}

export function generateBashScript(commands: CommandInfo[], version: string): string {
  const cmdNames = commands.map((c) => c.name).join(' ');

  const dollar = '$';
  const envCompletionFn = `
_chiral_complete_envs() {
  local envs
  envs=${dollar}(chiral _complete_envs 2>/dev/null)
  COMPREPLY=(${dollar}(compgen -W "${dollar}envs" -- "${dollar}1"))
}`;

  const subCmdCompletions = commands
    .map((cmd) => {
      const flagNames = cmd.flags.map((f) => f.long).join(' ');
      const envFlags = cmd.flags
        .filter((f) => f.long === '--env' || f.long === '--source' || f.long === '--target')
        .map((f) => f.long);

      let envHandling = '';
      if (envFlags.length > 0) {
        const envFlagCases = envFlags
          .map((f) => `        ${f}) _chiral_complete_envs "$cur"; return;;`)
          .join('\n');
        envHandling = `
      case "$prev" in
${envFlagCases}
      esac`;
      }

      return `    ${cmd.name})${envHandling}
      COMPREPLY=($(compgen -W "${flagNames}" -- "$cur"))
      ;;`;
    })
    .join('\n');

  return `# Generated by chiral ${version}
# To install: eval "${dollar}(chiral completion bash)" or chiral completion bash --install
${envCompletionFn}

_chiral() {
  local cur prev
  cur="${dollar}{COMP_WORDS[COMP_CWORD]}"
  prev="${dollar}{COMP_WORDS[COMP_CWORD-1]}"

  if [[ ${dollar}COMP_CWORD -eq 1 ]]; then
    COMPREPLY=(${dollar}(compgen -W "${cmdNames}" -- "${dollar}cur"))
    return
  fi

  local subcmd="${dollar}{COMP_WORDS[1]}"
  case "${dollar}subcmd" in
${subCmdCompletions}
  esac
}

complete -F _chiral chiral
`;
}

export function generateZshScript(commands: CommandInfo[], version: string): string {
  const subcommandDefs = commands
    .map((cmd) => `    '${cmd.name}:${cmd.description.replace(/'/g, '')}'`)
    .join('\n');

  const subCmdCases = commands
    .map((cmd) => {
      const flagDefs = cmd.flags
        .map((f) => {
          const desc = f.description.replace(/\\/g, '\\\\').replace(/'/g, '').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
          if (f.takesValue) {
            return `      '${f.long}[${desc}]:value:'`;
          }
          return `      '${f.long}[${desc}]'`;
        })
        .join('\n');
      return `    (${cmd.name})\n      _arguments \\\n${flagDefs}\n      ;;`;
    })
    .join('\n');

  return `#compdef chiral
# Generated by chiral ${version}
# To install: chiral completion zsh --install

_chiral() {
  local -a subcommands
  subcommands=(
${subcommandDefs}
  )

  if (( CURRENT == 2 )); then
    _describe 'chiral subcommands' subcommands
    return
  fi

  case $words[2] in
${subCmdCases}
  esac
}

_chiral "$@"
`;
}

export function generateFishScript(commands: CommandInfo[], version: string): string {
  const lines: string[] = [
    `# Generated by chiral ${version}`,
    `# To install: chiral completion fish --install`,
    '',
    '# Disable file completions for chiral',
    'complete -c chiral -f',
    '',
    '# Subcommands',
  ];

  for (const cmd of commands) {
    lines.push(`complete -c chiral -n '__fish_use_subcommand' -a '${cmd.name}' -d '${cmd.description.replace(/'/g, '')}'`);
  }

  lines.push('', '# Flags');
  for (const cmd of commands) {
    for (const flag of cmd.flags) {
      const flagName = flag.long.replace(/^--/, '');
      const desc = flag.description.replace(/'/g, '');
      const valPart = flag.takesValue ? ' -r' : '';
      lines.push(
        `complete -c chiral -n '__fish_seen_subcommand_from ${cmd.name}'${valPart} -l '${flagName}' -d '${desc}'`,
      );
    }
  }

  return lines.join('\n') + '\n';
}

const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

function assertSupportedShell(shell: string): asserts shell is SupportedShell {
  if (!(SUPPORTED_SHELLS as readonly string[]).includes(shell)) {
    throw new UserError(`Unsupported shell "${shell}". Supported: ${SUPPORTED_SHELLS.join(', ')}`);
  }
}

export function generateScript(shell: string, commands: CommandInfo[], version: string): string {
  assertSupportedShell(shell);
  if (shell === 'bash') return generateBashScript(commands, version);
  if (shell === 'zsh') return generateZshScript(commands, version);
  return generateFishScript(commands, version);
}

export function getInstallPath(shell: string): string {
  assertSupportedShell(shell);
  const home = os.homedir();
  if (shell === 'bash') return path.join(home, '.local', 'share', 'bash-completion', 'completions', 'chiral');
  if (shell === 'zsh') return path.join(home, '.zfunc', '_chiral');
  return path.join(home, '.config', 'fish', 'completions', 'chiral.fish');
}
