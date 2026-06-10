import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';

export const TableEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export type TableEntry = z.infer<typeof TableEntrySchema>;

export const TablesSchema = z.object({
  version: z.literal(1),
  tables: z.record(z.string(), z.record(z.string(), TableEntrySchema)).default({}),
});

export type TablesMap = z.infer<typeof TablesSchema>;

export function loadTableMap(chiralDir: string): TablesMap {
  const path = join(chiralDir, 'tables.json');
  if (!existsSync(path)) return { version: 1, tables: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new UserError('tables.json is not valid JSON — fix it before running commands');
  }
  const result = TablesSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new UserError(
      `tables.json has an invalid structure:\n${issues}\n\nMake sure tables.json is valid JSON with the correct format.`,
    );
  }
  return result.data;
}

export function writeTableMap(chiralDir: string, data: TablesMap): void {
  const path = join(chiralDir, 'tables.json');
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSync(tmp, path);
  } catch {
    throw new UserError(`Could not write to ${path}`);
  }
}

export function upsertTableEnvEntry(
  map: TablesMap,
  logicalName: string,
  env: string,
  entry: TableEntry,
): void {
  if (!map.tables[logicalName]) map.tables[logicalName] = {};
  map.tables[logicalName][env] = { id: entry.id, name: entry.name };
}

export function removeTableEnvEntry(
  map: TablesMap,
  logicalName: string,
  env?: string,
): void {
  if (!map.tables[logicalName]) return;
  if (env === undefined) {
    delete map.tables[logicalName];
  } else {
    delete map.tables[logicalName][env];
    if (Object.keys(map.tables[logicalName]).length === 0) {
      delete map.tables[logicalName];
    }
  }
}

/** Collects `n8n-nodes-base.datatable` references: source table ID → cachedResultName (if present). */
export function collectDataTableRefs(workflows: { nodes?: unknown }[]): Map<string, string | undefined> {
  const refs = new Map<string, string | undefined>();
  for (const wf of workflows) {
    const nodes = (wf as Record<string, unknown>)['nodes'];
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const nodeObj = node as Record<string, unknown>;
      if (nodeObj['type'] !== 'n8n-nodes-base.datatable') continue;

      const params = nodeObj['parameters'];
      if (typeof params !== 'object' || params === null) continue;
      const dataTableId = (params as Record<string, unknown>)['dataTableId'];
      if (typeof dataTableId !== 'object' || dataTableId === null) continue;
      const dtObj = dataTableId as Record<string, unknown>;
      if (dtObj['__rl'] !== true) continue;

      const value = dtObj['value'];
      if (typeof value !== 'string') continue;
      const cachedResultName = typeof dtObj['cachedResultName'] === 'string' ? dtObj['cachedResultName'] : undefined;
      refs.set(value, cachedResultName);
    }
  }
  return refs;
}

/** Counts Data Table IDs referenced by `workflows` for `env` that have no entry in `tableMap`. */
export function countUnmappedTableIds(
  tableMap: TablesMap,
  env: string,
  workflows: { nodes?: unknown }[],
): number {
  const refs = collectDataTableRefs(workflows);
  let unmapped = 0;
  for (const sourceId of refs.keys()) {
    const found = Object.values(tableMap.tables).some(envMap => envMap[env]?.id === sourceId);
    if (!found) unmapped++;
  }
  return unmapped;
}
