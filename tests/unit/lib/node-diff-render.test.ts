import { describe, it, expect } from 'vitest';
import {
  renderStatTable,
  renderNodeGroups,
  type StatRow,
} from '../../../src/lib/node-diff-render.js';
import type { WorkflowDiffResult } from '../../../src/lib/workflow-diff.js';

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

// ── renderNodeGroups ──────────────────────────────────────────────────────────

function makeDiff(overrides: Partial<WorkflowDiffResult> = {}): WorkflowDiffResult {
  return {
    added: [],
    removed: [],
    modified: [],
    connections: { added: 0, removed: 0 },
    counts: { added: 0, modified: 0, removed: 0 },
    oldNodeCount: 0,
    newNodeCount: 0,
    ...overrides,
  };
}

describe('renderNodeGroups', () => {
  it('returns empty string for an empty diff', () => {
    expect(renderNodeGroups(makeDiff())).toBe('');
  });

  it('renders added nodes with + symbol and type · "name" form', () => {
    const diff = makeDiff({
      added: [{ name: 'Get Data', type: 'n8n-nodes-base.httpRequest' }],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('+ httpRequest · "Get Data"');
  });

  it('renders removed nodes with - symbol and type · "name" form', () => {
    const diff = makeDiff({
      removed: [{ name: 'Old Node', type: 'n8n-nodes-base.set' }],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('- set · "Old Node"');
  });

  it('renders a rename as ~ "old" → "new" exactly once (not as add + remove)', () => {
    const diff = makeDiff({
      modified: [
        { name: 'New Name', type: 'n8n-nodes-base.set', changed: ['name'], previousName: 'Old Name' },
      ],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('~ "Old Name" → "New Name"');
    const occurrences = output.split('~ "Old Name" → "New Name"').length - 1;
    expect(occurrences).toBe(1);
    expect(output).not.toContain('+ set · "New Name"');
    expect(output).not.toContain('- set · "Old Name"');
  });

  it('renders a parameter-only change with (parameters changed) and no values', () => {
    const diff = makeDiff({
      modified: [
        { name: 'API Call', type: 'n8n-nodes-base.httpRequest', changed: ['parameters'] },
      ],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('httpRequest · "API Call" (parameters changed)');
    expect(output).toContain('Config changed');
    expect(output).not.toContain('Logic changed');
  });

  it('renders a credential-only change in Config changed section', () => {
    const diff = makeDiff({
      modified: [
        { name: 'My Node', type: 'n8n-nodes-base.postgres', changed: ['credentials'] },
      ],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('Config changed');
    expect(output).toContain('(credentials changed)');
    expect(output).not.toContain('Logic changed');
  });

  it('places adds and removes in Logic changed section', () => {
    const diff = makeDiff({
      added: [{ name: 'New', type: 'n8n-nodes-base.set' }],
      removed: [{ name: 'Old', type: 'n8n-nodes-base.set' }],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('Logic changed');
    expect(output).not.toContain('Config changed');
  });

  it('renders both Logic changed and Config changed sections when both exist', () => {
    const diff = makeDiff({
      added: [{ name: 'New Node', type: 'n8n-nodes-base.set' }],
      modified: [
        { name: 'Existing', type: 'n8n-nodes-base.httpRequest', changed: ['parameters'] },
      ],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('Logic changed');
    expect(output).toContain('Config changed');
  });

  it('renders connection add/remove counts in Logic changed section', () => {
    const diff = makeDiff({
      connections: { added: 2, removed: 1 },
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('Logic changed');
    expect(output).toContain('2 connections added');
    expect(output).toContain('1 connection removed');
  });

  it('uses singular "connection" for count of 1', () => {
    const diff = makeDiff({ connections: { added: 1, removed: 0 } });
    const output = renderNodeGroups(diff);
    expect(output).toContain('1 connection added');
    expect(output).not.toContain('1 connections added');
  });

  it('renders an orphaned removed node in Cleanup section, not Logic changed', () => {
    const diff = makeDiff({
      removed: [{ name: 'Dead Node', type: 'n8n-nodes-base.set', orphaned: true }],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('Cleanup');
    expect(output).toContain('Dead Node');
    expect(output).not.toContain('Logic changed');
  });

  it('renders connected removed nodes in Logic changed and orphaned in Cleanup when both exist', () => {
    const diff = makeDiff({
      removed: [
        { name: 'Real Gone', type: 'n8n-nodes-base.set' },
        { name: 'Dead Node', type: 'n8n-nodes-base.set', orphaned: true },
      ],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('Logic changed');
    expect(output).toContain('Cleanup');
    const logicIdx = output.indexOf('Logic changed');
    const cleanupIdx = output.indexOf('Cleanup');
    expect(logicIdx).toBeLessThan(cleanupIdx);
    expect(output).toContain('set · "Real Gone"');
    expect(output).toContain('Dead Node');
  });

  it('renders settings-only change as structural in Logic changed', () => {
    const diff = makeDiff({
      modified: [
        { name: 'Worker', type: 'n8n-nodes-base.executeWorkflow', changed: ['settings'] },
      ],
    });
    const output = renderNodeGroups(diff);
    expect(output).toContain('Logic changed');
    expect(output).not.toContain('Config changed');
    expect(output).toContain('(settings changed)');
  });
});
