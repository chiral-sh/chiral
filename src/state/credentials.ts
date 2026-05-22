import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

export const CredentialsSchema = z.object({
  version: z.literal(1),
  credentials: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

export type Credentials = z.infer<typeof CredentialsSchema>;

export function loadCredentials(flightdeckDir: string): Credentials {
  const credPath = join(flightdeckDir, 'credentials.json');
  if (!existsSync(credPath)) {
    throw new UserError(
      "No .flightdeck/credentials.json found. Run 'flightdeck init' first.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(credPath, 'utf-8'));
  } catch {
    throw new UserError(`Could not read ${credPath} — is it valid JSON?`);
  }

  const result = CredentialsSchema.safeParse(raw);
  if (!result.success) {
    const firstError = result.error.errors[0];
    const field = firstError.path.join('.');
    throw new UserError(
      `Invalid credentials.json: ${field ? field + ': ' : ''}${firstError.message}`,
    );
  }

  return result.data;
}

export function writeCredentials(flightdeckDir: string, data: Credentials): void {
  const credPath = join(flightdeckDir, 'credentials.json');
  try {
    writeFileSync(credPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch {
    throw new UserError(`Could not write to ${credPath}`);
  }
}
