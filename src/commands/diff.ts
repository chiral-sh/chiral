import chalk from 'chalk';
import ora from 'ora';
import { Command, Option } from 'commander';
import { loadConfigAndDir, resolveEnv } from '../lib/config.js';
import { N8nClient, type WorkflowSummary } from '../lib/n8n-client.js';
import { ControlledExit } from '../lib/errors.js';
import { getGitActor } from '../lib/git.js';
import { failSpinner, plural, matchesGlob, formatAge } from '../lib/cli.js';
import { printJson } from '../lib/output.js';
import { loadWorkflowMap, resolveTargetName, type WorkflowMap } from '../state/workflows.js';
import { writeAuditEntry } from '../state/audit.js';
import {
  loadFingerprints,
  writeFingerprints,
  computeContentHash,
  computeStructureHash,
  type Fingerprints,
} from '../state/fingerprints.js';
import { diffWorkflowNodes, type WorkflowDiffResult } from '../lib/workflow-diff.js';
import { renderStatRows, renderNodeGroups, type StatRow } from '../lib/node-diff-render.js';
import { pageOutput } from '../lib/pager.js';
import { listLocksByEnv, type LockFile } from '../state/locks.js';
import { peekEnvId } from '../state/envs.js';

function formatLockBadgeAge(timestamp: string): { label: string; stale: boolean } {
  const ageSeconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  return { label: formatAge(ageSeconds, 'short'), stale: ageSeconds > 24 * 3600 };
}

function renderLockBadge(lock: LockFile): string {
  const { label, stale } = formatLockBadgeAge(lock.timestamp);
  const icon = stale ? ' ⚠' : '';
  return chalk.yellow(`[LOCKED${icon} by ${lock.actor}, ${label}]`);
}

interface AddedEntry {
  name: string;
  sourceName: string;
  sourceId: string;
  hint: string;
}

interface RemovedEntry {
  name: string;
  targetId: string;
}

interface ModifiedEntry {
  name: string;
  targetName: string;
  sourceId: string;
  targetId: string;
  sourceVersionId: string;
  targetVersionId: string;
  changeKind: 'structural' | 'configuration';
  nodes?: WorkflowDiffResult;
}

interface UnchangedEntry {
  name: string;
}

interface DiffResult {
  added: AddedEntry[];
  removed: RemovedEntry[];
  modified: ModifiedEntry[];
  unchanged: UnchangedEntry[];
}

interface FingerprintContext {
  fingerprints: Fingerprints;
  sourceClient: N8nClient;
  targetClient: N8nClient;
  chiralDir: string;
}

async function classifyChange(
  src: WorkflowSummary,
  tgt: WorkflowSummary,
  sourceEnv: string,
  targetEnv: string,
  ctx: FingerprintContext,
): Promise<'unchanged' | 'structural' | 'configuration'> {
  // Fast path: identical versionId means definitely the same
  if (src.versionId === tgt.versionId) return 'unchanged';

  // Fingerprint path: both entries present - compare content and structure hashes
  const srcEntry = ctx.fingerprints.envs[sourceEnv]?.[src.id];
  const tgtEntry = ctx.fingerprints.envs[targetEnv]?.[tgt.id];

  if (srcEntry && tgtEntry) {
    if (srcEntry.contentHash === tgtEntry.contentHash) return 'unchanged';
    if (srcEntry.structureHash !== tgtEntry.structureHash) return 'structural';
    return 'configuration';
  }

  // Fallback: fetch full content for whichever side is missing, compute + cache hashes
  const [srcFull, tgtFull] = await Promise.all([
    srcEntry ? Promise.resolve(null) : ctx.sourceClient.getWorkflow(src.id),
    tgtEntry ? Promise.resolve(null) : ctx.targetClient.getWorkflow(tgt.id),
  ]);

  const srcContentHash = srcEntry?.contentHash ?? computeContentHash(srcFull as Record<string, unknown>);
  const tgtContentHash = tgtEntry?.contentHash ?? computeContentHash(tgtFull as Record<string, unknown>);
  const srcStructureHash = srcEntry?.structureHash ?? computeStructureHash(srcFull as Record<string, unknown>);
  const tgtStructureHash = tgtEntry?.structureHash ?? computeStructureHash(tgtFull as Record<string, unknown>);
  const now = new Date().toISOString();

  if (!ctx.fingerprints.envs[sourceEnv]) ctx.fingerprints.envs[sourceEnv] = {};
  if (!ctx.fingerprints.envs[targetEnv]) ctx.fingerprints.envs[targetEnv] = {};

  if (!srcEntry && srcFull) {
    ctx.fingerprints.envs[sourceEnv][src.id] = {
      name: src.name,
      versionId: src.versionId,
      contentHash: srcContentHash,
      structureHash: srcStructureHash,
      updatedAt: now,
    };
  }
  if (!tgtEntry && tgtFull) {
    ctx.fingerprints.envs[targetEnv][tgt.id] = {
      name: tgt.name,
      versionId: tgt.versionId,
      contentHash: tgtContentHash,
      structureHash: tgtStructureHash,
      updatedAt: now,
    };
  }

  writeFingerprints(ctx.chiralDir, ctx.fingerprints);
  if (srcContentHash === tgtContentHash) return 'unchanged';
  if (srcStructureHash !== tgtStructureHash) return 'structural';
  return 'configuration';
}

