import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

export const WorkflowsSchema = z.object({
  version: z.literal(1),
  workflows: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

export type WorkflowMap = z.infer<typeof WorkflowsSchema>;

export function loadWorkflowMap(flightdeckDir: string): WorkflowMap {
  const path = join(flightdeckDir, 'workflows.json');
  if (!existsSync(path)) return { version: 1, workflows: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new UserError('workflows.json is not valid JSON — fix it before running diff');
  }
  const result = WorkflowsSchema.safeParse(raw);
  if (!result.success) {
    throw new UserError('workflows.json has an invalid structure — check docs/STATE_SPEC.md');
  }
  return result.data;
}

// Returns the workflow name in targetEnv for a workflow whose name in sourceEnv is sourceName.
// Falls back to sourceName if no mapping exists or the target env has no entry.
export function resolveTargetName(
  map: WorkflowMap,
  sourceEnv: string,
  targetEnv: string,
  sourceName: string,
): string {
  for (const logical of Object.values(map.workflows)) {
    if (logical[sourceEnv] === sourceName) {
      return logical[targetEnv] ?? sourceName;
    }
  }
  return sourceName;
}
