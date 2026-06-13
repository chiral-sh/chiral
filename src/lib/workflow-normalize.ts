// Normalizes a workflow snapshot before it is written to disk, so Git deltas
// collapse on no-op pulls and the stored JSON stays a valid push body.
// See docs/STATE_SPEC.md "Normalization (on write)" for the field list.

export const NORMALIZATION_VERSION = 1;

export const PIN_DATA_SIZE_LIMIT_BYTES = 256 * 1024;

const WORKFLOW_READ_ONLY_FIELDS = [
  'id',
  'active',
  'versionId',
  'triggerCount',
  'createdAt',
  'updatedAt',
  'isArchived',
  'meta',
  'tags',
] as const;

const NODE_READ_ONLY_FIELDS = ['createdAt', 'updatedAt'] as const;

// Must stay reconciled with PUSH_VALID_SETTINGS in src/state/fingerprints.ts,
// which intentionally omits customTelemetryTags (out of scope to change).
const SETTINGS_WHITELIST = new Set([
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
  'customTelemetryTags',
]);

export type PinDataMode = 'keep' | 'strip' | 'force-keep';

export type NormalizeWorkflowSnapshotResult = {
  workflow: Record<string, unknown>;
  pinDataStripped: boolean;
  pinDataSizeBytes: number | null;
};

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function omitKeys<T extends Record<string, unknown>>(
  obj: T,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!keys.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeSettings(settings: unknown): Record<string, unknown> | undefined {
  if (typeof settings !== 'object' || settings === null) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
    if (SETTINGS_WHITELIST.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeNodes(nodes: unknown): unknown {
  if (!Array.isArray(nodes)) return nodes;
  const arr: unknown[] = nodes;
  return arr.map((node) => {
    if (typeof node !== 'object' || node === null) return node;
    return omitKeys(node as Record<string, unknown>, NODE_READ_ONLY_FIELDS);
  });
}

export function normalizeWorkflowSnapshot(
  workflow: Record<string, unknown>,
  opts: { pinData: PinDataMode },
): NormalizeWorkflowSnapshotResult {
  let result = omitKeys(workflow, WORKFLOW_READ_ONLY_FIELDS);

  if ('nodes' in result) {
    result['nodes'] = normalizeNodes(result['nodes']);
  }

  if ('settings' in result) {
    const settings = normalizeSettings(result['settings']);
    if (settings !== undefined) {
      result['settings'] = settings;
    } else {
      delete result['settings'];
    }
  }

  let pinDataStripped = false;
  let pinDataSizeBytes: number | null = null;

  if ('pinData' in result) {
    const pinData = result['pinData'];
    pinDataSizeBytes = Buffer.byteLength(JSON.stringify(pinData), 'utf-8');

    if (opts.pinData === 'strip') {
      delete result['pinData'];
    } else if (opts.pinData === 'force-keep') {
      // retain regardless of size
    } else {
      if (pinDataSizeBytes > PIN_DATA_SIZE_LIMIT_BYTES) {
        delete result['pinData'];
        pinDataStripped = true;
      }
    }
  }

  result = sortKeysDeep(result) as Record<string, unknown>;

  return { workflow: result, pinDataStripped, pinDataSizeBytes };
}