async function computeDiff(
  sourceWorkflows: WorkflowSummary[],
  targetWorkflows: WorkflowSummary[],
  workflowMap: WorkflowMap,
  sourceEnv: string,
  targetEnv: string,
  ctx: FingerprintContext,
): Promise<DiffResult> {
  const targetByName = new Map(targetWorkflows.map((w) => [w.name, w]));
  const matchedTargetIds = new Set<string>();

  const added: AddedEntry[] = [];
  const modified: ModifiedEntry[] = [];
  const unchanged: UnchangedEntry[] = [];

  for (const src of sourceWorkflows) {
    const resolvedName = resolveTargetName(workflowMap, sourceEnv, targetEnv, src.name);
    const tgt = targetByName.get(resolvedName);

    if (!tgt) {
      const wasMapped = resolvedName !== src.name;
      const hint = wasMapped
        ? `mapped to "${resolvedName}" in ${targetEnv} but not found - does it exist?`
        : 'wrong name?';
      added.push({ name: src.name, sourceName: src.name, sourceId: src.id, hint });
    } else {
      matchedTargetIds.add(tgt.id);
      const kind = await classifyChange(src, tgt, sourceEnv, targetEnv, ctx);
      if (kind === 'unchanged') {
        unchanged.push({ name: src.name });
      } else {
        modified.push({
          name: src.name,
          targetName: resolvedName,
          sourceId: src.id,
          targetId: tgt.id,
          sourceVersionId: src.versionId,
          targetVersionId: tgt.versionId,
          changeKind: kind,
        });
      }
    }
  }

  const removed: RemovedEntry[] = targetWorkflows
    .filter((w) => !matchedTargetIds.has(w.id))
    .map((w) => ({ name: w.name, targetId: w.id }));

  return { added, removed, modified, unchanged };
}

export interface DiffOptions {
  source: string;
  target: string;
  tag?: string;
  pattern?: string;
  showUnchanged?: boolean;
  nameOnly?: boolean;
  json?: boolean;
  exitCode?: boolean;
  explain?: string;
  verbose?: boolean;
  noPager?: boolean;
}

type OutputMode = 'human' | 'json' | 'name-only';

function resolveOutputMode(options: DiffOptions): OutputMode {
  if (options.json) return 'json';
  if (options.nameOnly) return 'name-only';
  return 'human';
}

