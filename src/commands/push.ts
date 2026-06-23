import chalk from 'chalk';
import ora from 'ora';
import { confirm, input } from '@inquirer/prompts';
import { Command, Option } from 'commander';
import { randomUUID } from 'node:crypto';
import { loadConfigAndDir, resolveEnv } from '../lib/config.js';
import { syncToRemote, formatSyncSuccess, formatSyncFailure} from '../lib/git-sync.js';
import { N8nClient, type WorkflowSummary, type CredentialSummary, type TagSummary } from '../lib/n8n-client.js';
import { UserError, ControlledExit } from '../lib/errors.js';
import { getGitActor } from '../lib/git.js';
import { failSpinner, plural, matchesGlob, formatAge, getChiralVersion } from '../lib/cli.js';
import { printJson } from '../lib/output.js';
import {
  loadWorkflowMap,
  writeWorkflowMap,
  resolveTargetName,
  findLogicalByEnvAndName,
  findEntryByEnvId,
  deriveSafeLogicalName,
  upsertEnvEntry,
  type WorkflowMap,
} from '../state/workflows.js';
import { listLocksByEnv } from '../state/locks.js';
import { peekEnvId } from '../state/envs.js';
import { loadCredentials, buildCredentialMap, type CredentialMapEntry, applyCredentialMap } from '../state/credentials.js';
import { loadTableMap, applyTableMap, type TableWarning } from '../state/tables.js';
import { loadUrlMap, buildUrlMap, applyUrlMap, type UrlSubstitution, type UrlWarning } from '../state/url-map.js';
import {
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  readSnapshotMeta,
  generateDeploymentId,
  writeSnapshot,
  writeSnapshotMeta,
  type SnapshotWorkflow,
} from '../state/snapshots.js';
import { readAuditLog, writeAuditEntry, type AuditEntry } from '../state/audit.js';
import {
  computeContentHash,
  computeStructureHash,
  loadFingerprints,
  writeFingerprints,
} from '../state/fingerprints.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeWorkflowForApi(
  workflow: Record<string, unknown>,
  mode: 'create' | 'update' = 'create',
): Record<string, unknown> {
  // POST /workflows (workflowCreate schema) does not accept description - additionalProperties: false
  // PUT /workflows/:id (workflow schema) does accept description
  const allowed = new Set([
    'name',
    'nodes',
    'connections',
    'settings',
    'staticData',
    'pinData',
    ...(mode === 'update' ? ['description'] : []),
  ]);

  // Valid workflow settings fields per n8n API
  // Reference: https://docs.n8n.io/api/api-reference/
  const validSettings = new Set([
    'saveExecutionProgress',
    'saveManualExecutions',
    'saveDataErrorExecution',
    'saveDataSuccessExecution',
    'executionTimeout',
    'errorWorkflow',
    'timezone',
    'executionOrder',
    'callerPolicy',
    'callerIds',
    'timeSavedPerExecution',
    'availableInMCP',
  ]);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workflow)) {
    if (allowed.has(key)) {
      if (key === 'nodes') {
        sanitized[key] = value;
      } else if (key === 'settings' && typeof value === 'object' && value !== null) {
        // Filter settings to only include valid fields
        const settingsObj = value as Record<string, unknown>;
        const filteredSettings: Record<string, unknown> = {};
        for (const [settingKey, settingValue] of Object.entries(settingsObj)) {
          if (validSettings.has(settingKey)) {
            filteredSettings[settingKey] = settingValue;
          }
        }
        sanitized[key] = filteredSettings;
      } else {
        sanitized[key] = value;
      }
    }
  }
  return sanitized;
}

// ── Lock check helpers ────────────────────────────────────────────────────────

interface LockViolation {
  workflowId: string;
  logicalName: string;
  actor: string;
  ageSeconds: number;
  stale: boolean;
}

function collectLockViolations(
  chiralDir: string,
  sourceEnv: string,
  targetEnv: string,
  classified: WorkflowClassification[],
  workflowMap: WorkflowMap,
  targetByName: Map<string, { id: string }>,
  staleLockAfterHours: number,
  outputMode: OutputMode,
): LockViolation[] {
  const targetEnvId = peekEnvId(chiralDir, targetEnv);
  const targetLocks = targetEnvId ? listLocksByEnv(chiralDir, targetEnvId) : [];
  const lockMap = new Map(targetLocks.map(({ workflowId, lock }) => [workflowId, lock]));
  const staleLockAfterMs = staleLockAfterHours * 60 * 60 * 1000;
  const violations: LockViolation[] = [];

  for (const c of classified) {
    if (c.action === 'skipped') continue;

    let targetId: string | undefined;
    let wfLogicalName: string | undefined;

    if (c.action === 'would-update') {
      targetId = targetByName.get(c.resolvedName)?.id;
      if (targetId) {
        const found = findEntryByEnvId(workflowMap, targetEnv, targetId);
        wfLogicalName = found?.logicalName ?? c.resolvedName;
      }
    } else if (c.action === 'would-create') {
      const logicalKey = findLogicalByEnvAndName(workflowMap, sourceEnv, c.workflow.name);
      if (logicalKey) {
        const targetEntry = workflowMap.workflows[logicalKey]?.[targetEnv];
        if (targetEntry?.id) {
          targetId = targetEntry.id;
          wfLogicalName = logicalKey;
        }
      }
    }

    if (!targetId) {
      if (outputMode === 'human') {
        console.log(`  ${chalk.yellow('⚠')}  ${c.workflow.id}: cannot check for locks (not in workflow map)`);
      }
      continue;
    }

    const lock = lockMap.get(targetId);
    if (!lock) continue;

    const ageMs = Date.now() - new Date(lock.timestamp).getTime();
    const ageSeconds = Math.floor(ageMs / 1000);
    const stale = ageMs > staleLockAfterMs;
    violations.push({ workflowId: targetId, logicalName: wfLogicalName!, actor: lock.actor, ageSeconds, stale });
  }

  return violations;
}

