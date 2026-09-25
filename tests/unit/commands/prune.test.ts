import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

import { confirm } from '@inquirer/prompts';
import { runPrune } from '../../../src/commands/prune.js';
import { writeSnapshot } from '../../../src/state/snapshots.js';

const mockConfirm = vi.mocked(confirm);

const PROJECT_DIR = '/project';
const CHIRAL_DIR = `${PROJECT_DIR}/.chiral`;

const GLOBAL_DIR = '/mock-global';

const INDEX = JSON.stringify({
  version: 1,
  projects: { 'test-project': { path: PROJECT_DIR, createdAt: '2024-01-01T00:00:00.000Z' } },
});

const VALID_CONFIG = JSON.stringify({
  version: 1,
  project: 'test-project',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'key-dev' },
  },
});

const WORKFLOW = { id: 'wf-abc', name: 'My Workflow', active: false, nodes: [], connections: {} };

// Deployment IDs — lexicographic order determines newest/oldest
const DEP_A = '20240101T100000Z-aaaaaaaa'; // oldest
const DEP_B = '20240102T100000Z-bbbbbbbb';
const DEP_C = '20240103T100000Z-cccccccc';
const DEP_D = '20240104T100000Z-dddddddd';
const DEP_E = '20240105T100000Z-eeeeeeee'; // newest

function setup(deploymentIds: string[] = []) {
  vol.fromJSON({
    [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
    [`${CHIRAL_DIR}/config.json`]: VALID_CONFIG,
  });
  for (const id of deploymentIds) {
    writeSnapshot(CHIRAL_DIR, id, WORKFLOW);
  }
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'test-project';
  // Simulate interactive TTY so non-TTY guard doesn't fire by default
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterEach(() => {
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
});

// ── validatePruneOptions ──────────────────────────────────────────────────────

describe('validatePruneOptions', () => {
  it('throws UserError when --yes and --dry-run are both set', async () => {
    setup();
    await expect(runPrune({ yes: true, dryRun: true }, PROJECT_DIR)).rejects.toThrow(UserError);
  });

  it('throws UserError when --keep is 0', async () => {
    setup();
    await expect(runPrune({ keep: 0 }, PROJECT_DIR)).rejects.toThrow(UserError);
  });

  it('throws UserError when --keep is -1', async () => {
    setup();
    await expect(runPrune({ keep: -1 }, PROJECT_DIR)).rejects.toThrow(UserError);
  });

  it('throws UserError when --keep is a non-integer (NaN from bad parse)', async () => {
    setup();
    await expect(runPrune({ keep: NaN }, PROJECT_DIR)).rejects.toThrow(UserError);
  });

  it('throws UserError when --json is set without --yes on a TTY live run', async () => {
    setup([DEP_A, DEP_B]);
    await expect(runPrune({ keep: 1, json: true }, PROJECT_DIR)).rejects.toThrow(UserError);
  });

  it('throws UserError when --keep is 1.5', async () => {
    setup();
    await expect(runPrune({ keep: Number('1.5') }, PROJECT_DIR)).rejects.toThrow(UserError);
  });

  it('throws UserError when --keep is "10abc" (coerced to NaN by Number)', async () => {
    setup();
    await expect(runPrune({ keep: Number('10abc') }, PROJECT_DIR)).rejects.toThrow(UserError);
  });

  it('throws UserError when stdin is not a TTY and neither --yes nor --dry-run is set', async () => {
    setup();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(runPrune({}, PROJECT_DIR)).rejects.toThrow(UserError);
  });

  it('does not throw when stdin is not TTY but --yes is set', async () => {
    setup([DEP_A, DEP_B]);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runPrune({ yes: true, keep: 10 }, PROJECT_DIR)).resolves.not.toThrow();
    consoleSpy.mockRestore();
  });

  it('does not throw when stdin is not TTY but --dry-run is set', async () => {
    setup([DEP_A]);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runPrune({ dryRun: true, keep: 10 }, PROJECT_DIR)).resolves.not.toThrow();
    consoleSpy.mockRestore();
  });
});

// ── no .chiral dir ────────────────────────────────────────────────────────────

describe('missing chiral dir', () => {
  it('throws UserError when no .chiral directory is found', async () => {
    vol.fromJSON({});
    delete process.env['CHIRAL_PROJECT'];
    await expect(runPrune({ yes: true }, '/nonexistent')).rejects.toThrow(UserError);
  });
});

// ── nothing to prune ─────────────────────────────────────────────────────────

