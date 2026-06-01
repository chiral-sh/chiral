import { execSync } from 'node:child_process';
import { Command } from 'commander';
import { findChiralDir } from '../lib/config.js';
import { UserError } from '../lib/errors.js';
import { readTeam, ensureTeam } from '../state/team.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getGitActor(): string {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    throw new UserError(
      'git config user.email is not set - configure it before running this command.',
    );
  }
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padRight(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - visibleLen(s)));
}

function formatDate(iso: string): string {
  return iso;
}

// ── team list ─────────────────────────────────────────────────────────────────

export async function runTeamList(options: { json?: boolean }): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const team = readTeam(chiralDir);
  const entries = Object.entries(team.members);

  const ownerEmail = entries.find(([, m]) => m.role === 'owner')?.[0] ?? '';

  if (options.json) {
    const members = entries.map(([email, m]) => ({
      email,
      role: m.role,
      addedBy: m.addedBy,
      addedAt: m.addedAt,
    }));
    console.log(
      JSON.stringify({ status: 'ok', data: { owner: ownerEmail, members } }),
    );
    return;
  }

  if (entries.length === 0) {
    console.log('\n  No team members found.\n');
    return;
  }

  const COL_EMAIL = Math.max('EMAIL'.length, ...entries.map(([e]) => e.length));
  const COL_ROLE = Math.max('ROLE'.length, ...entries.map(([, m]) => m.role.length));
  const COL_ADDED_BY = Math.max('ADDED BY'.length, ...entries.map(([, m]) => m.addedBy.length));
  const COL_ADDED_AT = Math.max('ADDED AT'.length, ...entries.map(([, m]) => formatDate(m.addedAt).length));

  const widths = [COL_EMAIL, COL_ROLE, COL_ADDED_BY, COL_ADDED_AT];
  const top = '  ┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const sep = '  ├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '  └' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

  const headerRow =
    '  │ ' +
    [
      padRight('EMAIL', COL_EMAIL),
      padRight('ROLE', COL_ROLE),
      padRight('ADDED BY', COL_ADDED_BY),
      padRight('ADDED AT', COL_ADDED_AT),
    ].join(' │ ') +
    ' │';

  console.log();
  console.log(top);
  console.log(headerRow);
  console.log(sep);

  for (const [email, member] of entries) {
    const cells = [
      padRight(email, COL_EMAIL),
      padRight(member.role, COL_ROLE),
      padRight(member.addedBy, COL_ADDED_BY),
      padRight(formatDate(member.addedAt), COL_ADDED_AT),
    ];
    console.log('  │ ' + cells.join(' │ ') + ' │');
  }

  console.log(bot);
  console.log();
}

// ── team whoami ───────────────────────────────────────────────────────────────

export async function runTeamWhoami(options: { json?: boolean }): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project found. Run 'chiral init <name>' first.");
  }

  const actor = getGitActor();
  const team = readTeam(chiralDir);

  const entry = team.members[actor];
  const ownerEmail = Object.entries(team.members).find(([, m]) => m.role === 'owner')?.[0] ?? '';
  const isOwner = actor === ownerEmail;

  if (options.json) {
    console.log(
      JSON.stringify({
        status: 'ok',
        data: {
          email: actor,
          role: entry ? entry.role : null,
          isOwner: entry ? isOwner : false,
        },
      }),
    );
    return;
  }

  if (entry) {
    console.log(`\n  ${actor}  ${entry.role}\n`);
  } else {
    console.log(`\n  ${actor}  (not in this project's roster)\n`);
    console.log(`  Ask the project owner to run: chiral team add ${actor}\n`);
  }
}

// ── Commander wiring ──────────────────────────────────────────────────────────

const teamListCmd = new Command('list')
  .description('List all team members in the roster')
  .option('--json', 'Emit standard JSON envelope')
  .action(async (options) => {
    await runTeamList(options);
  });

const teamWhoamiCmd = new Command('whoami')
  .description('Show your membership status in the project roster')
  .option('--json', 'Emit standard JSON envelope')
  .action(async (options) => {
    await runTeamWhoami(options);
  });

export const teamCommand = new Command('team')
  .description('Manage the committed team roster for the active project');

teamCommand.addCommand(teamListCmd);
teamCommand.addCommand(teamWhoamiCmd);