// Records that a workflow pushed/created in targetEnv is the same logical entity
// as its counterpart in sourceEnv, reusing an existing logical name if one is mapped.
function registerWorkflowMapEntry(
  workflowMap: WorkflowMap,
  c: WorkflowClassification,
  sourceEnv: string,
  targetEnv: string,
  targetId: string,
): void {
  const existing = findLogicalByEnvAndName(workflowMap, sourceEnv, c.workflow.name);
  const logicalName = existing ?? deriveSafeLogicalName(workflowMap, c.workflow.name);
  upsertEnvEntry(workflowMap, logicalName, sourceEnv, { name: c.workflow.name, id: c.workflow.id });
  upsertEnvEntry(workflowMap, logicalName, targetEnv, { name: c.resolvedName, id: targetId });
}

// Flags would-update workflows whose live target versionId no longer matches the
// versionId chiral recorded at the last push - i.e. edited directly in the target
// instance (out-of-band drift). Uses only data already fetched; no extra API calls.
function collectTargetDrift(
  classified: WorkflowClassification[],
  targetByName: Map<string, WorkflowSummary>,
  fingerprintsForTarget: Record<string, { versionId: string }> | undefined,
): WorkflowClassification[] {
  const drifted: WorkflowClassification[] = [];
  for (const c of classified) {
    if (c.action !== 'would-update') continue;
    if (c.forceReactivate) continue; // chiral's own incomplete-reactivation retry, not out-of-band drift
    const targetSummary = targetByName.get(c.resolvedName);
    if (!targetSummary) continue;
    const lastKnown = fingerprintsForTarget?.[targetSummary.id];
    if (!lastKnown) continue; // never pushed via chiral - no reference versionId
    if (targetSummary.versionId !== lastKnown.versionId) drifted.push(c);
  }
  return drifted;
}

/** Width used for credential map column alignment */
const CRED_COL_WIDTH = 24;

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type OutputMode = 'human' | 'json';

function resolveOutputMode(options: PushOptions): OutputMode {
  if (options.json) return 'json';
  return 'human';
}

export interface PushOptions {
  from: string;
  to: string;
  dryRun?: boolean;
  tag?: string;
  pattern?: string;
  yes?: boolean;
  noActivate?: boolean;
  json?: boolean;
  check?: boolean;
  staleLockAfter?: number;
  skipDrifted?: boolean;
}

interface WorkflowClassification {
  workflow: SnapshotWorkflow;
  resolvedName: string;
  action: 'would-create' | 'would-update' | 'skipped';
  targetActive: boolean; // whether the target version is currently active
  forceReactivate: boolean; // a prior push left this workflow inactive after a successful update
}

interface TagResolution {
  name: string;
  targetId: string | null; // null = not found in target
}

// ── Dry-run implementation ────────────────────────────────────────────────────