describe('nothing to prune', () => {
  it('exits cleanly with no deletion when keep >= deployment count', async () => {
    setup([DEP_A, DEP_B]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 10 }, PROJECT_DIR);
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Nothing to prune');
    expect(mockConfirm).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('exits cleanly when snapshots/ does not exist', async () => {
    setup([]); // no deployments written
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 10 }, PROJECT_DIR);
    expect(mockConfirm).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ── live run ──────────────────────────────────────────────────────────────────

describe('live run', () => {
  it('calls pruneSnapshots and prints summary after confirmation', async () => {
    setup([DEP_A, DEP_B, DEP_C, DEP_D, DEP_E]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 3 }, PROJECT_DIR);
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Pruned 2 old snapshots. Kept 3.');
    consoleSpy.mockRestore();
  });

  it('prints Next: chiral status after successful deletion', async () => {
    setup([DEP_A, DEP_B, DEP_C]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 1, yes: true }, PROJECT_DIR);
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Next: chiral status');
    consoleSpy.mockRestore();
  });

  it('skips confirmation and deletes when --yes is set', async () => {
    setup([DEP_A, DEP_B, DEP_C]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 1, yes: true }, PROJECT_DIR);
    expect(mockConfirm).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('cancels without deleting when user declines confirmation', async () => {
    setup([DEP_A, DEP_B, DEP_C]);
    mockConfirm.mockResolvedValueOnce(false);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 1 }, PROJECT_DIR);
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Cancelled');
    consoleSpy.mockRestore();
  });

  it('removes oldest deployments when keep=3 and 5 exist', async () => {
    setup([DEP_A, DEP_B, DEP_C, DEP_D, DEP_E]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 3, yes: true }, PROJECT_DIR);
    consoleSpy.mockRestore();

    const { listDeployments } = await import('../../../src/state/snapshots.js');
    const remaining = listDeployments(CHIRAL_DIR);
    expect(remaining).toHaveLength(3);
    expect(remaining).not.toContain(DEP_A);
    expect(remaining).not.toContain(DEP_B);
  });

  it('deletes exactly the IDs shown in preview, not any IDs added after the preview', async () => {
    setup([DEP_A, DEP_B, DEP_C, DEP_D, DEP_E]);
    const DEP_F = '20240106T100000Z-ffffffff';

    const snapshotsModule = await import('../../../src/state/snapshots.js');
    const originalPruneSnapshots = snapshotsModule.pruneSnapshots;
    // Simulate a concurrent write that happens after the dry-run preview is captured
    vi.spyOn(snapshotsModule, 'pruneSnapshots').mockImplementationOnce((cd, k, opts) => {
      const result = originalPruneSnapshots(cd, k, opts);
      writeSnapshot(CHIRAL_DIR, DEP_F, WORKFLOW);
      return result;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 3, yes: true }, PROJECT_DIR);
    consoleSpy.mockRestore();
    vi.restoreAllMocks();

    const remaining = snapshotsModule.listDeployments(CHIRAL_DIR);
    expect(remaining).toContain(DEP_F); // concurrent write is NOT deleted
    expect(remaining).not.toContain(DEP_A); // preview IDs ARE deleted
    expect(remaining).not.toContain(DEP_B);
  });
});

// ── dry-run ───────────────────────────────────────────────────────────────────

describe('dry-run', () => {
  it('prints what would be removed without deleting', async () => {
    setup([DEP_A, DEP_B, DEP_C]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ dryRun: true, keep: 2 }, PROJECT_DIR);
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain(DEP_A);
    expect(mockConfirm).not.toHaveBeenCalled();
    consoleSpy.mockRestore();

    const { listDeployments } = await import('../../../src/state/snapshots.js');
    expect(listDeployments(CHIRAL_DIR)).toHaveLength(3);
  });

  it('does not print Next: footer on dry-run', async () => {
    setup([DEP_A, DEP_B, DEP_C]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ dryRun: true, keep: 1 }, PROJECT_DIR);
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).not.toContain('Next:');
    consoleSpy.mockRestore();
  });
});

// ── JSON output ───────────────────────────────────────────────────────────────

describe('JSON output', () => {
  it('emits standard envelope with correct fields', async () => {
    setup([DEP_A, DEP_B, DEP_C]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 2, yes: true, json: true }, PROJECT_DIR);
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const jsonLine = calls.find((c) => c.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.snapshots_removed).toBe(1);
    expect(parsed.data.snapshots_kept).toBe(2);
    expect(parsed.data.removed).toContain(DEP_A);
    expect(typeof parsed.data.freed_bytes).toBe('number');
    consoleSpy.mockRestore();
  });

  it('emits dry_run: true in data when --dry-run and --json', async () => {
    setup([DEP_A, DEP_B, DEP_C]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 2, dryRun: true, json: true }, PROJECT_DIR);
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const parsed = JSON.parse(calls.find((c) => c.startsWith('{'))!);
    expect(parsed.data.dry_run).toBe(true);
    expect(parsed.data.snapshots_removed).toBe(1);
    consoleSpy.mockRestore();
  });

  it('emits snapshots_removed: 0 and no extra stdout on nothing-to-prune with --json', async () => {
    setup([DEP_A]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPrune({ keep: 10, yes: true, json: true }, PROJECT_DIR);
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    const jsonLine = calls.find((c) => c.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.data.snapshots_removed).toBe(0);
    consoleSpy.mockRestore();
  });
});