export async function runDiff(
  options: DiffOptions,
): Promise<void> {
  const actor = getGitActor();
  const { config, chiralDir } = loadConfigAndDir();
  const sourceEnvObj = resolveEnv(config, options.source);
  const targetEnvObj = resolveEnv(config, options.target);

  const sourceClient = new N8nClient(sourceEnvObj, options.source);
  const targetClient = new N8nClient(targetEnvObj, options.target);
  sourceClient.warnIfExpiringSoon();
  targetClient.warnIfExpiringSoon();

  const baseEntry = {
    event_id: crypto.randomUUID(),
    event_schema_version: 1 as const,
    timestamp: new Date().toISOString(),
    actor,
    action: 'diff' as const,
    project: config.project,
    source_env: options.source,
    target_env: options.target,
    workflow_ids: [] as string[],
    chiral_version: '0.1.0',
  };

  const outputMode = resolveOutputMode(options);
  if (outputMode === 'human') {
    console.log();
    console.log(`  Comparing ${chalk.cyan(options.source)} → ${chalk.cyan(options.target)}`);
  }

  try {
    const filterLabel = [
      options.tag ? `tag: ${options.tag}` : '',
      options.pattern ? `pattern: ${options.pattern}` : '',
    ]
      .filter(Boolean)
      .join(', ');

    const spinnerText = filterLabel
      ? `  Fetching workflows [${filterLabel}]…`
      : '  Fetching workflows…';

    const spinner = outputMode === 'human' ? ora({ text: spinnerText, color: 'cyan' }).start() : null;

    let sourceSummaries: WorkflowSummary[];
    let targetSummaries: WorkflowSummary[];

    try {
      [sourceSummaries, targetSummaries] = await Promise.all([
        sourceClient.listWorkflows({ tags: options.tag }),
        targetClient.listWorkflows({ tags: options.tag }),
      ]);
    } catch (err) {
      if (spinner) failSpinner(spinner, err);
      throw err;
    }

    // Client-side: double-check tag on both sides; pattern applied to source names only
    const sourceFiltered = sourceSummaries.filter((wf) => {
      if (options.tag && !wf.tags.some((t) => t.name === options.tag)) return false;
      if (options.pattern && !matchesGlob(wf.name, options.pattern)) return false;
      return true;
    });
    const targetFiltered = targetSummaries.filter((wf) => {
      if (options.tag && !wf.tags.some((t) => t.name === options.tag)) return false;
      return true;
    });

    if (spinner) {
      spinner.succeed(
        chalk.green(
          `  Fetched ${plural(sourceFiltered.length, 'workflow')} from ${options.source}, ` +
          `${plural(targetFiltered.length, 'workflow')} from ${options.target}`,
        ),
      );
    }

    const fingerprints = loadFingerprints(chiralDir);
    const ctx: FingerprintContext = { fingerprints, sourceClient, targetClient, chiralDir };
    const workflowMap = loadWorkflowMap(chiralDir);
    const diff = await computeDiff(sourceFiltered, targetFiltered, workflowMap, options.source, options.target, ctx);

    // Fetch full content and compute node-level diffs for every modified workflow.
    if (diff.modified.length > 0) {
      await Promise.all(
        diff.modified.map(async (entry) => {
          const [srcFull, tgtFull] = await Promise.all([
            sourceClient.getWorkflow(entry.sourceId),
            targetClient.getWorkflow(entry.targetId),
          ]);
          entry.nodes = diffWorkflowNodes(tgtFull, srcFull);
        }),
      );
    }

    // Load active locks for the target env (treat any error as no locks)
    const locksByWorkflowId = new Map<string, LockFile>();
    try {
      const targetEnvId = peekEnvId(chiralDir, options.target);
      if (targetEnvId) {
        for (const { workflowId, lock } of listLocksByEnv(chiralDir, targetEnvId)) {
          locksByWorkflowId.set(workflowId, lock);
        }
      }
    } catch {
      // treat as no locks
    }

    // Map targetName → targetId for lock badge lookup in the stat table
    const targetIdByName = new Map(diff.modified.map((w) => [w.targetName, w.targetId]));

    const hasDiff = diff.added.length > 0 || diff.removed.length > 0 || diff.modified.length > 0;

    if (outputMode === 'name-only') {
      for (const w of diff.added) console.log(w.name);
      for (const w of diff.removed) console.log(w.name);
      for (const w of diff.modified) console.log(w.targetName);
    } else if (outputMode === 'json') {
      printJson({
        source: options.source,
        target: options.target,
        added: diff.added.map(({ name, sourceName, hint }) => ({ name, sourceName, hint, lock: null })),
        removed: diff.removed.map(({ name, targetId }) => {
          const lock = locksByWorkflowId.get(targetId);
          return {
            name,
            lock: lock
              ? { actor: lock.actor, since: lock.timestamp, ageSeconds: Math.floor((Date.now() - new Date(lock.timestamp).getTime()) / 1000) }
              : null,
          };
        }),
        modified: diff.modified.map(({ targetName, targetId, sourceVersionId, targetVersionId, changeKind, nodes }) => {
          const lock = locksByWorkflowId.get(targetId);
          return {
            name: targetName,
            sourceVersionId,
            targetVersionId,
            changeKind,
            nodes: nodes ?? null,
            lock: lock
              ? { actor: lock.actor, since: lock.timestamp, ageSeconds: Math.floor((Date.now() - new Date(lock.timestamp).getTime()) / 1000) }
              : null,
          };
        }),
        unchanged: options.showUnchanged ? diff.unchanged.map(({ name }) => ({ name })) : [],
      });
    } else {
      console.log();
      if (!hasDiff && diff.unchanged.length === 0) {
        console.log(`  ${chalk.yellow('⚠')} No workflows found in scope - is this expected?`);
        console.log(
          chalk.dim(`\n  Check that both API keys have permission to list workflows.`),
        );
      } else if (!hasDiff) {
        console.log(
          `  ${chalk.green('✓')} ${chalk.cyan(options.source)} and ${chalk.cyan(options.target)} are identical - no differences found`,
        );
        if (options.showUnchanged) {
          for (const w of diff.unchanged) {
            console.log(`      ${w.name}    ${chalk.dim('(identical)')}`);
          }
        }
      } else {
        for (const w of diff.added) {
          const hintText = w.hint === 'wrong name?'
            ? 'will be created - wrong name? run: chiral workflow map'
            : w.hint;
          console.log(
            `  ${chalk.green('+')} ${w.name}    ${chalk.dim(`(${hintText})`)}`,
          );
        }
        for (const w of diff.removed) {
          const removedLock = locksByWorkflowId.get(w.targetId);
          const removedBadge = removedLock ? `  ${renderLockBadge(removedLock)}` : '';
          console.log(
            `  ${chalk.red('-')} ${w.name}    ${chalk.dim(`(in ${options.target}, not in ${options.source})`)}${removedBadge}`,
          );
        }
        if (diff.modified.length > 0) {
          const statRows: StatRow[] = diff.modified.map((w) => ({
            name: w.targetName,
            counts: w.nodes?.counts ?? { added: 0, modified: 0, removed: 0 },
            oldNodeCount: w.nodes?.oldNodeCount ?? 0,
            newNodeCount: w.nodes?.newNodeCount ?? 0,
            changeKind: w.changeKind,
          }));
          if (!options.verbose) {
            for (const { name, line } of renderStatRows(statRows)) {
              const modTargetId = targetIdByName.get(name);
              const modLock = modTargetId ? locksByWorkflowId.get(modTargetId) : undefined;
              const modBadge = modLock ? `  ${renderLockBadge(modLock)}` : '';
              console.log(`  ${line}${modBadge}`);
            }
          } else {
            const nodesByName = new Map(diff.modified.map((w) => [w.targetName, w]));
            const sections: string[] = [];
            for (const { name, line } of renderStatRows(statRows)) {
              const w = nodesByName.get(name);
              if (!w?.nodes) continue;
              const verbTargetId = targetIdByName.get(name);
              const verbLock = verbTargetId ? locksByWorkflowId.get(verbTargetId) : undefined;
              const verbBadge = verbLock ? `  ${renderLockBadge(verbLock)}` : '';
              const groups = renderNodeGroups(w.nodes);
              sections.push(`  ${line}${verbBadge}\n`);
              if (groups) {
                sections.push('\n');
                sections.push(groups.split('\n').map((l) => `  ${l}`).join('\n'));
              }
              sections.push('\n\n');
            }
            if (sections.length > 0) {
              await pageOutput(sections.join('').trimEnd(), { noPager: options.noPager });
            }
          }
        }
        if (options.explain !== undefined) {
          const match = diff.modified.find((w) => w.targetName === options.explain);
          if (match?.nodes) {
            const groups = renderNodeGroups(match.nodes);
            console.log();
            console.log(`  ${chalk.bold(options.explain)}`);
            console.log();
            for (const line of groups.split('\n')) {
              console.log(`  ${line}`);
            }
          } else {
            const modifiedNames = diff.modified.map((w) => w.targetName).join(', ');
            const suffix = modifiedNames ? `Modified: ${modifiedNames}.` : 'No modified workflows.';
            console.log();
            console.log(`  "${options.explain}" is not a modified workflow. ${suffix}`);
          }
        }
        if (options.showUnchanged) {
          for (const w of diff.unchanged) {
            console.log(`      ${w.name}    ${chalk.dim('(identical)')}`);
          }
        }

        const parts: string[] = [];
        if (diff.added.length > 0) parts.push(plural(diff.added.length, 'added', 'added'));
        if (diff.modified.length > 0) parts.push(plural(diff.modified.length, 'modified', 'modified'));
        if (diff.removed.length > 0) parts.push(plural(diff.removed.length, 'removed', 'removed'));

        const pushParts = [
          `--source ${options.source}`,
          `--target ${options.target}`,
          options.tag ? `--tag ${options.tag}` : '',
          options.pattern ? `--pattern "${options.pattern}"` : '',
          '--dry-run',
        ].filter(Boolean);
        const pushHint = `chiral push ${pushParts.join(' ')}`;

        console.log();
        console.log(`  ${parts.join(', ')}.`);
        console.log(chalk.dim(`  Run '${pushHint}' to preview.`));
        console.log(`\n  ${chalk.dim('Next:')} ${pushHint}`);
      }
      console.log();
    }

    baseEntry.workflow_ids = sourceFiltered.map((w) => w.id);
    writeAuditEntry(chiralDir, { ...baseEntry, result: 'success', error: null });
    if (options.exitCode && hasDiff) throw new ControlledExit(1);
  } catch (err) {
    if (err instanceof ControlledExit) throw err;
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      writeAuditEntry(chiralDir, { ...baseEntry, result: 'failure', error: errorMsg });
    } catch {
      // best-effort - don't mask the original error
    }
    throw err;
  }
}