export async function runPush(
  options: PushOptions,
): Promise<void> {

  // ── Guard: source ≠ target ────────────────────────────────────────────────
  if (options.from === options.to) {
    throw new UserError(
      `Cannot push an environment to itself - source and target are both "${options.from}"`,
    );
  }

  const { config, chiralDir } = loadConfigAndDir();

  // Validate both env names exist in config (source doesn't need a live client)
  resolveEnv(config, options.from);
  const targetEnvObj = resolveEnv(config, options.to);

  const targetClient = new N8nClient(targetEnvObj, options.to);
  targetClient.warnIfExpiringSoon();

  const outputMode = resolveOutputMode(options);

  // ── Header ────────────────────────────────────────────────────────────────
  if (outputMode === 'human' && !options.check) {
    console.log();
    const scopeLabel = [
      options.tag ? `tag: ${options.tag}` : '',
      options.pattern ? `pattern: ${options.pattern}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const scope = scopeLabel ? `  ${chalk.dim(`[${scopeLabel}]`)}` : '';
    if (options.dryRun) {
      console.log(`  Dry run: ${chalk.cyan(options.from)} → ${chalk.cyan(options.to)}${scope}`);
    } else {
      console.log(`  Pushing ${chalk.cyan(options.from)} → ${chalk.cyan(options.to)}${scope}`);
    }
  }

  // ── Snapshot check ────────────────────────────────────────────────────────
  const deploymentId = findLatestDeploymentForEnv(chiralDir, options.from);
  if (!deploymentId) {
    throw new UserError(
      `No snapshot found for ${options.from}.`,
      `  Run: chiral pull ${options.from}`,
    );
  }

  // Stale snapshot warning (>24h). A missing or unreadable meta.json is treated
  // as stale rather than silently skipping this safety check (a torn meta must
  // never disable the prompt).
  const meta = readSnapshotMeta(chiralDir, deploymentId);
  if (outputMode === 'human') {
    const STALE_MS = 24 * 60 * 60 * 1000;
    const snapshotAge = meta ? Date.now() - new Date(meta.timestamp).getTime() : null;
    const stale = snapshotAge === null || snapshotAge > STALE_MS;
    if (stale) {
      console.log();
      if (snapshotAge !== null) {
        const days = Math.floor(snapshotAge / (1000 * 60 * 60 * 24));
        const ageStr = `${days} day${days === 1 ? '' : 's'}`;
        const snapshotDate = new Date(meta!.timestamp).toLocaleDateString();
        console.log(
          `  ${chalk.yellow('⚠')}  Snapshot for ${chalk.cyan(options.from)} is ${ageStr} old (taken: ${snapshotDate}).`,
        );
      } else {
        console.log(
          `  ${chalk.yellow('⚠')}  Snapshot metadata for ${chalk.cyan(options.from)} is missing or unreadable; its age cannot be verified.`,
        );
      }
      console.log(
        `     Run ${chalk.dim(`'chiral pull ${options.from}'`)} to refresh before pushing.`,
      );
      console.log();

      if (!options.yes) {
        const proceed = await confirm({
          message: 'Push from snapshot anyway?',
          default: false,
        });
        if (!proceed) throw new ControlledExit(0);
      }
    }
  }

  // ── Load snapshot workflows ───────────────────────────────────────────────
  const { workflows: snapshotWorkflowsRaw, corruptCount } = readAllWorkflowsInDeployment(chiralDir, deploymentId);
  if (corruptCount > 0) {
    console.error(
      `  Warning: ${corruptCount} snapshot file${corruptCount === 1 ? '' : 's'} in deployment ${deploymentId} ${corruptCount === 1 ? 'is' : 'are'} corrupted and were skipped.`,
    );
    console.error(`     Run 'chiral pull ${options.from}' to refresh the snapshot.`);
  }
  let snapshotWorkflows = snapshotWorkflowsRaw;

  // Apply client-side filters
  snapshotWorkflows = snapshotWorkflows.filter((wf) => {
    if (
      options.tag &&
      !((wf as Record<string, unknown>)['tags'] as Array<{ name: string }> | undefined)
        ?.some((t) => t.name === options.tag)
    ) return false;
    if (options.pattern && !matchesGlob(wf.name, options.pattern)) return false;
    return true;
  });

  if (snapshotWorkflows.length === 0) {
    if (outputMode === 'human') {
      console.log();
      const scopeDesc = options.tag ? ` tagged "${options.tag}"` : options.pattern ? ` matching "${options.pattern}"` : '';
      console.log(`  ${chalk.yellow('⚠')} No workflows${scopeDesc} found in snapshot for ${chalk.cyan(options.from)}.`);
      console.log();
    } else {
      printJson({
        from: options.from, to: options.to, dry_run: options.dryRun ?? false,
        deployment_id: deploymentId, created: [], updated: [], skipped: [], failed: [],
        credential_map: [], tag_warnings: [], credential_errors: [], target_drifted: [],
      });
    }
    return;
  }

  // ── Fetch from target (parallel) ─────────────────────────────────────────
  const spinner = outputMode === 'human'
    ? ora({ text: `  Fetching ${chalk.cyan(options.to)} workflows…`, color: 'cyan' }).start()
    : null;

  let targetSummaries: WorkflowSummary[];
  let targetCreds: CredentialSummary[];
  let targetTags: TagSummary[];

  try {
    [targetSummaries, targetCreds, targetTags] = await Promise.all([
      targetClient.listWorkflows(),
      targetClient.listCredentials(),
      targetClient.listTags(),
    ]);
  } catch (err) {
    if (spinner) failSpinner(spinner, err);
    throw err;
  }

  if (spinner) {
    spinner.succeed(
      chalk.green(
        `  Fetched ${plural(targetSummaries.length, 'workflow')} from ${options.to}`,
      ),
    );
  }

  // ── Name resolution + classification ─────────────────────────────────────
  const workflowMap = loadWorkflowMap(chiralDir);
  const targetByName = new Map<string, WorkflowSummary>(
    targetSummaries.map((w) => [w.name, w]),
  );
  const targetCredNames = new Set(targetCreds.map((c) => c.name));
  const targetTagMap = new Map<string, string>(targetTags.map((t) => [t.name, t.id]));

  const fingerprints = loadFingerprints(chiralDir);
  if (!fingerprints.envs[options.to]) fingerprints.envs[options.to] = {};

  // Credential map built from every in-scope workflow's nodes (not just the
  // ones that turn out to need updating) - classification below needs it to
  // normalize credential names before hashing, so mapped/passthrough pairs
  // collapse to the same hash and genuine swaps don't.
  const credentials = loadCredentials(chiralDir);
  const credMapForHash = buildCredentialMap(
    snapshotWorkflows.flatMap((wf) => {
      const nodes = (wf as Record<string, unknown>)['nodes'];
      return Array.isArray(nodes) ? (nodes as unknown[]) : [];
    }),
    options.from,
    options.to,
    credentials,
  );
  const urlMapData = loadUrlMap(chiralDir);

  const classified: WorkflowClassification[] = snapshotWorkflows.map((wf) => {
    const resolvedName = resolveTargetName(workflowMap, options.from, options.to, wf.name);
    const targetMatch = targetByName.get(resolvedName);
    if (!targetMatch) {
      return { workflow: wf, resolvedName, action: 'would-create', targetActive: false, forceReactivate: false };
    }

    const tgtEntry = fingerprints.envs[options.to]?.[targetMatch.id];

    // A prior push updated this workflow but failed to reactivate it - force
    // re-evaluation (and a reactivation attempt) regardless of version/hash.
    if (tgtEntry?.needsReactivation) {
      return { workflow: wf, resolvedName, action: 'would-update', targetActive: targetMatch.active, forceReactivate: true };
    }

    // Fast path: versionId match means definitely unchanged
    if ((wf as Record<string, unknown>)['versionId'] === targetMatch.versionId) {
      return { workflow: wf, resolvedName, action: 'skipped', targetActive: targetMatch.active, forceReactivate: false };
    }

    // Fingerprint path: compute source hash from snapshot (no API call needed),
    // compare against stored target hash if available. Normalize credential
    // names to the target env first, mirroring the remappedWorkflow that the
    // stored target hash was computed from (see SM1/S1). URL rewrite must be
    // included here too (C1) so skip-detection matches the stored hash.
    const wfNodes = ((wf as Record<string, unknown>)['nodes'] ?? []) as unknown[];
    const { substitutions: urlSubsForHash } = buildUrlMap(wfNodes, options.from, options.to, urlMapData);
    const srcHash = computeContentHash(
      applyUrlMap(applyCredentialMap(wf, credMapForHash), urlSubsForHash),
    );
    if (tgtEntry && srcHash === tgtEntry.contentHash) {
      return { workflow: wf, resolvedName, action: 'skipped', targetActive: targetMatch.active, forceReactivate: false };
    }

    return { workflow: wf, resolvedName, action: 'would-update', targetActive: targetMatch.active, forceReactivate: false };
  });

  // ── Target drift detection ──────────────────────────────────────────────
  // Must run before changeset counts so --skip-drifted reclassification is
  // reflected in toCreate/toUpdate/toSkip, credential map, and all warnings.
  const driftedClassifications = collectTargetDrift(classified, targetByName, fingerprints.envs[options.to]);
  const driftedNames = driftedClassifications.map((c) => c.resolvedName);
  const driftedNameSet = new Set(driftedNames);
  if (options.skipDrifted) {
    for (const c of driftedClassifications) c.action = 'skipped';
  }

  // ── Credential map ────────────────────────────────────────────────────────
  // Aggregate all nodes across in-scope (non-skipped) workflows
  const allNodes: unknown[] = [];
  for (const c of classified) {
    if (c.action === 'skipped') continue;
    const nodes = (c.workflow as Record<string, unknown>)['nodes'];
    if (Array.isArray(nodes)) allNodes.push(...(nodes as unknown[]));
  }
  const credMap = buildCredentialMap(allNodes, options.from, options.to, credentials);
  const tableMap = loadTableMap(chiralDir);

  const credentialErrors: CredentialMapEntry[] = [];
  for (const entry of credMap) {
    if (entry.status === 'mapped' && !targetCredNames.has(entry.targetName)) {
      credentialErrors.push(entry);
    }
  }

  // ── Tag resolution ────────────────────────────────────────────────────────
  const allTagNames = new Set<string>();
  for (const c of classified) {
    const tags = (c.workflow as Record<string, unknown>)['tags'] as Array<{ name: string }> | undefined;
    if (Array.isArray(tags)) tags.forEach((t) => allTagNames.add(t.name));
  }
  const tagResolutions: TagResolution[] = Array.from(allTagNames).map((name) => ({
    name,
    targetId: targetTagMap.get(name) ?? null,
  }));
  const tagWarnings = tagResolutions.filter((t) => t.targetId === null);

  // ── Changeset counts ─────────────────────────────────────────────────────
  const toCreate = classified.filter((c) => c.action === 'would-create');
  const toUpdate = classified.filter((c) => c.action === 'would-update');
  const toSkip = classified.filter((c) => c.action === 'skipped');

  // ── Table warnings (scan non-skipped workflows for unmapped Data Table IDs) ─
  const allTableWarnings: TableWarning[] = [];
  for (const c of classified) {
    if (c.action === 'skipped') continue;
    const { unmappedTables } = applyTableMap(
      c.workflow,
      tableMap,
      options.from,
      options.to,
    );
    for (const w of unmappedTables) {
      const existing = allTableWarnings.find((t) => t.sourceId === w.sourceId);
      if (existing) {
        for (const n of w.affectedNodes) {
          if (!existing.affectedNodes.includes(n)) existing.affectedNodes.push(n);
        }
      } else {
        allTableWarnings.push({ sourceId: w.sourceId, affectedNodes: [...w.affectedNodes] });
      }
    }
  }

  // ── URL map (aggregate substitutions and unmapped warnings across non-skipped workflows) ─
  const allUrlSubstitutions: UrlSubstitution[] = [];
  const allUrlWarnings: UrlWarning[] = [];
  for (const c of classified) {
    if (c.action === 'skipped') continue;
    const wfNodes = ((c.workflow as Record<string, unknown>)['nodes'] ?? []) as unknown[];
    const { substitutions, warnings } = buildUrlMap(wfNodes, options.from, options.to, urlMapData);
    for (const sub of substitutions) {
      const existing = allUrlSubstitutions.find((s) => s.logicalName === sub.logicalName);
      if (existing) {
        for (const n of sub.affectedNodes) {
          if (!existing.affectedNodes.includes(n)) existing.affectedNodes.push(n);
        }
      } else {
        allUrlSubstitutions.push({ ...sub, affectedNodes: [...sub.affectedNodes] });
      }
    }
    for (const w of warnings) {
      const existing = allUrlWarnings.find((u) => u.value === w.value);
      if (existing) {
        for (const n of w.affectedNodes) {
          if (!existing.affectedNodes.includes(n)) existing.affectedNodes.push(n);
        }
      } else {
        allUrlWarnings.push({ ...w, affectedNodes: [...w.affectedNodes] });
      }
    }
  }

  // ── --check: lock check gate ─────────────────────────────────────────────
  if (options.check) {
    const violations = collectLockViolations(
      chiralDir, options.from, options.to, classified, workflowMap,
      targetByName, options.staleLockAfter ?? 24, outputMode,
    );
    const clear = violations.length === 0;

    if (outputMode === 'json') {
      printJson({ clear, blocking_locks: violations, blocking_protections: [] });
    } else {
      console.log();
      console.log(`  Lock check: ${options.from} → ${options.to}`);
      console.log();
      if (clear) {
        console.log(`  ${chalk.green('✓')} No active locks on in-scope workflows.`);
      } else {
        for (const v of violations) {
          const staleNote = v.stale ? ' — may be abandoned' : '';
          console.log(`  ${chalk.yellow('⚠')}  ${v.logicalName} is locked by ${v.actor} (${formatAge(v.ageSeconds, 'long')}${staleNote}).`);
        }
        console.log();
        const n = violations.length;
        console.log(`  ${n} ${n === 1 ? 'workflow' : 'workflows'} blocked. Run 'chiral lock list --env ${options.to}' for details.`);
      }
      console.log();
    }

    throw new ControlledExit(clear ? 0 : 1);
  }

  // ── JSON dry-run preview ─────────────────────────────────────────────────
  if (outputMode === 'json' && options.dryRun) {
    printJson({
      from: options.from,
      to: options.to,
      dry_run: true,
      deployment_id: deploymentId,
      created: toCreate.map((c) => c.workflow.name),
      updated: toUpdate.map((c) => c.workflow.name),
      skipped: toSkip.map((c) => c.workflow.name),
      failed: [],
      credential_map: credMap.map(({ sourceName, targetName, status }) => ({
        sourceName, targetName, status,
      })),
      tag_warnings: tagWarnings.map((t) => t.name),
      credential_errors: credentialErrors.map(({ sourceName, targetName }) => ({
        sourceName, targetName,
      })),
      table_warnings: allTableWarnings,
      url_substitutions: allUrlSubstitutions,
      url_warnings: allUrlWarnings,
      target_drifted: driftedNames,
    });
    if (credentialErrors.length > 0) throw new ControlledExit(1);
    return;
  }

  const changeCount = toCreate.length + toUpdate.length;

  // ── JSON live push requires --yes when changes are pending ─────────────────
  if (outputMode === 'json' && changeCount > 0 && !options.yes) {
    throw new UserError(
      `${changeCount} change(s) pending for ${options.to} - pass --yes to apply them in JSON mode`,
    );
  }

  // ── Human output ─────────────────────────────────────────────────────────
  if (outputMode === 'human') console.log();

  // Credential map section
  if (outputMode === 'human' && credMap.length > 0) {
    console.log(`  Credential map:`);
    for (const entry of credMap) {
      const src = padEnd(entry.sourceName, CRED_COL_WIDTH);
      const dst = padEnd(entry.targetName, CRED_COL_WIDTH);
      if (entry.status === 'passthrough') {
        console.log(
          `    ${chalk.dim(src)} → ${chalk.dim(dst)}  ${chalk.yellow('⚠')} no mapping - passing through unchanged`,
        );
      } else if (credentialErrors.some((e) => e.sourceName === entry.sourceName)) {
        console.log(
          `    ${chalk.dim(src)} → ${chalk.red(entry.targetName)}${' '.repeat(Math.max(0, CRED_COL_WIDTH - entry.targetName.length))}  ${chalk.red('✗')} missing in ${options.to}`,
        );
      } else {
        console.log(
          `    ${chalk.dim(src)} → ${chalk.dim(dst)}  ${chalk.green('✓')} found`,
        );
      }
    }
    console.log();
  }

  // URL map section
  if (outputMode === 'human' && allUrlSubstitutions.length > 0) {
    console.log(`  URL map:`);
    for (const sub of allUrlSubstitutions) {
      const nodeCount = sub.affectedNodes.length;
      console.log(
        `    ${chalk.dim(sub.logicalName + ':')} ${chalk.dim(sub.sourceValue)} → ${chalk.dim(sub.targetValue)}  ${chalk.dim(`(${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'})`)}`,
      );
    }
    console.log();
  }

  // Credential errors - abort before showing changeset
  if (credentialErrors.length > 0) {
    if (outputMode === 'json') {
      printJson({
        from: options.from,
        to: options.to,
        dry_run: false,
        deployment_id: deploymentId,
        created: [], updated: [], skipped: [], failed: [],
        credential_map: credMap.map(({ sourceName, targetName, status }) => ({
          sourceName, targetName, status,
        })),
        tag_warnings: tagWarnings.map((t) => t.name),
        credential_errors: credentialErrors.map(({ sourceName, targetName }) => ({
          sourceName, targetName,
        })),
        table_warnings: allTableWarnings,
        url_substitutions: allUrlSubstitutions,
        url_warnings: allUrlWarnings,
        target_drifted: driftedNames,
      });
    } else {
      const hint = credentialErrors.map((e) => {
        const logical = e.logicalName ?? e.sourceName;
        return `  chiral credential map ${logical} ${options.to}=${e.targetName}`;
      });
      console.log(
        `  ${chalk.red('✗')}  Cannot push - ${plural(credentialErrors.length, 'credential')} not found in ${chalk.cyan(options.to)}. Map ${credentialErrors.length === 1 ? 'it' : 'them'} to an existing ${chalk.cyan(options.to)} credential:`,
      );
      for (const h of hint) console.log(chalk.dim(h));
      console.log(chalk.dim(`  To see available credentials: chiral credential list --env ${options.to}`));
      console.log();
    }
    throw new ControlledExit(1);
  }

  // Changeset
  if (outputMode === 'human') {
    for (const c of toCreate) {
      const wasMapped = c.resolvedName !== c.workflow.name;
      const createNote = wasMapped
        ? `will be created as "${c.resolvedName}" - run: chiral workflow map --validate to check`
        : 'will be created';
      console.log(
        `  ${chalk.green('+')} ${c.resolvedName}  ${chalk.dim(`(${createNote})`)}`,
      );
    }
    for (const c of toUpdate) {
      const activeNote = c.targetActive ? ' - active, will be paused briefly' : '';
      console.log(
        `  ${chalk.yellow('~')} ${c.resolvedName}  ${chalk.dim(`(will be updated${activeNote})`)}`,
      );
    }
    for (const c of toSkip) {
      const note = options.skipDrifted && driftedNameSet.has(c.resolvedName)
        ? `(skipped — edited directly in ${options.to}, use --skip-drifted)`
        : '(already up to date - skipped)';
      console.log(`  ${chalk.dim('─')} ${c.resolvedName}  ${chalk.dim(note)}`);
    }

    // Tag warnings
    if (tagWarnings.length > 0) {
      console.log();
      for (const tw of tagWarnings) {
        console.log(
          `  ${chalk.yellow('⚠')}  Tag "${tw.name}" not found in ${chalk.cyan(options.to)} - it will not be assigned to pushed workflows`,
        );
      }
    }

    // Table warnings
    if (allTableWarnings.length > 0) {
      console.log();
      for (const tw of allTableWarnings) {
        console.log(
          `  ${chalk.yellow('⚠')}  Table ID "${tw.sourceId}" has no ${chalk.cyan(options.to)} mapping.`,
        );
        console.log(`     Affected nodes: ${tw.affectedNodes.join(', ')}`);
        console.log(
          `     Fix: ${chalk.dim(`chiral table map <name> ${options.from}=${tw.sourceId} ${options.to}=<${options.to}-id>`)}`,
        );
      }
    }

    // URL warnings
    if (allUrlWarnings.length > 0) {
      console.log();
      for (const uw of allUrlWarnings) {
        const nodeList = uw.affectedNodes.join(', ');
        console.log(
          `  ${chalk.yellow('⚠')}  Unmapped URL: ${uw.value}  ${chalk.dim(`(${nodeList})`)}`,
        );
        console.log(
          chalk.dim(`     → Run: chiral url map add ${uw.suggestedKey} ${options.from}=${uw.value} ${options.to}=<value>`),
        );
      }
    }
  }

  // ── Target drift: warn, prompt, or hard-error ────────────────────────────
  // When --skip-drifted is set the drifted entries are already reclassified to
  // skipped above, so this block is suppressed.
  if (driftedNames.length > 0 && !options.skipDrifted) {
    if (outputMode === 'human') {
      console.log();
      console.log(
        `  ${chalk.yellow('⚠')}  ${plural(driftedNames.length, 'workflow')} ${driftedNames.length === 1 ? 'was' : 'were'} edited directly in ${chalk.cyan(options.to)} since the last push:`,
      );
      for (const name of driftedNames) console.log(`       ${chalk.dim('•')} ${name}`);
      console.log(
        `     Run ${chalk.dim(`'chiral diff --from ${options.to} --to ${options.from}'`)} to inspect changes.`,
      );
      console.log();
    }

    // Dry-run: warning only, no prompt, no error regardless of --yes.
    if (!options.dryRun) {
      if (options.yes) {
        // --yes alone is a hard safety error so CI fails loudly rather than
        // silently overwriting out-of-band edits.
        throw new UserError(
          `Target drift detected in ${options.to} — ${plural(driftedNames.length, 'workflow')} edited outside chiral: ${driftedNames.join(', ')}.`,
          `  Use --skip-drifted to push remaining workflows, or run 'chiral pull ${options.to}' to sync first.`,
        );
      }
      const proceed = await confirm({ message: 'Push anyway?', default: false });
      if (!proceed) throw new ControlledExit(0);
    }
  }

  // ── Dry-run mode: show summary and exit ──────────────────────────────────
  if (options.dryRun) {
    console.log();
    if (changeCount === 0) {
      console.log(`  ${chalk.green('✓')} ${chalk.cyan(options.from)} and ${chalk.cyan(options.to)} are already in sync - no changes needed`);
    } else {
      console.log(
        `  ${plural(changeCount, 'change')}. Run without ${chalk.dim('--dry-run')} to apply.`,
      );
    }

    const nextParts = [
      `--from ${options.from}`,
      `--to ${options.to}`,
      options.tag ? `--tag ${options.tag}` : '',
      options.pattern ? `--pattern "${options.pattern}"` : '',
    ].filter(Boolean);

    console.log(`\n  ${chalk.dim('Next:')} chiral push ${nextParts.join(' ')}`);
    console.log();
    return;
  }

  // ── Live push mode ──────────────────────────────────────────────────────

  // No changes needed
  if (changeCount === 0) {
    if (outputMode === 'json') {
      printJson({
        from: options.from,
        to: options.to,
        dry_run: false,
        deployment_id: deploymentId,
        created: [],
        updated: [],
        skipped: toSkip.map((c) => c.workflow.name),
        failed: [],
        credential_map: credMap.map(({ sourceName, targetName, status }) => ({
          sourceName, targetName, status,
        })),
        tag_warnings: tagWarnings.map((t) => t.name),
        credential_errors: [],
        table_warnings: allTableWarnings,
        url_substitutions: allUrlSubstitutions,
        url_warnings: allUrlWarnings,
        target_drifted: driftedNames,
      });
    } else {
      console.log();
      console.log(`  ${chalk.green('✓')} ${chalk.cyan(options.from)} and ${chalk.cyan(options.to)} are already in sync - no changes needed`);
      console.log();
    }
    return;
  }

  // ── Concurrent push detection ───────────────────────────────────────────
  if (!options.yes) {
    const auditLog = readAuditLog(chiralDir);
    const lastPullFromTarget = auditLog
      .filter((e) => e.action === 'pull' && e.target_env === options.to)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    const lastPushToTarget = auditLog
      .filter((e) => e.action === 'push' && e.target_env === options.to)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    if (lastPushToTarget && lastPullFromTarget) {
      const pushTime = new Date(lastPushToTarget.timestamp);
      const pullTime = new Date(lastPullFromTarget.timestamp);
      if (pushTime > pullTime) {
        console.log();
        const hoursAgo = Math.floor((Date.now() - pushTime.getTime()) / (1000 * 60 * 60));
        const timeStr = hoursAgo === 0 ? 'just now' : `${hoursAgo} ${hoursAgo === 1 ? 'hour' : 'hours'} ago`;
        console.log(`  ${chalk.yellow('⚠')}  ${options.to} was last pushed by ${lastPushToTarget.actor} ${timeStr}.`);
        console.log(`     You may be overwriting their changes.`);
        console.log(`     Run 'chiral diff --from ${options.to} --to ${options.from}' to check.`);
        console.log();

        const proceed = await confirm({
          message: 'Push anyway?',
          default: false,
        });
        if (!proceed) throw new ControlledExit(0);
      }
    }
  }

  // ── Lock check (live push) ────────────────────────────────────────────────
  {
    const lockViolations = collectLockViolations(
      chiralDir, options.from, options.to, classified, workflowMap,
      targetByName, options.staleLockAfter ?? 24, outputMode,
    );

    if (lockViolations.length > 0) {
      if (outputMode === 'human') {
        console.log();
        for (const v of lockViolations) {
          const staleNote = v.stale ? ` — may be abandoned` : '';
          console.log(`  ${chalk.yellow('⚠')}  ${v.logicalName} is locked by ${v.actor} (${formatAge(v.ageSeconds, 'long')}${staleNote}).`);
        }
      }

      if (!options.yes) {
        const proceed = await confirm({ message: 'Push anyway?', default: false });
        if (!proceed) throw new ControlledExit(0);
      }
    }
  }

  // ── Confirmation prompt ─────────────────────────────────────────────────
  if (!options.yes) {
    console.log();

    // Type-to-confirm for prod, yes/no for others
    const isProd = options.to.toLowerCase().includes('prod');
    if (isProd) {
      console.log(
        `  ${chalk.yellow('⚠')}  Pushing to ${options.to} - review changes above carefully.`,
      );
      await input({
        message: `Type "${options.to}" to confirm:`,
        validate: (v) => v === options.to
          ? true
          : `Type exactly "${options.to}" to confirm`,
      });
    } else {
      const proceed = await confirm({
        message: `${changeCount} ${changeCount === 1 ? 'change' : 'changes'} to ${options.to}. Continue?`,
        default: false,
      });
      if (!proceed) throw new ControlledExit(0);
    }
  }

  // ── Create pre-push snapshot ────────────────────────────────────────────
  const targetDeploymentId = generateDeploymentId();
  const preSnapshotSpinner = outputMode === 'human'
    ? ora({ text: `  Creating pre-push snapshot…`, color: 'cyan' }).start()
    : null;

  try {
    const inScopeWorkflows = classified.filter((c) => c.action !== 'skipped');
    const inScopeTargetWorkflows = inScopeWorkflows
      .map((c) => targetByName.get(c.resolvedName))
      .filter((w): w is WorkflowSummary => w !== undefined);
    const fullWorkflows = await Promise.all(
      inScopeTargetWorkflows.map((w) => targetClient.getWorkflow(w.id)),
    );
    for (const fullWorkflow of fullWorkflows) {
      writeSnapshot(chiralDir, targetDeploymentId, fullWorkflow);
    }
    writeSnapshotMeta(chiralDir, targetDeploymentId, {
      deployment_id: targetDeploymentId,
      env: options.to,
      command: 'push',
      timestamp: new Date().toISOString(),
      workflow_count: inScopeWorkflows.length,
      filters: { tag: options.tag ?? null, pattern: options.pattern ?? null, onlyActive: false, id: null },
    });
  } catch (err) {
    if (preSnapshotSpinner) failSpinner(preSnapshotSpinner, err);
    throw err;
  }

  if (preSnapshotSpinner) {
    preSnapshotSpinner.succeed(
      chalk.green(`  Snapshot saved`) + chalk.dim(` → .chiral/snapshots/${targetDeploymentId}/`),
    );
  }

  // ── Apply changes ──────────────────────────────────────────────────────
  if (outputMode === 'human') console.log();
  const results = {
    created: [] as string[],
    updated: [] as string[],
    skipped: [] as string[],
    failed: [] as Array<{ name: string; error: string }>,
    reactivationFailed: [] as Array<{ name: string; error: string }>,
  };
  let mapDirty = false;
  let fingerprintsDirty = false;

  for (const c of classified) {
    if (c.action === 'skipped') {
      if (outputMode === 'human') {
        console.log(`  ${chalk.dim('─')} ${c.resolvedName}  ${chalk.dim('(already up to date - skipped)')}`);
      }
      results.skipped.push(c.workflow.name);
      continue;
    }

    const sourceWorkflow = c.workflow as Record<string, unknown>;
    const credRemappedWorkflow = applyCredentialMap(sourceWorkflow, credMap);
    const { workflow: tableRemappedWorkflow } = applyTableMap(credRemappedWorkflow, tableMap, options.from, options.to);
    const { substitutions: urlSubsForBody } = buildUrlMap(
      (sourceWorkflow['nodes'] ?? []) as unknown[],
      options.from,
      options.to,
      urlMapData,
    );
    const remappedWorkflow = applyUrlMap(tableRemappedWorkflow, urlSubsForBody);
    const sanitizedForCreate = sanitizeWorkflowForApi(remappedWorkflow, 'create');
    const sanitizedForUpdate = sanitizeWorkflowForApi(remappedWorkflow, 'update');
    const targetWorkflow = targetByName.get(c.resolvedName);

    try {
      if (c.action === 'would-create') {
        // Prompt for new workflows unless --yes
        if (!options.yes) {
          const createIt = await confirm({
            message: `"${c.resolvedName}" doesn't exist in ${options.to} yet - create it?`,
            default: false,
          });
          if (!createIt) {
            if (outputMode === 'human') {
              console.log(`  ${chalk.dim('─')} ${c.resolvedName}  ${chalk.dim('(skipped at user request)')}`);
            }
            results.skipped.push(c.workflow.name);
            continue;
          }
        }

        const createResult = await targetClient.createWorkflow(sanitizedForCreate as Parameters<typeof targetClient.createWorkflow>[0]);

        // POST does not accept description - follow up with PUT if source has one
        if (typeof sourceWorkflow['description'] === 'string' && sourceWorkflow['description']) {
          await targetClient.updateWorkflow(createResult.id, sanitizedForUpdate as Parameters<typeof targetClient.updateWorkflow>[1]);
        }

        fingerprints.envs[options.to][createResult.id] = {
          name: c.resolvedName,
          versionId: createResult.versionId,
          contentHash: computeContentHash(remappedWorkflow),
          structureHash: computeStructureHash(remappedWorkflow),
          updatedAt: new Date().toISOString(),
        };
        fingerprintsDirty = true;

        // Auto-register workflow map entry with IDs from both envs
        registerWorkflowMapEntry(workflowMap, c, options.from, options.to, createResult.id);
        mapDirty = true;

        if (outputMode === 'human') {
          const mappedNote = c.resolvedName !== c.workflow.name
            ? ` ${chalk.dim(`(mapped from "${c.workflow.name}")`)}` : '';
          console.log(`  ${chalk.green('✓')} Created  ${c.resolvedName}${mappedNote}`);
        }
        results.created.push(c.workflow.name);
      } else if (c.action === 'would-update' && targetWorkflow) {
        // Warn and confirm for active workflows with ongoing executions
        if (targetWorkflow.active && !options.yes) {
          console.log();
          console.log(
            `  ${chalk.yellow('⚠')}  "${c.resolvedName}" is active. Ongoing executions will continue with the old workflow definition.`,
          );
          const updateIt = await confirm({
            message: 'Update anyway?',
            default: false,
          });
          if (!updateIt) {
            console.log(`  ${chalk.dim('─')} ${c.resolvedName}  ${chalk.dim('(skipped at user request)')}`);
            results.skipped.push(c.workflow.name);
            console.log();
            continue;
          }
          console.log();
        }

        // Deactivate if active
        if (targetWorkflow.active) {
          await targetClient.deactivateWorkflow(targetWorkflow.id);
        }

        // Update
        let updateResult;
        try {
          updateResult = await targetClient.updateWorkflow(targetWorkflow.id, sanitizedForUpdate as Parameters<typeof targetClient.updateWorkflow>[1]);
        } catch (updateErr) {
          // Best-effort restore so a failed update doesn't leave a previously
          // active workflow stuck deactivated.
          if (targetWorkflow.active) {
            try {
              await targetClient.activateWorkflow(targetWorkflow.id);
            } catch (restoreErr) {
              const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
              console.error(`  ${chalk.yellow('⚠')}  ${c.resolvedName} is now inactive - manual reactivation needed (restore failed: ${restoreMsg})`);
            }
          }
          throw updateErr;
        }
        // Auto-register workflow map entry with IDs from both envs
        registerWorkflowMapEntry(workflowMap, c, options.from, options.to, targetWorkflow.id);
        mapDirty = true;

        // Reactivate if it was active before this push, or a prior push left it
        // inactive after a successful update, and --no-activate not set.
        const shouldReactivate = (targetWorkflow.active || c.forceReactivate) && !options.noActivate;

        if (shouldReactivate) {
          try {
            await targetClient.activateWorkflow(targetWorkflow.id);
            fingerprints.envs[options.to][targetWorkflow.id] = {
              name: c.resolvedName,
              versionId: updateResult.versionId,
              contentHash: computeContentHash(remappedWorkflow),
              structureHash: computeStructureHash(remappedWorkflow),
              updatedAt: new Date().toISOString(),
            };
            fingerprintsDirty = true;
            if (outputMode === 'human') {
              console.log(`  ${chalk.green('✓')} Updated  ${c.resolvedName}  ${chalk.dim('(reactivated)')}`);
            }
            results.updated.push(c.workflow.name);
          } catch (reactivateErr) {
            // The update succeeded but the workflow is now left inactive. Do not
            // record a "current" fingerprint - mark it so the next push
            // re-attempts reactivation instead of reporting "up to date".
            const reactivateMsg = reactivateErr instanceof Error ? reactivateErr.message : String(reactivateErr);
            fingerprints.envs[options.to][targetWorkflow.id] = {
              name: c.resolvedName,
              versionId: updateResult.versionId,
              contentHash: computeContentHash(remappedWorkflow),
              structureHash: computeStructureHash(remappedWorkflow),
              updatedAt: new Date().toISOString(),
              needsReactivation: true,
            };
            fingerprintsDirty = true;
            if (outputMode === 'human') {
              console.log(`  ${chalk.yellow('⚠')}  Updated  ${c.resolvedName}  ${chalk.dim('(reactivation failed - manual reactivation needed)')}`);
              console.log(`    ${chalk.dim(reactivateMsg)}`);
            }
            results.updated.push(c.workflow.name);
            results.reactivationFailed.push({ name: c.workflow.name, error: reactivateMsg });
          }
        } else {
          fingerprints.envs[options.to][targetWorkflow.id] = {
            name: c.resolvedName,
            versionId: updateResult.versionId,
            contentHash: computeContentHash(remappedWorkflow),
            structureHash: computeStructureHash(remappedWorkflow),
            updatedAt: new Date().toISOString(),
          };
          fingerprintsDirty = true;
          if (outputMode === 'human') {
            console.log(`  ${chalk.green('✓')} Updated  ${c.resolvedName}`);
          }
          results.updated.push(c.workflow.name);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (outputMode === 'human') {
        console.log(`  ${chalk.red('✗')} Failed   ${c.resolvedName}  ${chalk.dim(`(${msg})`)}`);
      }
      results.failed.push({ name: c.workflow.name, error: msg });
    }
  }

  // ── Persist fingerprints / workflow map if any entries were added/updated ────
  if (fingerprintsDirty) writeFingerprints(chiralDir, fingerprints);
  if (mapDirty) writeWorkflowMap(chiralDir, workflowMap);

  // ── Audit log entry ────────────────────────────────────────────────────
  const actor = getGitActor();
  const auditEntry: AuditEntry = {
    event_id: randomUUID(),
    event_schema_version: 1,
    timestamp: new Date().toISOString(),
    actor,
    action: 'push',
    project: config.project,
    source_env: options.from,
    target_env: options.to,
    workflow_ids: [...results.created, ...results.updated],
    result: results.failed.length === 0 ? 'success' : results.created.length + results.updated.length === 0 ? 'failure' : 'partial',
    error: results.failed.length > 0 ? `${results.failed.length} workflow(s) failed` : null,
    chiral_version: getChiralVersion(),
  };
  writeAuditEntry(chiralDir, auditEntry);

  // ── Summary ────────────────────────────────────────────────────────────
  if (outputMode === 'json') {
    printJson({
      from: options.from,
      to: options.to,
      dry_run: false,
      deployment_id: targetDeploymentId,
      created: results.created,
      updated: results.updated,
      skipped: results.skipped,
      failed: results.failed,
      reactivation_failed: results.reactivationFailed,
      credential_map: credMap.map(({ sourceName, targetName, status }) => ({
        sourceName, targetName, status,
      })),
      tag_warnings: tagWarnings.map((t) => t.name),
      credential_errors: [],
      table_warnings: allTableWarnings,
      url_substitutions: allUrlSubstitutions,
      url_warnings: allUrlWarnings,
      target_drifted: driftedNames,
    });
  } else {
    console.log();
    if (results.failed.length === 0) {
      console.log(
        `  ${chalk.green('✓')} Push complete - ${plural(results.created.length + results.updated.length, 'change')}`,
      );
      console.log(`    Deployment: ${targetDeploymentId}`);
    } else {
      console.log(
        `  ${chalk.red('✗')} Push incomplete - ${plural(results.created.length + results.updated.length, 'change')} of ${plural(changeCount, 'change')} applied.`,
      );
      console.log(`    Pre-push snapshot saved at .chiral/snapshots/${targetDeploymentId}/`);
      if (results.failed.length > 0) {
        console.log(`    Failed: ${results.failed.map((f) => f.name).join(', ')}`);
      }
    }

    console.log();
    console.log(`  ${chalk.dim('Next:')} chiral pull ${options.to}`);
    console.log();
  }

  // ── Git sync ───────────────────────────────────────────────────────────────
  if (outputMode === 'human' && results.failed.length === 0) {
    const commitMsg = `chore(chiral): push ${options.from}→${options.to}`;
    const syncResult = await syncToRemote(chiralDir, config, commitMsg);
    if (!syncResult.skipped && !syncResult.nothingToCommit) {
      if (syncResult.success) {
        console.log(formatSyncSuccess(syncResult));
      } else {
        for (const line of formatSyncFailure(syncResult)) console.log(chalk.yellow(line));
      }
      console.log();
    }
  }

  if (results.failed.length > 0) {
    throw new ControlledExit(1);
  }
}

