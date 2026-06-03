import type { WorkflowDiffResult, ModifiedNode } from './workflow-diff.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type StatRow = {
  name: string;
  counts: { added: number; modified: number; removed: number };
  oldNodeCount: number;
  newNodeCount: number;
  changeKind: 'structural' | 'configuration';
};

// ── Internals ─────────────────────────────────────────────────────────────────

const BAR_WIDTH = 5;

function churnRatio(row: StatRow): number {
  const denom = Math.max(row.oldNodeCount, row.newNodeCount);
  if (denom === 0) return 0;
  return (row.counts.added + row.counts.modified + row.counts.removed) / denom;
}

function renderBar(ratio: number): string {
  const filled = Math.round(Math.min(ratio, 1) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

// ── renderStatTable ───────────────────────────────────────────────────────────

export function renderStatTable(rows: StatRow[]): string {
  if (rows.length === 0) return '';

  const sorted = [...rows].sort((a, b) => {
    const ca = churnRatio(a);
    const cb = churnRatio(b);
    if (ca !== cb) return cb - ca;
    // structural outranks configuration on equal churn
    if (a.changeKind === 'structural' && b.changeKind !== 'structural') return -1;
    if (b.changeKind === 'structural' && a.changeKind !== 'structural') return 1;
    return 0;
  });

  const maxNameLen = Math.max(...sorted.map((r) => r.name.length));
  const maxA = Math.max(...sorted.map((r) => String(r.counts.added).length));
  const maxM = Math.max(...sorted.map((r) => String(r.counts.modified).length));
  const maxR = Math.max(...sorted.map((r) => String(r.counts.removed).length));

  return sorted
    .map((row) => {
      const namePad = row.name.padEnd(maxNameLen);
      const a = String(row.counts.added).padStart(maxA);
      const m = String(row.counts.modified).padStart(maxM);
      const r = String(row.counts.removed).padStart(maxR);
      const bar = renderBar(churnRatio(row));
      return `${namePad}  +${a} ~${m} -${r}  ${bar}`;
    })
    .join('\n');
}

// ── renderNodeGroups ──────────────────────────────────────────────────────────

function nodeLabel(type: string, name: string): string {
  return `${type} · "${name}"`;
}

function isConfigOnly(node: ModifiedNode): boolean {
  return (
    node.changed.length > 0 &&
    node.changed.every((g) => g === 'parameters' || g === 'credentials')
  );
}

export function renderNodeGroups(diff: WorkflowDiffResult): string {
  const { added, removed, modified, connections } = diff;

  const structuralMods = modified.filter((n) => !isConfigOnly(n));
  const configMods = modified.filter(isConfigOnly);

  const hasLogic =
    added.length > 0 ||
    removed.length > 0 ||
    structuralMods.length > 0 ||
    connections.added > 0 ||
    connections.removed > 0;
  const hasConfig = configMods.length > 0;

  if (!hasLogic && !hasConfig) return '';

  const lines: string[] = [];

  if (hasLogic) {
    lines.push('Logic changed');
    for (const n of added) {
      lines.push(`  + ${nodeLabel(n.type, n.name)}`);
    }
    for (const n of removed) {
      lines.push(`  - ${nodeLabel(n.type, n.name)}`);
    }
    for (const n of structuralMods) {
      if (n.previousName !== undefined) {
        lines.push(`  ~ "${n.previousName}" → "${n.name}"`);
      } else {
        const groups = n.changed.filter((g) => g !== 'name').join(', ');
        const annotation = groups ? ` (${groups} changed)` : '';
        lines.push(`  ~ ${nodeLabel(n.type, n.name)}${annotation}`);
      }
    }
    if (connections.added > 0) {
      lines.push(
        `  + ${connections.added} connection${connections.added !== 1 ? 's' : ''} added`,
      );
    }
    if (connections.removed > 0) {
      lines.push(
        `  - ${connections.removed} connection${connections.removed !== 1 ? 's' : ''} removed`,
      );
    }
  }

  if (hasConfig) {
    if (hasLogic) lines.push('');
    lines.push('Config changed');
    for (const n of configMods) {
      const groups = n.changed.join(', ');
      lines.push(`  ~ ${nodeLabel(n.type, n.name)} (${groups} changed)`);
    }
  }

  return lines.join('\n');
}
