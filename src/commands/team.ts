import { z } from 'zod';
import { confirm } from '@inquirer/prompts';
import { Command } from 'commander';
import { findChiralDir, loadConfigAndDir } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure} from '../lib/git-sync.js';
import { UserError } from '../lib/errors.js';
import { getGitActor } from '../lib/git.js';
import { visibleLen, padRight } from '../lib/cli.js';
import { readTeam, ensureTeam, writeTeam } from '../state/team.js';
import { writeAuditEntry } from '../state/audit.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return iso;
}

// ── team list ─────────────────────────────────────────────────────────────────

export async function runTeamList(options: { json?: boolean }): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project. Run 'chiral use <name>' to select one, or 'chiral init <name>' to create a new project.");
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
    throw new UserError("No active project. Run 'chiral use <name>' to select one, or 'chiral init <name>' to create a new project.");
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

// ── team add ──────────────────────────────────────────────────────────────────

export async function runTeamAdd(
  email: string,
  options: { role?: string; dryRun?: boolean; json?: boolean },
): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project. Run 'chiral use <name>' to select one, or 'chiral init <name>' to create a new project.");
  }

  if (!z.email().safeParse(email).success) {
    throw new UserError(`Invalid email address: "${email}"`);
  }

  const roleInput = options.role ?? 'member';
  if (roleInput !== 'owner' && roleInput !== 'member') {
    throw new UserError(`Invalid role "${roleInput}" - must be "owner" or "member"`);
  }
  const role: 'owner' | 'member' = roleInput;

  const actor = getGitActor();
  const team = readTeam(chiralDir);
  const isNew = !(email in team.members);

  if (options.dryRun) {
    if (options.json) {
      console.log(
        JSON.stringify({ status: 'ok', data: { email, role, added: isNew, dry_run: true } }),
      );
    } else {
      console.log(`\n  Would ${isNew ? 'add' : 'update'} ${email} as ${role}\n`);
    }
    return;
  }

  team.members[email] = { role, addedBy: actor, addedAt: new Date().toISOString() };
  writeTeam(chiralDir, team);

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try { configResult = loadConfigAndDir(); } catch { /* best-effort */ }

  writeAuditEntry(chiralDir, {
    event_id: crypto.randomUUID(),
    event_schema_version: 1,
    timestamp: new Date().toISOString(),
    actor,
    action: 'map',
    project: configResult?.config.project ?? 'unknown',
    source_env: null,
    target_env: '',
    workflow_ids: [],
    result: 'success',
    error: null,
    chiral_version: '0.1.0',
    match_method: 'manual',
    match_score: null,
  });

  if (options.json) {
    console.log(JSON.stringify({ status: 'ok', data: { email, role, added: isNew } }));
  } else {
    console.log(`\n  ${isNew ? '✓ Added' : '✓ Updated'} ${email} as ${role}\n`);
  }

  const syncResult = await syncToRemote(
    chiralDir,
    configResult?.config ?? { version: 1, project: 'unknown', environments: {} } as never,
    `chore(chiral): team add ${email}`,
  );
  if (!syncResult.skipped && !syncResult.nothingToCommit) {
    if (syncResult.success) {
      console.log(formatSyncSuccess(syncResult));
    } else {
      for (const line of formatSyncFailure(syncResult)) console.log(line);
    }
    console.log();
  }
}

// ── team remove ───────────────────────────────────────────────────────────────

export async function runTeamRemove(
  email: string,
  options: { yes?: boolean; dryRun?: boolean; json?: boolean },
): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project. Run 'chiral use <name>' to select one, or 'chiral init <name>' to create a new project.");
  }

  if (!z.email().safeParse(email).success) {
    throw new UserError(`Invalid email address: "${email}"`);
  }

  if (options.yes && options.dryRun) {
    throw new UserError('--yes and --dry-run cannot be used together');
  }

  const actor = getGitActor();
  const team = readTeam(chiralDir);

  if (!(email in team.members)) {
    throw new UserError(`"${email}" is not in the team roster`);
  }

  const ownerEmail = Object.entries(team.members).find(([, m]) => m.role === 'owner')?.[0];
  if (email === ownerEmail) {
    throw new UserError(
      `Cannot remove the project owner (${email}). Transfer ownership first: chiral team set-role <new-owner> owner`,
    );
  }

  if (!options.yes) {
    const confirmed = await confirm({
      message: `Remove ${email} from team?`,
      default: false,
    });
    if (!confirmed) {
      console.log('\n  Aborted.\n');
      return;
    }
  }

  if (options.dryRun) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'ok', data: { email, removed: true, dry_run: true } }));
    } else {
      console.log(`\n  Would remove ${email} from the team roster\n`);
    }
    return;
  }

  delete team.members[email];
  writeTeam(chiralDir, team);

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try { configResult = loadConfigAndDir(); } catch { /* best-effort */ }

  writeAuditEntry(chiralDir, {
    event_id: crypto.randomUUID(),
    event_schema_version: 1,
    timestamp: new Date().toISOString(),
    actor,
    action: 'unmap',
    project: configResult?.config.project ?? 'unknown',
    source_env: null,
    target_env: '',
    workflow_ids: [],
    result: 'success',
    error: null,
    chiral_version: '0.1.0',
  });

  if (options.json) {
    console.log(JSON.stringify({ status: 'ok', data: { email, removed: true } }));
  } else {
    console.log(`\n  ✓ Removed ${email} from the team roster\n`);
  }

  const syncResult = await syncToRemote(
    chiralDir,
    configResult?.config ?? { version: 1, project: 'unknown', environments: {} } as never,
    `chore(chiral): team remove ${email}`,
  );
  if (!syncResult.skipped && !syncResult.nothingToCommit) {
    if (syncResult.success) {
      console.log(formatSyncSuccess(syncResult));
    } else {
      for (const line of formatSyncFailure(syncResult)) console.log(line);
    }
    console.log();
  }
}

