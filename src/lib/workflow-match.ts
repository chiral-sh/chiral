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

// Builds a name -> structureHash map from a fingerprints env record.
// Duplicate display names within the env collapse last-wins.
export function buildStructureIndex(
  fingerprintsEnv: Fingerprints['envs'][string] | undefined,
): Map<string, string> {
  const index = new Map<string, string>();
  if (!fingerprintsEnv) return index;
  for (const entry of Object.values(fingerprintsEnv)) {
    index.set(entry.name, entry.structureHash);
  }
  return index;
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
  srcIndex: Map<string, string>,
  tgtIndex: Map<string, string>,
  alreadyMapped: WorkflowMap,
  sourceEnv: string,
  targetEnv: string,
): ExactMatchResult {
  const mappedSource = mappedNames(alreadyMapped, sourceEnv);
  const mappedTarget = mappedNames(alreadyMapped, targetEnv);

  // hash -> target names sharing that hash (excluding already-mapped targets)
  const hashToTargets = new Map<string, string[]>();
  for (const [name, hash] of tgtIndex) {
    if (mappedTarget.has(name)) continue;
    const list = hashToTargets.get(hash);
    if (list) list.push(name);
    else hashToTargets.set(hash, [name]);
  }

  const matches: ExactMatch[] = [];
  const ambiguous: AmbiguousMatch[] = [];
  const unmatchedSource: string[] = [];
  const matchedTargets = new Set<string>();

  // target name -> sources that uniquely candidate it (one-target candidates only)
  const singleCandidateSources = new Map<string, { sourceName: string; hash: string }[]>();

  for (const [sourceName, hash] of srcIndex) {
    if (mappedSource.has(sourceName)) continue;
    const targetNames = hashToTargets.get(hash);
    if (!targetNames || targetNames.length === 0) {
      unmatchedSource.push(sourceName);
    } else if (targetNames.length === 1) {
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
  for (const [name] of tgtIndex) {
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
