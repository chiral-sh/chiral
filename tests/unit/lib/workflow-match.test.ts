import { describe, it, expect } from 'vitest';
import { buildStructureIndex, matchExact } from '../../../src/lib/workflow-match.js';
import type { Fingerprints } from '../../../src/state/fingerprints.js';
import type { WorkflowMap } from '../../../src/state/workflows.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function fpEntry(name: string, structureHash: string) {
  return {
    name,
    versionId: 'v1',
    contentHash: 'sha256:content',
    structureHash,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function emptyMap(): WorkflowMap {
  return { version: 1, workflows: {} };
}

// ── buildStructureIndex ───────────────────────────────────────────────────────

describe('buildStructureIndex', () => {
  it('returns empty map when env record is undefined', () => {
    expect(buildStructureIndex(undefined).size).toBe(0);
  });

  it('maps display name to structureHash', () => {
    const env: Fingerprints['envs'][string] = {
      'wf-1': fpEntry('Order Sync', 'sha256:abc'),
    };
    const index = buildStructureIndex(env);
    expect(index.get('Order Sync')).toBe('sha256:abc');
  });

  it('collapses duplicate display names last-wins', () => {
    const env: Fingerprints['envs'][string] = {
      'wf-1': fpEntry('Dup', 'sha256:first'),
      'wf-2': fpEntry('Dup', 'sha256:second'),
    };
    const index = buildStructureIndex(env);
    expect(index.get('Dup')).toBe('sha256:second');
    expect(index.size).toBe(1);
  });
});

// ── matchExact ────────────────────────────────────────────────────────────────

describe('matchExact', () => {
  it('matches a unique structureHash pair', () => {
    const src = buildStructureIndex({ 'wf-1': fpEntry('Order Sync [DEV]', 'sha256:abc') });
    const tgt = buildStructureIndex({ 'wf-2': fpEntry('Order Sync', 'sha256:abc') });
    const result = matchExact(src, tgt, emptyMap(), 'dev', 'prod');
    expect(result.matches).toEqual([
      { sourceName: 'Order Sync [DEV]', targetName: 'Order Sync', structureHash: 'sha256:abc' },
    ]);
    expect(result.unmatchedSource).toHaveLength(0);
    expect(result.unmatchedTarget).toHaveLength(0);
  });

  it('classifies a source matching two targets as ambiguous, not a match', () => {
    const src = buildStructureIndex({ 'wf-1': fpEntry('Shared', 'sha256:abc') });
    const tgt = buildStructureIndex({
      'wf-2': fpEntry('Shared A', 'sha256:abc'),
      'wf-3': fpEntry('Shared B', 'sha256:abc'),
    });
    const result = matchExact(src, tgt, emptyMap(), 'dev', 'prod');
    expect(result.matches).toHaveLength(0);
    expect(result.ambiguous).toEqual([
      { sourceName: 'Shared', targetNames: ['Shared A', 'Shared B'] },
    ]);
  });

  it('excludes names already present in workflows.json from all buckets', () => {
    const src = buildStructureIndex({
      'wf-1': fpEntry('Order Sync [DEV]', 'sha256:abc'),
      'wf-2': fpEntry('Already Mapped [DEV]', 'sha256:zzz'),
    });
    const tgt = buildStructureIndex({
      'wf-3': fpEntry('Order Sync', 'sha256:abc'),
      'wf-4': fpEntry('Already Mapped', 'sha256:zzz'),
    });
    const alreadyMapped: WorkflowMap = {
      version: 1,
      workflows: {
        'already-mapped': {
          dev: { name: 'Already Mapped [DEV]' },
          prod: { name: 'Already Mapped' },
        },
      },
    };
    const result = matchExact(src, tgt, alreadyMapped, 'dev', 'prod');
    expect(result.matches).toEqual([
      { sourceName: 'Order Sync [DEV]', targetName: 'Order Sync', structureHash: 'sha256:abc' },
    ]);
    expect(result.unmatchedSource).toHaveLength(0);
    expect(result.unmatchedTarget).toHaveLength(0);
  });

  it('puts sources and targets with no hash partner in unmatched arrays', () => {
    const src = buildStructureIndex({ 'wf-1': fpEntry('Lonely Source', 'sha256:src-only') });
    const tgt = buildStructureIndex({ 'wf-2': fpEntry('Lonely Target', 'sha256:tgt-only') });
    const result = matchExact(src, tgt, emptyMap(), 'dev', 'prod');
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedSource).toEqual(['Lonely Source']);
    expect(result.unmatchedTarget).toEqual(['Lonely Target']);
  });

  it('collapses duplicate names within one env last-wins without throwing', () => {
    const src = buildStructureIndex({
      'wf-1': fpEntry('Dup', 'sha256:first'),
      'wf-2': fpEntry('Dup', 'sha256:second'),
    });
    const tgt = buildStructureIndex({ 'wf-3': fpEntry('Dup', 'sha256:second') });
    expect(() => matchExact(src, tgt, emptyMap(), 'dev', 'prod')).not.toThrow();
    const result = matchExact(src, tgt, emptyMap(), 'dev', 'prod');
    expect(result.matches).toEqual([
      { sourceName: 'Dup', targetName: 'Dup', structureHash: 'sha256:second' },
    ]);
  });
});
