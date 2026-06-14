import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import stableStringify from 'fast-json-stable-stringify';
import { UserError } from '../lib/errors.js';
import { writeJsonAtomic } from './atomic.js';

// ── Schema ────────────────────────────────────────────────────────────────────

const FingerprintEntrySchema = z.object({
  name: z.string(),
  versionId: z.string(),
  contentHash: z.string(),
  structureHash: z.string(),
  updatedAt: z.string(),
});

const FingerprintsSchema = z.object({
  version: z.literal(1),
  envs: z.record(z.string(), z.record(z.string(), FingerprintEntrySchema)).default({}),
});

export type FingerprintEntry = z.infer<typeof FingerprintEntrySchema>;
export type Fingerprints = z.infer<typeof FingerprintsSchema>;

// ── Hash computation ──────────────────────────────────────────────────────────

// Must mirror the validSettings set in src/commands/push.ts sanitizeWorkflowForApi.
// Fields not in this set are stripped before pushing, so they must not affect the
// content hash - otherwise a round-trip push produces a false "would-update".
const PUSH_VALID_SETTINGS = new Set([
  'saveExecutionProgress',
  'saveManualExecutions',
  'saveDataErrorExecution',
  'saveDataSuccessExecution',
  'executionTimeout',
  'errorWorkflow',
  'timezone',
  'executionOrder',
  'callerPolicy',
  'callerIds',
  'timeSavedPerExecution',
  'availableInMCP',
]);

function sha256hex(data: string): string {
  return 'sha256:' + createHash('sha256').update(data, 'utf8').digest('hex');
}

// Strips id/position/typeVersion, drops credential instance ids/names, and
// strips env-specific Data Table identifiers. Used by both normalizeForContent
// (content hash) and the node-diff engine.
export function normalizeNode(node: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, position: _pos, typeVersion: _tv, ...rest } = node;

  let normalized = rest;

  const creds = normalized['credentials'];
  if (typeof creds === 'object' && creds !== null) {
    const normalizedCreds: Record<string, unknown> = {};
    for (const [credType, credValue] of Object.entries(creds as Record<string, unknown>)) {
      if (typeof credValue === 'object' && credValue !== null) {
        // Drop instance-specific id and env-specific name - only the
        // presence of a credential of this type is part of the workflow logic.
        const { id: _cid, name: _cname, ...credRest } = credValue as Record<string, unknown>;
        normalizedCreds[credType] = credRest;
      } else {
        normalizedCreds[credType] = credValue;
      }
    }
    normalized = { ...normalized, credentials: normalizedCreds };
  }

  if (normalized['type'] === 'n8n-nodes-base.datatable') {
    const params = normalized['parameters'];
    if (typeof params === 'object' && params !== null) {
      const paramsObj = params as Record<string, unknown>;
      const dataTableId = paramsObj['dataTableId'];
      if (typeof dataTableId === 'object' && dataTableId !== null) {
        const { value: _value, cachedResultUrl: _cachedResultUrl, ...dtRest } =
          dataTableId as Record<string, unknown>;
        normalized = {
          ...normalized,
          parameters: { ...paramsObj, dataTableId: dtRest },
        };
      }
    }
  }

  return normalized;
}

function asString(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

function normalizeForContent(wf: Record<string, unknown>): object {
  const nodes = Array.isArray(wf['nodes']) ? (wf['nodes'] as Record<string, unknown>[]) : [];

  const normalizedNodes = nodes
    .filter((n): n is Record<string, unknown> => typeof n === 'object' && n !== null)
    .sort((a, b) => asString(a['id']).localeCompare(asString(b['id'])))
    .map(normalizeNode);

  // Only hash settings fields that survive sanitizeWorkflowForApi - fields stripped
  // before push must not influence the hash or a round-trip causes a false "would-update".
  const rawSettings =
    typeof wf['settings'] === 'object' && wf['settings'] !== null
      ? (wf['settings'] as Record<string, unknown>)
      : {};
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawSettings)) {
    if (PUSH_VALID_SETTINGS.has(k)) settings[k] = v;
  }

  return {
    name: wf['name'] ?? '',
    description: typeof wf['description'] === 'string' ? wf['description'] : '',
    nodes: normalizedNodes,
    connections: wf['connections'] ?? {},
    settings,
  };
}