export const diffCommand = new Command('diff')
  .description('Compare workflows between two n8n environments')
  .requiredOption('--source <env>', 'Source environment')
  .requiredOption('--target <env>', 'Target environment')
  .option('--tag <tag>', 'Filter to workflows with this tag (applied to both environments)')
  .option('--pattern <glob>', 'Glob pattern matched against source workflow names (e.g. "Customer *")')
  .option('--show-unchanged', 'Include identical workflows in output')
  .addOption(new Option('--name-only', 'Print only differing workflow names, one per line - suitable for piping').conflicts('json'))
  .addOption(new Option('--json', 'Output a machine-readable JSON summary instead of human output').conflicts('nameOnly'))
  .addOption(new Option('--explain <workflow>', 'Drill into one modified workflow\'s named node changes, grouped by risk').conflicts('json').conflicts('nameOnly'))
  .addOption(new Option('--verbose', 'Expand all modified workflows\' named node changes, grouped by risk, routed through pager').conflicts('json').conflicts('nameOnly'))
  .option('--no-pager', 'Disable the pager and print output directly to stdout')
  .option('--exit-code', 'Exit 1 if any differences found, 0 if environments are identical (CI use)')
  .addHelpText(
    'after',
    `
Examples:
  Compare dev and prod:
    chiral diff --source dev --target prod

  Filter to a tag:
    chiral diff --source dev --target prod --tag production

  Exit 1 if differences found (for CI):
    chiral diff --source dev --target prod --exit-code
`,
  )
  .action(async (options: Omit<DiffOptions, 'noPager'> & { pager?: boolean }) => {
    await runDiff({ ...options, noPager: options.pager === false });
  });
