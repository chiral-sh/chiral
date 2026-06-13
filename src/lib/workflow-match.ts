import type { Fingerprints } from '../state/fingerprints.js';
import type { WorkflowMap } from '../state/workflows.js';

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

  for (const [sourceName, hash] of srcIndex) {
    if (mappedSource.has(sourceName)) continue;
    const targetNames = hashToTargets.get(hash);
    if (!targetNames || targetNames.length === 0) {
      unmatchedSource.push(sourceName);
    } else if (targetNames.length === 1) {
      matches.push({ sourceName, targetName: targetNames[0], structureHash: hash });
      matchedTargets.add(targetNames[0]);
    } else {
      ambiguous.push({ sourceName, targetNames: [...targetNames] });
    }
  }

  const unmatchedTarget: string[] = [];
  for (const [name] of tgtIndex) {
    if (mappedTarget.has(name) || matchedTargets.has(name)) continue;
    unmatchedTarget.push(name);
  }

  return { matches, ambiguous, unmatchedSource, unmatchedTarget };
}