// ── team set-role ─────────────────────────────────────────────────────────────

export async function runTeamSetRole(
  email: string,
  role: string,
  options: { dryRun?: boolean; json?: boolean },
): Promise<void> {
  const chiralDir = findChiralDir();
  if (!chiralDir) {
    throw new UserError("No active project. Run 'chiral use <name>' to select one, or 'chiral init <name>' to create a new project.");
  }

  if (!z.email().safeParse(email).success) {
    throw new UserError(`Invalid email address: "${email}"`);
  }

  if (role !== 'owner' && role !== 'member') {
    throw new UserError(`Invalid role "${role}" - must be "owner" or "member"`);
  }
  const newRole: 'owner' | 'member' = role;

  const actor = getGitActor();
  const team = readTeam(chiralDir);

  if (!(email in team.members)) {
    throw new UserError(`"${email}" is not in the team roster`);
  }

  const currentOwnerEmail = Object.entries(team.members).find(([, m]) => m.role === 'owner')?.[0];

  if (newRole === 'member' && email === currentOwnerEmail) {
    throw new UserError(
      `Cannot demote the project owner to member. Transfer ownership first: chiral team set-role <new-owner> owner`,
    );
  }

  const previousOwner =
    newRole === 'owner' && currentOwnerEmail && currentOwnerEmail !== email
      ? currentOwnerEmail
      : undefined;

  if (options.dryRun) {
    if (options.json) {
      const data: Record<string, unknown> = { email, role: newRole };
      if (previousOwner) data['previousOwner'] = previousOwner;
      data['dry_run'] = true;
      console.log(JSON.stringify({ status: 'ok', data }));
    } else {
      if (previousOwner) {
        console.log(`\n  Would transfer ownership from ${previousOwner} to ${email}\n`);
      } else {
        console.log(`\n  Would set ${email} role to ${newRole}\n`);
      }
    }
    return;
  }

  if (previousOwner) {
    team.members[previousOwner].role = 'member';
  }
  team.members[email].role = newRole;
  writeTeam(chiralDir, team);

  let configResult: ReturnType<typeof loadConfigAndDir> | null = null;
  try { configResult = loadConfigAndDir(); } catch { /* best-effort */ }

  writeAuditEntry(chiralDir, {
    event_id: crypto.randomUUID(),
    event_schema_version: 1,
    timestamp: new Date().toISOString(),
    actor,
    action: 'map',
    project: configResult?.config.project ?? 'unknown',
    source_env: null,
    target_env: '',
    workflow_ids: [],
    result: 'success',
    error: null,
    chiral_version: '0.1.0',
    match_method: 'manual',
    match_score: null,
  });

  if (options.json) {
    const data: Record<string, unknown> = { email, role: newRole };
    if (previousOwner) data['previousOwner'] = previousOwner;
    console.log(JSON.stringify({ status: 'ok', data }));
  } else {
    if (previousOwner) {
      console.log(`\n  ✓ Ownership transferred from ${previousOwner} to ${email}\n`);
    } else {
      console.log(`\n  ✓ Set ${email} role to ${newRole}\n`);
    }
  }

  const syncResult = await syncToRemote(
    chiralDir,
    configResult?.config ?? { version: 1, project: 'unknown', environments: {} } as never,
    `chore(chiral): team set-role ${email} ${newRole}`,
  );
  if (!syncResult.skipped && !syncResult.nothingToCommit) {
    if (syncResult.success) {
      console.log(formatSyncSuccess(syncResult));
    } else {
      for (const line of formatSyncFailure(syncResult)) console.log(line);
    }
    console.log();
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

const teamAddCmd = new Command('add')
  .description('Add or update a member in the team roster')
  .argument('<email>', 'Email address of the team member')
  .option('--role <role>', 'Role to assign: owner or member (default: member)')
  .option('--dry-run', 'Print what would change without writing')
  .option('--json', 'Emit standard JSON envelope')
  .action(async (email: string, options) => {
    await runTeamAdd(email, options);
  });

const teamRemoveCmd = new Command('remove')
  .description('Remove a member from the team roster')
  .argument('<email>', 'Email address of the team member to remove')
  .option('--yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Print what would change without writing')
  .option('--json', 'Emit standard JSON envelope')
  .action(async (email: string, options) => {
    await runTeamRemove(email, options);
  });

const teamSetRoleCmd = new Command('set-role')
  .description('Change the role of a team member')
  .argument('<email>', 'Email address of the team member')
  .argument('<role>', 'New role: owner or member')
  .option('--dry-run', 'Print what would change without writing')
  .option('--json', 'Emit standard JSON envelope')
  .action(async (email: string, role: string, options) => {
    await runTeamSetRole(email, role, options);
  });

export const teamCommand = new Command('team')
  .description('Manage the committed team roster for the active project');

teamCommand.addCommand(teamListCmd);
teamCommand.addCommand(teamWhoamiCmd);
teamCommand.addCommand(teamAddCmd);
teamCommand.addCommand(teamRemoveCmd);
teamCommand.addCommand(teamSetRoleCmd);
