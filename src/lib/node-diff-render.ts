import chalk from 'chalk';
import type { WorkflowDiffResult, ModifiedNode } from './workflow-diff.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type StatRow = {
  name: string;
  counts: { added: number; modified: number; removed: number };
  oldNodeCount: number;
  newNodeCount: number;
  changeKind: 'structural' | 'configuration';
};

export type RenderedStatRow = { name: string; line: string };

// ── Internals ─────────────────────────────────────────────────────────────────

const BAR_WIDTH = 5;

function churnRatio(row: StatRow): number {
  const denom = Math.max(row.oldNodeCount, row.newNodeCount);
  if (denom === 0) return 0;
  return (row.counts.added + row.counts.modified + row.counts.removed) / denom;
}

function renderBar(ratio: number): string {
  const filled = Math.round(Math.min(ratio, 1) * BAR_WIDTH);
  return chalk.dim('█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled));
}

function buildStatLine(
  row: StatRow,
  maxNameLen: number,
  maxA: number,
  maxM: number,
  maxR: number,
): string {
  const namePad = chalk.bold(row.name) + ' '.repeat(maxNameLen - row.name.length);
  const a = String(row.counts.added).padStart(maxA);
  const m = String(row.counts.modified).padStart(maxM);
  const r = String(row.counts.removed).padStart(maxR);
  const countA = row.counts.added > 0 ? chalk.green(`+${a}`) : chalk.dim(`+${a}`);
  const countM = row.counts.modified > 0 ? chalk.yellow(`~${m}`) : chalk.dim(`~${m}`);
  const countR = row.counts.removed > 0 ? chalk.red(`-${r}`) : chalk.dim(`-${r}`);
  return `${namePad}  ${countA} ${countM} ${countR}  ${renderBar(churnRatio(row))}`;
}

// ── renderStatRows ────────────────────────────────────────────────────────────

export function renderStatRows(rows: StatRow[]): RenderedStatRow[] {
  if (rows.length === 0) return [];

  const sorted = [...rows].sort((a, b) => {
    const ca = churnRatio(a);
    const cb = churnRatio(b);
    if (ca !== cb) return cb - ca;
    if (a.changeKind === 'structural' && b.changeKind !== 'structural') return -1;
    if (b.changeKind === 'structural' && a.changeKind !== 'structural') return 1;
    return 0;
  });

  const maxNameLen = Math.max(...sorted.map((r) => r.name.length));
  const maxA = Math.max(...sorted.map((r) => String(r.counts.added).length));
  const maxM = Math.max(...sorted.map((r) => String(r.counts.modified).length));
  const maxR = Math.max(...sorted.map((r) => String(r.counts.removed).length));

  return sorted.map((row) => ({
    name: row.name,
    line: buildStatLine(row, maxNameLen, maxA, maxM, maxR),
  }));
}

// ── renderStatTable ───────────────────────────────────────────────────────────

export function renderStatTable(rows: StatRow[]): string {
  return renderStatRows(rows)
    .map((r) => r.line)
    .join('\n');
}

// ── renderNodeGroups ──────────────────────────────────────────────────────────

function nodeLabel(type: string, name: string): string {
  const shortType = type.split('.').pop() ?? type;
  return `${chalk.dim(shortType + ' · ')}"${name}"`;
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
  const connectedRemovals = removed.filter((n) => !n.orphaned);
  const orphanedRemovals = removed.filter((n) => n.orphaned);

  const hasLogic =
    added.length > 0 ||
    connectedRemovals.length > 0 ||
    structuralMods.length > 0 ||
    connections.added > 0 ||
    connections.removed > 0;
  const hasConfig = configMods.length > 0;
  const hasCleanup = orphanedRemovals.length > 0;

  if (!hasLogic && !hasConfig && !hasCleanup) return '';

  const lines: string[] = [];

  if (hasLogic) {
    lines.push(chalk.bold('Logic changed'));
    for (const n of added) {
      lines.push(`  ${chalk.green('+')} ${nodeLabel(n.type, n.name)}`);
    }
    for (const n of connectedRemovals) {
      lines.push(`  ${chalk.red('-')} ${nodeLabel(n.type, n.name)}`);
    }
    for (const n of structuralMods) {
      if (n.previousName !== undefined) {
        lines.push(`  ${chalk.yellow('~')} "${chalk.dim(n.previousName)}" → "${n.name}"`);
      } else {
        const groups = n.changed.filter((g) => g !== 'name').join(', ');
        const annotation = groups ? chalk.dim(` (${groups} changed)`) : '';
        lines.push(`  ${chalk.yellow('~')} ${nodeLabel(n.type, n.name)}${annotation}`);
      }
    }
    if (connections.added > 0) {
      lines.push(
        `  ${chalk.green('+')} ${chalk.dim(`${connections.added} connection${connections.added !== 1 ? 's' : ''} added`)}`,
      );
    }
    if (connections.removed > 0) {
      lines.push(
        `  ${chalk.red('-')} ${chalk.dim(`${connections.removed} connection${connections.removed !== 1 ? 's' : ''} removed`)}`,
      );
    }
  }

  if (hasConfig) {
    if (hasLogic) lines.push('');
    lines.push(chalk.bold('Config changed'));
    for (const n of configMods) {
      const groups = n.changed.join(', ');
      lines.push(
        `  ${chalk.yellow('~')} ${nodeLabel(n.type, n.name)}${chalk.dim(` (${groups} changed)`)}`,
      );
    }
  }

  if (hasCleanup) {
    if (hasLogic || hasConfig) lines.push('');
    lines.push(chalk.dim('Cleanup'));
    for (const n of orphanedRemovals) {
      lines.push(`  ${chalk.dim('-')} ${chalk.dim(nodeLabel(n.type, n.name))}`);
    }
  }

  return lines.join('\n');
}
