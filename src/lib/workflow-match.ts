import type { Fingerprints } from '../state/fingerprints.js';
import type { WorkflowMap } from '../state/workflows.js';
import { deriveLogicalName } from '../state/workflows.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExactMatch = {
  sourceName: string;
  targetName: string;
  structureHash: string;
};

export type AmbiguousMatch = {
  sourceName: string;
  targetNames: string[];
};

export type ExactMatchResult = {
  matches: ExactMatch[];
  ambiguous: AmbiguousMatch[];
  unmatchedSource: string[];
  unmatchedTarget: string[];
};

// ── Pass 1: exact structure-hash matching ───────────────────────────────────────

export type StructureIndexEntry = {
  id: string;
  name: string;
  structureHash: string;
};

// Builds an id -> {name, structureHash} map from a fingerprints env record.
// Keyed by workflow id so two entries sharing a display name are both retained.
export function buildStructureIndex(
  fingerprintsEnv: Fingerprints['envs'][string] | undefined,
): Map<string, StructureIndexEntry> {
  const index = new Map<string, StructureIndexEntry>();
  if (!fingerprintsEnv) return index;
  for (const [id, entry] of Object.entries(fingerprintsEnv)) {
    index.set(id, { id, name: entry.name, structureHash: entry.structureHash });
  }
  return index;
}

// Names that appear more than once in an index — these can't be uniquely
// identified by display name alone, so a hash match against one of them
// is ambiguous rather than a confident single match.
function duplicateNames(index: Map<string, StructureIndexEntry>): Set<string> {
  const counts = new Map<string, number>();
  for (const entry of index.values()) {
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
}

// Names already present in workflows.json for the given env (either side of any logical entry).
function mappedNames(map: WorkflowMap, env: string): Set<string> {
  const names = new Set<string>();
  for (const envMap of Object.values(map.workflows)) {
    const entry = envMap[env];
    if (entry) names.add(entry.name);
  }
  return names;
}

export function matchExact(
  srcIndex: Map<string, StructureIndexEntry>,
  tgtIndex: Map<string, StructureIndexEntry>,
  alreadyMapped: WorkflowMap,
  sourceEnv: string,
  targetEnv: string,
): ExactMatchResult {
  const mappedSource = mappedNames(alreadyMapped, sourceEnv);
  const mappedTarget = mappedNames(alreadyMapped, targetEnv);
  const duplicateTargetNames = duplicateNames(tgtIndex);

  // hash -> target names sharing that hash (excluding already-mapped targets)
  const hashToTargets = new Map<string, string[]>();
  for (const entry of tgtIndex.values()) {
    if (mappedTarget.has(entry.name)) continue;
    const list = hashToTargets.get(entry.structureHash);
    if (list) list.push(entry.name);
    else hashToTargets.set(entry.structureHash, [entry.name]);
  }

  const matches: ExactMatch[] = [];
  const ambiguous: AmbiguousMatch[] = [];
  const unmatchedSource: string[] = [];
  const matchedTargets = new Set<string>();

  // target name -> sources that uniquely candidate it (one-target candidates only)
  const singleCandidateSources = new Map<string, { sourceName: string; hash: string }[]>();

  for (const entry of srcIndex.values()) {
    const { name: sourceName, structureHash: hash } = entry;
    if (mappedSource.has(sourceName)) continue;
    const targetNames = hashToTargets.get(hash);
    if (!targetNames || targetNames.length === 0) {
      unmatchedSource.push(sourceName);
    } else if (targetNames.length === 1 && !duplicateTargetNames.has(targetNames[0])) {
      const list = singleCandidateSources.get(targetNames[0]);
      if (list) list.push({ sourceName, hash });
      else singleCandidateSources.set(targetNames[0], [{ sourceName, hash }]);
    } else {
      ambiguous.push({ sourceName, targetNames: [...targetNames] });
    }
  }

  // A target claimed by exactly one source is an exact match; a target claimed by
  // multiple sources (fan-in) is ambiguous for every one of those sources.
  for (const [targetName, sources] of singleCandidateSources) {
    if (sources.length === 1) {
      const { sourceName, hash } = sources[0];
      matches.push({ sourceName, targetName, structureHash: hash });
      matchedTargets.add(targetName);
    } else {
      for (const { sourceName } of sources) {
        ambiguous.push({ sourceName, targetNames: [targetName] });
      }
    }
  }

  const ambiguousTargets = new Set<string>();
  for (const a of ambiguous) {
    for (const t of a.targetNames) ambiguousTargets.add(t);
  }

  const unmatchedTarget: string[] = [];
  for (const entry of tgtIndex.values()) {
    const { name } = entry;
    if (mappedTarget.has(name) || matchedTargets.has(name) || ambiguousTargets.has(name)) continue;
    unmatchedTarget.push(name);
  }

  return { matches, ambiguous, unmatchedSource, unmatchedTarget };
}

// ── Logical-name reservation for batch matches ──────────────────────────────────

export type ReservedMatch = {
  logicalName: string;
  sourceName: string;
  targetName: string;
};

// Picks `base`, or `base-2`, `base-3`, ... — whichever isn't already in `reserved`.
// Mutates `reserved` to claim the chosen name.
export function claimLogicalName(base: string, reserved: Set<string>): string {
  let logicalName = base;
  if (reserved.has(logicalName)) {
    let n = 2;
    while (reserved.has(`${base}-${n}`)) n++;
    logicalName = `${base}-${n}`;
  }
  reserved.add(logicalName);
  return logicalName;
}

// Derives a unique logical key per match, accounting for collisions both with
// existing entries in `map` and with other matches in the same batch.
export function reserveLogicalNames(
  map: WorkflowMap,
  matches: ExactMatch[],
  knownEnvs: string[] = [],
): ReservedMatch[] {
  const reserved = new Set<string>(Object.keys(map.workflows));
  const result: ReservedMatch[] = [];

  for (const { sourceName, targetName } of matches) {
    const base = deriveLogicalName(sourceName, knownEnvs);
    const logicalName = claimLogicalName(base, reserved);
    result.push({ logicalName, sourceName, targetName });
  }

  return result;
}
