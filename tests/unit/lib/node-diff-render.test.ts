import { describe, it, expect } from 'vitest';
import { renderStatTable, type StatRow } from '../../../src/lib/node-diff-render.js';

function row(
  name: string,
  added: number,
  modified: number,
  removed: number,
  oldNodeCount: number,
  newNodeCount: number,
  changeKind: 'structural' | 'configuration' = 'structural',
): StatRow {
  return { name, counts: { added, modified, removed }, oldNodeCount, newNodeCount, changeKind };
}

describe('renderStatTable', () => {
  it('returns empty string for empty input', () => {
    expect(renderStatTable([])).toBe('');
  });

  it('sorts rows by churn descending', () => {
    const rows = [
      row('Low Churn', 0, 1, 0, 10, 10),   // 1/10 = 10%
      row('High Churn', 5, 2, 3, 10, 10),  // 10/10 = 100%
      row('Mid Churn', 0, 3, 0, 10, 10),   // 3/10 = 30%
    ];
    const output = renderStatTable(rows);
    const lines = output.split('\n');
    expect(lines[0]).toContain('High Churn');
    expect(lines[1]).toContain('Mid Churn');
    expect(lines[2]).toContain('Low Churn');
  });

  it('ranks structural above configuration at equal churn', () => {
    const rows = [
      row('Config Only', 0, 2, 0, 10, 10, 'configuration'),
      row('Structural', 0, 2, 0, 10, 10, 'structural'),
    ];
    const output = renderStatTable(rows);
    const lines = output.split('\n');
    expect(lines[0]).toContain('Structural');
    expect(lines[1]).toContain('Config Only');
  });

  it('renders a near-total rewrite as a full bar', () => {
    const rows = [row('Total Rewrite', 9, 0, 1, 10, 10)]; // 10/10 = 100%
    const output = renderStatTable(rows);
    expect(output).toContain('█████');
    expect(output).not.toContain('░');
  });

  it('renders a small change on a large workflow as a sliver', () => {
    const rows = [row('Big Workflow', 1, 0, 0, 50, 51)]; // 1/51 ≈ 2%
    const output = renderStatTable(rows);
    // Math.round(0.02 * 5) = 0, so all empty
    expect(output).toContain('░░░░░');
  });

  it('renders an empty bar for a zero-node workflow (no NaN)', () => {
    const rows = [row('Empty Workflow', 0, 0, 0, 0, 0)];
    const output = renderStatTable(rows);
    expect(output).not.toContain('NaN');
    expect(output).toContain('░░░░░');
  });

  it('aligns count columns vertically across rows of differing magnitude', () => {
    const rows = [
      row('A', 1, 0, 0, 10, 11),
      row('B', 10, 5, 3, 10, 20),
    ];
    const lines = renderStatTable(rows).split('\n');
    // Both lines should have the same length (right-pad aligns columns)
    expect(lines[0]!.length).toBe(lines[1]!.length);
    // The +count column should use consistent width: single-digit padded to match 2-digit
    expect(lines.some((l) => l.includes('+10'))).toBe(true);
    expect(lines.some((l) => l.includes('+ 1'))).toBe(true);
  });

  it('renders a moderate churn row with a partial bar', () => {
    const rows = [row('Workflow', 3, 2, 0, 10, 10)]; // 5/10 = 50%
    const output = renderStatTable(rows);
    // Math.round(0.5 * 5) = 3 filled, 2 empty
    expect(output).toContain('███░░');
  });

  it('includes name, counts, and bar in each row', () => {
    const rows = [row('My Flow', 2, 1, 3, 10, 10)];
    const output = renderStatTable(rows);
    expect(output).toContain('My Flow');
    expect(output).toContain('+2');
    expect(output).toContain('~1');
    expect(output).toContain('-3');
    // bar should be present (6/10 = 60%, Math.round(0.6*5)=3)
    expect(output).toContain('███░░');
  });
});
