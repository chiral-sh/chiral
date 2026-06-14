import { expect } from 'vitest';
import type { N8nClient } from '../../../src/lib/n8n-client.js';

/**
 * Snapshots id->versionId for all workflows on the instance.
 */
async function snapshotWorkflows(client: N8nClient): Promise<Record<string, string>> {
  const workflows = await client.listWorkflows();
  const snapshot: Record<string, string> = {};
  for (const workflow of workflows) {
    snapshot[workflow.id] = workflow.versionId;
  }
  return snapshot;
}

/**
 * Runs `fn`, then asserts the instance's workflow id->versionId map is
 * byte-identical before and after — proves `fn` performed zero mutations.
 */
export async function assertNoMutation<T>(client: N8nClient, fn: () => Promise<T>): Promise<T> {
  const before = await snapshotWorkflows(client);
  const result = await fn();
  const after = await snapshotWorkflows(client);
  expect(after).toEqual(before);
  return result;
}