// ── Commander definition ──────────────────────────────────────────────────────

export const pushCommand = new Command('push')
  .description('Push workflows from a source environment to a target environment')
  .requiredOption('--from <env>', 'Source environment (reads from local snapshot)')
  .requiredOption('--to <env>', 'Target environment (the n8n instance to write to)')
  .option('--dry-run', 'Preview changes only - no writes made')
  .option('--tag <tag>', 'Only push workflows with this tag')
  .option('--pattern <glob>', 'Glob pattern matched against workflow names (e.g. "Customer *")')
  .addOption(new Option('--yes', 'Skip all confirmation prompts - for CI/scripted use').conflicts('dryRun'))
  .addOption(new Option('--no-activate', 'Do not reactivate workflows after push (leave them inactive)').conflicts('dryRun'))
  .option('--json', 'Output machine-readable JSON instead of human output')
  .option('--skip-drifted', 'Skip workflows edited directly in the target since the last push, and push the rest')
  .option('--check', 'Perform lock check and exit 0 (clear) or 1 (blocked) - no push executed')
  .option('--stale-lock-after <hours>', 'Hours after which a lock is considered stale (default: 24)', (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n <= 0) throw new Error('--stale-lock-after must be a positive integer (e.g. --stale-lock-after 24)');
    return n;
  })
  .addHelpText(
    'after',
    `
Examples:
  Push all workflows from dev to prod:
    chiral push --from dev --to prod

  Preview changes before pushing:
    chiral push --from dev --to prod --dry-run

  Non-interactive push for CI:
    chiral push --from dev --to prod --yes
`,
  )
  .action(async (options: PushOptions) => {
    await runPush(options);
  });
