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
