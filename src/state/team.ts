import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

export const TeamMemberSchema = z.object({
  role: z.enum(['owner', 'member']),
  addedBy: z.string().email(),
  addedAt: z.string().datetime(),
});

export const TeamSchema = z.object({
  version: z.literal(1),
  members: z.record(z.string().email(), TeamMemberSchema),
});

export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type Team = z.infer<typeof TeamSchema>;

export function readTeam(chiralDir: string): Team {
  const teamPath = join(chiralDir, 'team.json');
  if (!existsSync(teamPath)) {
    throw new UserError("No team.json found. Run 'chiral init' to create a new project.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(teamPath, 'utf-8'));
  } catch {
    throw new UserError(`Could not read ${teamPath} - is it valid JSON?`);
  }

  const result = TeamSchema.safeParse(raw);
  if (!result.success) {
    const firstError = result.error.errors[0];
    const field = firstError.path.join('.');
    throw new UserError(
      `Invalid team.json: ${field ? field + ': ' : ''}${firstError.message}`,
    );
  }

  return result.data;
}

export function ensureTeam(chiralDir: string): Team | null {
  const teamPath = join(chiralDir, 'team.json');
  if (!existsSync(teamPath)) return null;
  return readTeam(chiralDir);
}

export function writeTeam(chiralDir: string, team: Team): void {
  const teamPath = join(chiralDir, 'team.json');
  try {
    writeFileSync(teamPath, JSON.stringify(team, null, 2) + '\n', 'utf-8');
  } catch {
    throw new UserError(`Could not write to ${teamPath}`);
  }
}
