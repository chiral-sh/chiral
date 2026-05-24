import { execSync } from 'node:child_process';
import { UserError } from './errors.js';

export function getGitActor(): string {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    throw new UserError(
      'git config user.email is not set — configure it before running chiral',
    );
  }
}
