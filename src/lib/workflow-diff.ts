import stableStringify from 'fast-json-stable-stringify';
import { normalizeNode } from '../state/fingerprints.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChangeGroup = 'parameters' | 'credentials' | 'settings' | 'name' | 'other';

export type NodeSummary = {
  name: string;
  type: string;
};

export type ModifiedNode = {
  name: string;
  type: string;
  changed: ChangeGroup[];
  previousName?: string;
};

export type WorkflowDiffResult = {
  added: NodeSummary[];
  removed: NodeSummary[];
  modified: ModifiedNode[];
  connections: { added: number; removed: number };
  counts: { added: number; modified: number; removed: number };
  oldNodeCount: number;
  newNodeCount: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

type RawNode = Record<string, unknown>;

function toNodeArray(wf: Record<string, unknown>): RawNode[] {
  const nodes = wf['nodes'];
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((n): n is RawNode => typeof n === 'object' && n !== null);
}

function nodeId(n: RawNode): string | undefined {
  const id = n['id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function nodeName(n: RawNode): string {
  return typeof n['name'] === 'string' ? n['name'] : '';
}

function nodeType(n: RawNode): string {
  return typeof n['type'] === 'string' ? n['type'] : '';
}

// KNOWN_CHECKED are fields compared explicitly below; everything else falls through to 'other'.
const KNOWN_CHECKED = new Set(['name', 'parameters', 'credentials', 'settings']);

function classifyChangedGroups(a: RawNode, b: RawNode): ChangeGroup[] {
  const na = normalizeNode(a);
  const nb = normalizeNode(b);
  const changed: ChangeGroup[] = [];

  if (nodeName(a) !== nodeName(b)) changed.push('name');

  if (stableStringify(na['parameters'] ?? null) !== stableStringify(nb['parameters'] ?? null)) {
    changed.push('parameters');
  }
  if (stableStringify(na['credentials'] ?? null) !== stableStringify(nb['credentials'] ?? null)) {
    changed.push('credentials');
  }
  if (stableStringify(na['settings'] ?? null) !== stableStringify(nb['settings'] ?? null)) {
    changed.push('settings');
  }

  const allKeys = new Set([...Object.keys(na), ...Object.keys(nb)]);
  for (const key of allKeys) {
    if (KNOWN_CHECKED.has(key)) continue;
    if (stableStringify(na[key] ?? null) !== stableStringify(nb[key] ?? null)) {
      changed.push('other');
      break;
    }
  }

  return changed;
}

function extractEdges(wf: Record<string, unknown>): Set<string> {
  const edges = new Set<string>();
  const connections = wf['connections'];
  if (typeof connections !== 'object' || connections === null) return edges;
  for (const [source, outputs] of Object.entries(connections as Record<string, unknown>)) {
    if (typeof outputs !== 'object' || outputs === null) continue;
    for (const groups of Object.values(outputs as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!Array.isArray(group)) continue;
        for (const conn of group) {
          if (typeof conn !== 'object' || conn === null) continue;
          const target = (conn as Record<string, unknown>)['node'];
          if (typeof target === 'string') edges.add(`${source}→${target}`);
        }
      }
    }
  }
  return edges;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export function diffWorkflowNodes(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): WorkflowDiffResult {
  const nodesA = toNodeArray(a);
  const nodesB = toNodeArray(b);

  const added: NodeSummary[] = [];
  const removed: NodeSummary[] = [];
  const modified: ModifiedNode[] = [];

  const matchedA = new Set<number>();
  const matchedB = new Set<number>();

  // --- Phase 1: match by stable node id ---
  // Build unique-id maps (skip nodes whose id appears more than once on the same side).
  const idCountA = new Map<string, number>();
  for (const n of nodesA) {
    const id = nodeId(n);
    if (id) idCountA.set(id, (idCountA.get(id) ?? 0) + 1);
  }
  const idMapA = new Map<string, number>();
  for (const [i, n] of nodesA.entries()) {
    const id = nodeId(n);
    if (id && idCountA.get(id) === 1) idMapA.set(id, i);
  }

  const idCountB = new Map<string, number>();
  for (const n of nodesB) {
    const id = nodeId(n);
    if (id) idCountB.set(id, (idCountB.get(id) ?? 0) + 1);
  }

  for (const [j, nb] of nodesB.entries()) {
    const id = nodeId(nb);
    if (!id || idCountB.get(id) !== 1) continue;
    const iA = idMapA.get(id);
    if (iA === undefined) continue;

    matchedA.add(iA);
    matchedB.add(j);

    const na = nodesA[iA]!;
    if (stableStringify(normalizeNode(na)) !== stableStringify(normalizeNode(nb))) {
      const changed = classifyChangedGroups(na, nb);
      const entry: ModifiedNode = { name: nodeName(nb), type: nodeType(nb), changed };
      if (nodeName(na) !== nodeName(nb)) entry.previousName = nodeName(na);
      modified.push(entry);
    }
  }

  // --- Phase 2: match remaining nodes by name ---
  const nameCountA = new Map<string, number>();
  for (const [i, n] of nodesA.entries()) {
    if (matchedA.has(i)) continue;
    const name = nodeName(n);
    nameCountA.set(name, (nameCountA.get(name) ?? 0) + 1);
  }
  const nameMapA = new Map<string, number>();
  for (const [i, n] of nodesA.entries()) {
    if (matchedA.has(i)) continue;
    const name = nodeName(n);
    if (nameCountA.get(name) === 1) nameMapA.set(name, i);
  }

  const nameCountB = new Map<string, number>();
  for (const [j, n] of nodesB.entries()) {
    if (matchedB.has(j)) continue;
    const name = nodeName(n);
    nameCountB.set(name, (nameCountB.get(name) ?? 0) + 1);
  }

  for (const [j, nb] of nodesB.entries()) {
    if (matchedB.has(j)) continue;
    const name = nodeName(nb);
    if (nameCountB.get(name) !== 1) continue;
    const iA = nameMapA.get(name);
    if (iA === undefined) continue;

    matchedA.add(iA);
    matchedB.add(j);

    const na = nodesA[iA]!;
    if (stableStringify(normalizeNode(na)) !== stableStringify(normalizeNode(nb))) {
      const changed = classifyChangedGroups(na, nb);
      modified.push({ name: nodeName(nb), type: nodeType(nb), changed });
    }
  }

  // --- Phase 3: match remaining by positional index ---
  const unmatchedA = nodesA.map((_, i) => i).filter((i) => !matchedA.has(i));
  const unmatchedB = nodesB.map((_, j) => j).filter((j) => !matchedB.has(j));
  const positionalCount = Math.min(unmatchedA.length, unmatchedB.length);
  for (let k = 0; k < positionalCount; k++) {
    const iA = unmatchedA[k]!;
    const j = unmatchedB[k]!;
    matchedA.add(iA);
    matchedB.add(j);

    const na = nodesA[iA]!;
    const nb = nodesB[j]!;
    if (stableStringify(normalizeNode(na)) !== stableStringify(normalizeNode(nb))) {
      const changed = classifyChangedGroups(na, nb);
      modified.push({ name: nodeName(nb), type: nodeType(nb), changed });
    }
  }

  // --- Collect unmatched as added / removed ---
  for (let i = 0; i < nodesA.length; i++) {
    if (!matchedA.has(i)) removed.push({ name: nodeName(nodesA[i]!), type: nodeType(nodesA[i]!) });
  }
  for (let j = 0; j < nodesB.length; j++) {
    if (!matchedB.has(j)) added.push({ name: nodeName(nodesB[j]!), type: nodeType(nodesB[j]!) });
  }

  // --- Connection diff (directed source→target edges) ---
  const edgesA = extractEdges(a);
  const edgesB = extractEdges(b);
  let connectionsAdded = 0;
  let connectionsRemoved = 0;
  for (const e of edgesB) if (!edgesA.has(e)) connectionsAdded++;
  for (const e of edgesA) if (!edgesB.has(e)) connectionsRemoved++;

  return {
    added,
    removed,
    modified,
    connections: { added: connectionsAdded, removed: connectionsRemoved },
    counts: { added: added.length, modified: modified.length, removed: removed.length },
    oldNodeCount: nodesA.length,
    newNodeCount: nodesB.length,
  };
}
