import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { findChiralDir } from '../lib/config.js';
import { UserError } from '../lib/errors.js';
import { printJson } from '../lib/output.js';
import { pruneSnapshots, deleteSnapshots } from '../state/snapshots.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PruneOptions {
  keep?: number;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validatePruneOptions(options: PruneOptions): void {
  if (options.yes && options.dryRun) {
    throw new UserError('--yes and --dry-run are mutually exclusive: --yes confirms a live deletion, --dry-run performs no deletion');
  }
  if (options.keep !== undefined) {
    if (!Number.isInteger(options.keep) || options.keep < 1) {
      throw new UserError('--keep must be a positive integer (minimum 1)');
    }
  }
  if (!!options.json && !options.yes && !options.dryRun) {
    throw new UserError(
      '--json suppresses interactive prompts — pass --yes to confirm live deletion, or --dry-run to preview without deleting',
    );
  }
  if (!process.stdin.isTTY && !options.yes && !options.dryRun) {
    throw new UserError(
      'stdin is not a TTY — pass --yes to confirm deletion non-interactively, or --dry-run to preview without deleting',
    );
  }
}

// ── Bytes formatter ───────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Run function ──────────────────────────────────────────────────────────────

export async function runPrune(options: PruneOptions, cwd?: string): Promise<void> {
  validatePruneOptions(options);

  const keep = options.keep ?? 10;
  const pl = (n: number) => (n === 1 ? 'snapshot' : 'snapshots');

  const chiralDir = findChiralDir(cwd);
  if (!chiralDir) {
    throw new UserError(
      'No .chiral directory found. Run this command from inside a chiral project.',
    );
  }

  // Preview pass — compute what would be removed without touching disk
  const preview = pruneSnapshots(chiralDir, keep, { dryRun: true });

  if (options.json) {
    if (options.dryRun) {
      printJson({
        dry_run: true,
        snapshots_removed: preview.removed.length,
        snapshots_kept: preview.keptCount,
        removed: preview.removed,
        freed_bytes: preview.freedBytes,
      });
      return;
    }
    // Live run
    deleteSnapshots(chiralDir, preview.removed);
    printJson({
      snapshots_removed: preview.removed.length,
      snapshots_kept: preview.keptCount,
      removed: preview.removed,
      freed_bytes: preview.freedBytes,
    });
    return;
  }

  // Human mode — dry-run
  if (options.dryRun) {
    console.log();
    if (preview.removed.length === 0) {
      console.log('  Nothing to prune. All snapshots are within the keep limit.');
      console.log();
      return;
    }
    console.log(`  Would remove ${preview.removed.length} ${pl(preview.removed.length)} (${formatBytes(preview.freedBytes)} freed), keeping ${preview.keptCount}:`);
    console.log();
    for (const id of preview.removed) {
      console.log(`    ${id}`);
    }
    console.log();
    return;
  }

  // Human mode — live run
  if (preview.removed.length === 0) {
    console.log();
    console.log('  Nothing to prune. All snapshots are within the keep limit.');
    console.log();
    return;
  }

  console.log();
  console.log(`  ${preview.removed.length} ${pl(preview.removed.length)} will be removed (${formatBytes(preview.freedBytes)} freed), ${preview.keptCount} kept:`);
  console.log();
  for (const id of preview.removed) {
    console.log(`    ${id}`);
  }
  console.log();

  if (!options.yes) {
    const confirmed = await confirm({
      message: `  This will permanently remove ${preview.removed.length} ${pl(preview.removed.length)} and discard their rollback points. Continue?`,
      default: false,
    });
    if (!confirmed) {
      console.log();
      console.log('  Cancelled.');
      console.log();
      return;
    }
  }

  deleteSnapshots(chiralDir, preview.removed);

  console.log();
  console.log(`  Pruned ${preview.removed.length} old ${pl(preview.removed.length)}. Kept ${preview.keptCount}.`);
  console.log();
  console.log('  Next: chiral status');
  console.log();
}

// ── Command definition ────────────────────────────────────────────────────────

export const pruneCommand = new Command('prune')
  .description('Remove old snapshot deployment directories from .chiral/snapshots/, keeping the most recent N')
  .option('--keep <n>', 'Number of most-recent snapshots to keep (default 10, minimum 1)', Number)
  .option('--dry-run', 'Show what would be removed without deleting anything')
  .option('--yes', 'Skip confirmation prompt')
  .option('--json', 'Emit standard JSON envelope to stdout instead of text output')
  .addHelpText(
    'after',
    `
Examples:
  Preview what would be removed (default keep 10):
    chiral prune --dry-run

  Remove old snapshots, keeping the 5 most recent:
    chiral prune --keep 5

  Non-interactive / CI use:
    chiral prune --keep 10 --yes

  Machine-readable output:
    chiral prune --keep 5 --yes --json

Exit codes:
  0  Success (including nothing-to-prune no-op)
  1  Invalid flags or no .chiral directory found
  2  Unexpected filesystem error during deletion

JSON output (--json):
  { snapshots_removed, snapshots_kept, removed[], freed_bytes }
  Dry-run adds: dry_run: true
`,
  )
  .action(async (opts: PruneOptions) => {
    await runPrune(opts);
  });