export function computeContentHash(wf: Record<string, unknown>): string {
  return sha256hex(stableStringify(normalizeForContent(wf)));
}

export function computeStructureHash(wf: Record<string, unknown>): string {
  const nodes = Array.isArray(wf['nodes'])
    ? (wf['nodes'] as Record<string, unknown>[])
    : [];

  const nameToType = new Map<string, string>();
  for (const node of nodes) {
    if (typeof node['name'] === 'string' && typeof node['type'] === 'string') {
      nameToType.set(node['name'], node['type']);
    }
  }

  const nodeTypes = nodes
    .map((n) => asString(n['type']))
    .filter(Boolean)
    .sort();

  const pairs: string[] = [];
  const outgoingByName = new Map<string, string[]>();
  const incomingByName = new Map<string, string[]>();
  const connections = wf['connections'];
  if (typeof connections === 'object' && connections !== null) {
    for (const [sourceName, outputs] of Object.entries(connections as Record<string, unknown>)) {
      const sourceType = nameToType.get(sourceName);
      if (!sourceType || typeof outputs !== 'object' || outputs === null) continue;

      for (const outputGroups of Object.values(outputs as Record<string, unknown>)) {
        if (!Array.isArray(outputGroups)) continue;
        for (const group of outputGroups) {
          if (!Array.isArray(group)) continue;
          for (const conn of group) {
            if (typeof conn !== 'object' || conn === null) continue;
            const targetName = (conn as Record<string, unknown>)['node'];
            if (typeof targetName === 'string') {
              const targetType = nameToType.get(targetName);
              if (targetType) {
                pairs.push(`${sourceType} → ${targetType}`);
                outgoingByName.set(sourceName, [...(outgoingByName.get(sourceName) ?? []), targetType]);
                incomingByName.set(targetName, [...(incomingByName.get(targetName) ?? []), sourceType]);
              }
            }
          }
        }
      }
    }
  }

  // Count duplicate type→type edges instead of de-duplicating, so two
  // genuinely different topologies sharing the same edge-type *set* but
  // different multiplicities no longer collide.
  const pairCounts = new Map<string, number>();
  for (const pair of pairs) {
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }
  const connectionTopology = [...pairCounts.entries()]
    .map(([pair, count]) => `${pair} x${count}`)
    .sort();

  // Per-node adjacency signature (type + multiset of connected types on each
  // side) - distinguishes workflows whose node-type multiset and edge-type
  // set match but whose connections are wired between different node types.
  const nodeSignatures = nodes
    .filter((n) => typeof n['name'] === 'string' && typeof n['type'] === 'string')
    .map((n) => {
      const name = n['name'] as string;
      return stableStringify({
        type: n['type'],
        outgoing: (outgoingByName.get(name) ?? []).sort(),
        incoming: (incomingByName.get(name) ?? []).sort(),
      });
    })
    .sort();

  return sha256hex(stableStringify({ nodeTypes, connectionTopology, nodeSignatures }));
}

// ── Load / write ──────────────────────────────────────────────────────────────

export function loadFingerprints(chiralDir: string): Fingerprints {
  const filePath = join(chiralDir, 'fingerprints.json');
  if (!existsSync(filePath)) {
    return FingerprintsSchema.parse({ version: 1, envs: {} });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    throw new UserError(`Could not read ${filePath} - is it valid JSON?`);
  }
  const result = FingerprintsSchema.safeParse(raw);
  if (!result.success) {
    return FingerprintsSchema.parse({ version: 1, envs: {} });
  }
  return result.data;
}

export function writeFingerprints(chiralDir: string, data: Fingerprints): void {
  const filePath = join(chiralDir, 'fingerprints.json');
  writeJsonAtomic(filePath, data);
}

export function upsertFingerprintEntry(
  chiralDir: string,
  env: string,
  workflowId: string,
  entry: FingerprintEntry,
): void {
  const data = loadFingerprints(chiralDir);
  if (!data.envs[env]) data.envs[env] = {};
  data.envs[env][workflowId] = entry;
  writeFingerprints(chiralDir, data);
}
