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
  subcommands?: CommandInfo[];
  workflowPositional?: boolean;
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
      flags: [],
      subcommands: [
        {
          name: 'list',
          description: 'List all projects',
          flags: [
            { long: '--json', description: 'Output result as JSON', takesValue: false },
          ],
        },
        {
          name: 'current',
          description: 'Show the active project for this terminal session',
          flags: [
            { long: '--json', description: 'Output result as JSON', takesValue: false },
          ],
        },
        {
          name: 'rename',
          description: 'Rename a project',
          flags: [
            { long: '--json', description: 'Output result as JSON', takesValue: false },
          ],
        },
        {
          name: 'delete',
          description: 'Delete a project',
          flags: [
            { long: '--yes', description: 'Skip type-to-confirm prompt', takesValue: false },
            { long: '--json', description: 'Output result as JSON', takesValue: false },
          ],
        },
      ],
    },
    {
      name: 'environment',
      description: 'Manage n8n environment connections',
      flags: [],
      subcommands: [
        {
          name: 'add',
          description: 'Add a new environment connection',
          flags: [
            { long: '--url', description: 'n8n instance URL', takesValue: true },
            { long: '--api-key', description: 'n8n API key', takesValue: true },
            { long: '--skip-test', description: 'Skip the connection test', takesValue: false },
            { long: '--json', description: 'Output result as JSON', takesValue: false },
          ],
        },
        {
          name: 'configure',
          description: 'Update URL or API key for an existing environment',
          flags: [
            { long: '--url', description: 'New n8n instance URL', takesValue: true },
            { long: '--api-key', description: 'New n8n API key', takesValue: true },
            { long: '--skip-test', description: 'Skip the connection test', takesValue: false },
            { long: '--json', description: 'Output result as JSON', takesValue: false },
          ],
        },
        {
          name: 'list',
          description: 'List all configured environments',
          flags: [
            { long: '--json', description: 'Output result as JSON', takesValue: false },
          ],
        },
        {
          name: 'rename',
          description: 'Rename an environment',
          flags: [
            { long: '--json', description: 'Output result as JSON', takesValue: false },
          ],
        },
        {
          name: 'delete',
          description: 'Delete an environment',
          flags: [
            { long: '--yes', description: 'Skip confirmation prompt', takesValue: false },
            { long: '--dry-run', description: 'Show what would be deleted without making changes', takesValue: false },
            { long: '--json', description: 'Output result as JSON', takesValue: false },
          ],
        },
      ],
    },
    {
      name: 'remote',
      description: 'Manage git sync configuration for the active project',
      flags: [],
      subcommands: [
        {
          name: 'set',
          description: 'Set or update the git remote and/or branch',
          flags: [
            { long: '--url', description: 'Git remote URL or name', takesValue: true },
            { long: '--branch', description: 'Branch to sync to', takesValue: true },
          ],
        },
        {
          name: 'enable',
          description: 'Re-enable git sync',
          flags: [],
        },
        {
          name: 'disable',
          description: 'Pause git sync',
          flags: [],
        },
        {
          name: 'remove',
          description: 'Remove the git sync configuration entirely',
          flags: [
            { long: '--yes', description: 'Skip type-to-confirm prompt', takesValue: false },
          ],
        },
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
        { long: '--check', description: 'Perform lock check and exit 0 (clear) or 1 (blocked) - no push executed', takesValue: false },
      ],
    },
    {
      name: 'workflow',
      description: 'Manage workflow name mappings across environments',
      flags: [],
      subcommands: [
        {
          name: 'map',
          description: 'Map workflow names across environments',
          flags: [
            { long: '--validate', description: 'Verify workflow names exist in their n8n environments', takesValue: false },
            { long: '--dry-run', description: 'Print what would be written without saving', takesValue: false },
            { long: '--json', description: 'Emit the mapping entry as JSON', takesValue: false },
            { long: '--prune', description: 'Remove stale entries', takesValue: false },
            { long: '--yes', description: 'Auto-accept confirmations', takesValue: false },
          ],
        },
        {
          name: 'list',
          description: 'List all workflow name mappings',
          flags: [
            { long: '--env', description: 'Show only entries for this environment', takesValue: true },
            { long: '--unmapped', description: 'Show workflows with no mapping', takesValue: false },
            { long: '--incomplete', description: 'Show mappings missing IDs or env coverage', takesValue: false },
            { long: '--json', description: 'Emit machine-readable JSON', takesValue: false },
          ],
        },
        {
          name: 'unmap',
          description: 'Remove a workflow mapping',
          flags: [
            { long: '--env', description: "Remove only this environment's mapping", takesValue: true },
          ],
        },
      ],
    },
    {
      name: 'lock',
      description: 'Claim a workflow lock to signal active editing',
      workflowPositional: true,
      flags: [
        { long: '--env', description: 'Environment to lock the workflow in', takesValue: true },
        { long: '--all-envs', description: 'Lock the workflow in every configured environment', takesValue: false },
        { long: '--reason', description: 'Human-readable reason stored in the lock file', takesValue: true },
        { long: '--json', description: 'Emit standard JSON envelope', takesValue: false },
      ],
      subcommands: [
        {
          name: 'list',
          description: 'Show all active workflow locks',
          flags: [
            { long: '--env', description: 'Show locks for one environment only', takesValue: true },
            { long: '--stale', description: 'Filter to locks older than this duration (e.g. 2h)', takesValue: true },
            { long: '--json', description: 'Emit standard JSON envelope', takesValue: false },
            { long: '--watch', description: 'Re-render on filesystem changes', takesValue: false },
          ],
        },
      ],
    },
    {
      name: 'unlock',
      description: 'Release a workflow lock',
      workflowPositional: true,
      flags: [
        { long: '--env', description: 'Environment to unlock', takesValue: true },
        { long: '--all-envs', description: 'Unlock in every env where the current actor holds the lock', takesValue: false },
        { long: '--force', description: 'Free tier: override own lock. Paid: override any lock (requires --reason)', takesValue: false },
        { long: '--reason', description: 'Reason for force-unlock (paid, required with --force on another actor)', takesValue: true },
        { long: '--yes', description: 'Skip confirmation prompt on --force', takesValue: false },
        { long: '--json', description: 'Emit standard JSON envelope', takesValue: false },
      ],
    },
    {
      name: 'credential',
      description: 'Manage credential name mappings across environments',
      flags: [],
      subcommands: [
        {
          name: 'map',
          description: 'Register or update credential name mappings',
          flags: [
            { long: '--smart', description: 'Enable fuzzy cross-env matching (paid)', takesValue: false },
            { long: '--dry-run', description: 'Print what would be written without saving', takesValue: false },
            { long: '--json', description: 'Emit result as JSON', takesValue: false },
          ],
        },
        {
          name: 'list',
          description: 'Display all mapped credentials',
          flags: [
            { long: '--uncovered', description: 'Show credentials not yet mapped', takesValue: false },
            { long: '--env', description: 'Filter to entries for this environment', takesValue: true },
            { long: '--json', description: 'Emit machine-readable JSON', takesValue: false },
          ],
        },
        {
          name: 'unmap',
          description: 'Remove a credential entry or single env mapping',
          flags: [
            { long: '--env', description: "Remove only this environment's mapping", takesValue: true },
          ],
        },
      ],
    },
    {
      name: 'team',
      description: 'Manage the committed team roster for the active project',
      flags: [],
      subcommands: [
        {
          name: 'list',
          description: 'List all team members in the roster',
          flags: [
            { long: '--json', description: 'Emit standard JSON envelope', takesValue: false },
          ],
        },
        {
          name: 'whoami',
          description: 'Show your membership status in the project roster',
          flags: [
            { long: '--json', description: 'Emit standard JSON envelope', takesValue: false },
          ],
        },
        {
          name: 'add',
          description: 'Add or update a member in the team roster',
          flags: [
            { long: '--role', description: 'Role to assign: owner or member', takesValue: true },
            { long: '--dry-run', description: 'Print what would change without writing', takesValue: false },
            { long: '--json', description: 'Emit standard JSON envelope', takesValue: false },
          ],
        },
        {
          name: 'remove',
          description: 'Remove a member from the team roster',
          flags: [
            { long: '--yes', description: 'Skip confirmation prompt', takesValue: false },
            { long: '--dry-run', description: 'Print what would change without writing', takesValue: false },
            { long: '--json', description: 'Emit standard JSON envelope', takesValue: false },
          ],
        },
        {
          name: 'set-role',
          description: 'Change the role of a team member',
          flags: [
            { long: '--dry-run', description: 'Print what would change without writing', takesValue: false },
            { long: '--json', description: 'Emit standard JSON envelope', takesValue: false },
          ],
        },
      ],
    },
    {
      name: 'status',
      description: 'Show the current project status',
      flags: [
        { long: '--env', description: 'Show status for a single environment only', takesValue: true },
        { long: '--json', description: 'Emit standard JSON envelope to stdout instead of text table', takesValue: false },
        { long: '--stale-after', description: 'Mark last pull as stale when older than N days (default 7)', takesValue: true },
        { long: '--stale-lock-after', description: 'Mark locks as STALE when older than N hours (default 24)', takesValue: true },
        { long: '--no-humanize', description: 'Show ISO-8601 timestamps instead of relative time', takesValue: false },
        { long: '--verbose', description: 'Print each state file read to stderr before rendering', takesValue: false },
        { long: '--compact', description: 'Output one tab-separated line per env; exits 3 if any env is stale', takesValue: false },
        { long: '--summary', description: 'Output a single summary line; exits 3 if any env is stale', takesValue: false },
        { long: '--fields', description: 'Comma-separated column selector (name,last_pull,last_push,workflow_count,stale,drift)', takesValue: true },
        { long: '--watch', description: 'Re-render on .chiral/ file changes', takesValue: false },
        { long: '--locks-only', description: 'Suppress the env summary table and print only the lock section', takesValue: false },
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

const ENV_FLAGS = new Set(['--env', '--source', '--target']);

// ── Bash ──────────────────────────────────────────────────────────────────────

function bashFlagCase(flags: FlagInfo[], indent: string): string {
  const envFlags = flags.filter((f) => ENV_FLAGS.has(f.long));
  const flagNames = flags.map((f) => f.long).join(' ');
  const lines: string[] = [];
  if (envFlags.length > 0) {
    lines.push(`${indent}case "$prev" in`);
    for (const f of envFlags) {
      lines.push(`${indent}  ${f.long}) _chiral_complete_envs "$cur"; return;;`);
    }
    lines.push(`${indent}esac`);
  }
  lines.push(`${indent}COMPREPLY=($(_chiral_compgen "${flagNames}" "$cur"))`);
  return lines.join('\n');
}

export function generateBashScript(commands: CommandInfo[], version: string): string {
  const cmdNames = commands.map((c) => c.name).join(' ');
  const dollar = '$';

  const envCompletionFn = `
_chiral_complete_envs() {
  local envs
  envs=${dollar}(chiral _complete_envs 2>/dev/null)
  COMPREPLY=(${dollar}(compgen -W "${dollar}envs" -- "${dollar}1"))
}

_chiral_complete_workflows() {
  local wfs
  wfs=${dollar}(chiral _complete_workflows 2>/dev/null)
  COMPREPLY=(${dollar}(compgen -W "${dollar}wfs" -- "${dollar}1"))
}

_chiral_compgen() {
  compgen -W "${dollar}1" -- "${dollar}2"
}`;

  const cmdCases = commands
    .map((cmd) => {
      if (cmd.subcommands && cmd.subcommands.length > 0) {
        const subNames = cmd.subcommands.map((s) => s.name).join(' ');

        const subCases = cmd.subcommands
          .map((sub) => {
            const body = bashFlagCase(sub.flags, '        ');
            return `        ${sub.name})\n${body}\n          ;;`;
          })
          .join('\n');

        // For commands that also have top-level flags (e.g. lock), offer them at depth 2 too
        const depth2Choices =
          cmd.flags.length > 0
            ? `${subNames} ${cmd.flags.map((f) => f.long).join(' ')}`
            : subNames;

        // depth-2 env flag handling for top-level flags (e.g. lock --env)
        const topEnvFlags = cmd.flags.filter((f) => ENV_FLAGS.has(f.long));
        const topEnvBlock =
          topEnvFlags.length > 0
            ? topEnvFlags.map((f) => `        ${f.long}) _chiral_complete_envs "$cur"; return;;`).join('\n')
            : '';

        const depth2EnvCase =
          topEnvBlock
            ? `      case "$prev" in\n${topEnvBlock}\n      esac\n`
            : '';

        const depth2CompLine = cmd.workflowPositional
          ? `${depth2EnvCase}        local _wfs\n        _wfs=${dollar}(chiral _complete_workflows 2>/dev/null)\n        COMPREPLY=(${dollar}(compgen -W "${depth2Choices} ${dollar}_wfs" -- "${dollar}cur"))`
          : `${depth2EnvCase}        COMPREPLY=($(_chiral_compgen "${depth2Choices}" "$cur"))`;

        return `    ${cmd.name})
      if [[ ${dollar}COMP_CWORD -eq 2 ]]; then
${depth2CompLine}
        return
      fi
      case "${dollar}{COMP_WORDS[2]}" in
${subCases}
      esac
      ;;`;
      } else {
        const body = bashFlagCase(cmd.flags, '      ');
        if (cmd.workflowPositional) {
          return `    ${cmd.name})
      if [[ ${dollar}COMP_CWORD -eq 2 ]]; then
        _chiral_complete_workflows "${dollar}cur"
        return
      fi
${body}
      ;;`;
        }
        return `    ${cmd.name})\n${body}\n      ;;`;
      }
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

  local cmd="${dollar}{COMP_WORDS[1]}"
  case "${dollar}cmd" in
${cmdCases}
  esac
}

complete -F _chiral chiral
`;
}

// ── Zsh ───────────────────────────────────────────────────────────────────────

function zshFlagDefs(flags: FlagInfo[], indent: string): string {
  return flags
    .map((f) => {
      const desc = f.description
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
      if (ENV_FLAGS.has(f.long)) {
        return `${indent}'${f.long}[${desc}]:env:($(chiral _complete_envs 2>/dev/null))'`;
      }
      if (f.takesValue) {
        return `${indent}'${f.long}[${desc}]:value:'`;
      }
      return `${indent}'${f.long}[${desc}]'`;
    })
    .join(' \\\n');
}

export function generateZshScript(commands: CommandInfo[], version: string): string {
  const subcommandDefs = commands
    .map((cmd) => `    '${cmd.name}:${cmd.description.replace(/'/g, '')}'`)
    .join('\n');

  const cmdCases = commands
    .map((cmd) => {
      if (cmd.subcommands && cmd.subcommands.length > 0) {
        const subDefs = cmd.subcommands
          .map((s) => `        '${s.name}:${s.description.replace(/'/g, '')}'`)
          .join('\n');

        const subCases = cmd.subcommands
          .map((sub) => {
            if (sub.flags.length === 0) {
              return `        (${sub.name})\n          ;;`;
            }
            const defs = zshFlagDefs(sub.flags, '          ');
            return `        (${sub.name})\n          _arguments \\\n${defs}\n          ;;`;
          })
          .join('\n');

        // For commands with top-level flags too (e.g. lock), include them at depth 3 fallback
        const topFlagDefs =
          cmd.flags.length > 0 ? zshFlagDefs(cmd.flags, '          ') : '';
        const fallback =
          topFlagDefs
            ? `        (*)\n          _arguments \\\n${topFlagDefs}\n          ;;`
            : '';

        const describeSection = cmd.workflowPositional
          ? `        _describe '${cmd.name} subcommands' _subs\n        local -a _wfs\n        _wfs=($(chiral _complete_workflows 2>/dev/null))\n        compadd "$@" -- $_wfs`
          : `        _describe '${cmd.name} subcommands' _subs`;

        return `    (${cmd.name})
      if (( CURRENT == 3 )); then
        local -a _subs
        _subs=(
${subDefs}
        )
${describeSection}
        return
      fi
      case $words[3] in
${subCases}
${fallback}
      esac
      ;;`;
      } else {
        if (cmd.flags.length === 0) {
          return `    (${cmd.name})\n      ;;`;
        }
        const defs = zshFlagDefs(cmd.flags, '      ');
        if (cmd.workflowPositional) {
          const workflowDef = `      ':workflow:($(chiral _complete_workflows 2>/dev/null))'`;
          return `    (${cmd.name})\n      _arguments \\\n${workflowDef} \\\n${defs}\n      ;;`;
        }
        return `    (${cmd.name})\n      _arguments \\\n${defs}\n      ;;`;
      }
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
${cmdCases}
  esac
}

_chiral "$@"
`;
}

// ── Fish ──────────────────────────────────────────────────────────────────────

export function generateFishScript(commands: CommandInfo[], version: string): string {
  const lines: string[] = [
    `# Generated by chiral ${version}`,
    `# To install: chiral completion fish --install`,
    '',
    '# Dynamic environment name completion',
    'function __chiral_complete_envs',
    '    chiral _complete_envs 2>/dev/null',
    'end',
    '',
    '# Dynamic workflow name completion',
    'function __chiral_complete_workflows',
    '    chiral _complete_workflows 2>/dev/null',
    'end',
    '',
    '# Disable file completions for chiral',
    'complete -c chiral -f',
    '',
    '# Top-level subcommands',
  ];

  for (const cmd of commands) {
    lines.push(
      `complete -c chiral -n '__fish_use_subcommand' -a '${cmd.name}' -d '${cmd.description.replace(/'/g, '')}'`,
    );
  }

  for (const cmd of commands) {
    if (cmd.subcommands && cmd.subcommands.length > 0) {
      const subNames = cmd.subcommands.map((s) => s.name).join(' ');
      lines.push('');
      lines.push(`# ${cmd.name} subcommands`);

      for (const sub of cmd.subcommands) {
        lines.push(
          `complete -c chiral -n '__fish_seen_subcommand_from ${cmd.name}; and not __fish_seen_subcommand_from ${subNames}' -a '${sub.name}' -d '${sub.description.replace(/'/g, '')}'`,
        );
      }

      // Top-level flags for mixed commands (e.g. lock)
      if (cmd.flags.length > 0) {
        lines.push('');
        lines.push(`# ${cmd.name} direct flags`);
        for (const flag of cmd.flags) {
          const flagName = flag.long.replace(/^--/, '');
          const desc = flag.description.replace(/'/g, '');
          const valPart = flag.takesValue ? ' -r' : '';
          const envPart = ENV_FLAGS.has(flag.long) ? ` -a '(__chiral_complete_envs)'` : '';
          lines.push(
            `complete -c chiral -n '__fish_seen_subcommand_from ${cmd.name}; and not __fish_seen_subcommand_from ${subNames}'${valPart} -l '${flagName}' -d '${desc}'${envPart}`,
          );
        }
      }

      for (const sub of cmd.subcommands) {
        if (sub.flags.length === 0) continue;
        lines.push('');
        lines.push(`# ${cmd.name} ${sub.name} flags`);
        for (const flag of sub.flags) {
          const flagName = flag.long.replace(/^--/, '');
          const desc = flag.description.replace(/'/g, '');
          const valPart = flag.takesValue ? ' -r' : '';
          const envPart = ENV_FLAGS.has(flag.long) ? ` -a '(__chiral_complete_envs)'` : '';
          lines.push(
            `complete -c chiral -n '__fish_seen_subcommand_from ${cmd.name}; and __fish_seen_subcommand_from ${sub.name}'${valPart} -l '${flagName}' -d '${desc}'${envPart}`,
          );
        }
      }

      if (cmd.workflowPositional) {
        lines.push('');
        lines.push(`# ${cmd.name} workflow name (positional)`);
        lines.push(
          `complete -c chiral -n '__fish_seen_subcommand_from ${cmd.name}; and not __fish_seen_subcommand_from ${cmd.subcommands.map((s) => s.name).join(' ')}' -a '(__chiral_complete_workflows)' -d 'Workflow name'`,
        );
      }
    } else {
      if (cmd.workflowPositional) {
        lines.push('');
        lines.push(`# ${cmd.name} workflow name (positional)`);
        lines.push(
          `complete -c chiral -n '__fish_seen_subcommand_from ${cmd.name}' -a '(__chiral_complete_workflows)' -d 'Workflow name'`,
        );
      }
      if (cmd.flags.length === 0) continue;
      lines.push('');
      lines.push(`# ${cmd.name} flags`);
      for (const flag of cmd.flags) {
        const flagName = flag.long.replace(/^--/, '');
        const desc = flag.description.replace(/'/g, '');
        const valPart = flag.takesValue ? ' -r' : '';
        const envPart = ENV_FLAGS.has(flag.long) ? ` -a '(__chiral_complete_envs)'` : '';
        lines.push(
          `complete -c chiral -n '__fish_seen_subcommand_from ${cmd.name}'${valPart} -l '${flagName}' -d '${desc}'${envPart}`,
        );
      }
    }
  }

  return lines.join('\n') + '\n';
}

// ── Shared ────────────────────────────────────────────────────────────────────

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
