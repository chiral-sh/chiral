import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { Config } from './config.js';

export interface SyncResult {
  skipped: boolean;
  success: boolean;
  nothingToCommit?: boolean;
  commitMsg?: string;
  remote?: string;
  message?: string;
  manualCmd?: string;
}

// Non-secret files that belong to the team - config.json is always excluded
export const STAGED_RELATIVE: string[] = [
  'credentials.json',
  'workflows.json',
  'fingerprints.json',
  'audit.jsonl',
  'config.example.json',
  'team.json',
  'locks',
  'snapshots',
];

export async function syncToRemote(
  chiralDir: string,
  config: Config,
  commitMsg: string,
): Promise<SyncResult> {
  const gs = config.gitSync;
  if (!gs?.enabled) {
    return { skipped: true, success: true };
  }

  const { remote, branch } = gs;

  // simple-git operates relative to the repo root - one level above .chiral/
  const repoRoot = resolve(chiralDir, '..');
  const git = simpleGit(repoRoot);

  try {
    const toStage = STAGED_RELATIVE
      .map((p) => join('.chiral', p))
      .filter((p) => existsSync(join(repoRoot, p)));

    if (toStage.length > 0) {
      await git.add(toStage);
    }

    const status = await git.status();
    if (status.staged.length === 0) {
      return { skipped: false, success: true, nothingToCommit: true };
    }

    await git.commit(commitMsg);

    // Detect branch mismatch before pushing: if the configured branch doesn't
    // exist locally, git push fails with the cryptic "src refspec does not match any".
    const localBranches = await git.branchLocal();
    if (!localBranches.all.includes(branch)) {
      const current = localBranches.current || '(unknown)';
      const fixHint =
        `Your local branch is "${current}" but gitSync.branch is set to "${branch}". ` +
        `Update gitSync.branch in .chiral/config.json to "${current}", ` +
        `or run: chiral remote set --branch ${current}`;
      const manualCmd =
        `git add .chiral/ && git commit -m "${commitMsg}" && git push ${remote} ${current}`;
      return { skipped: false, success: false, message: fixHint, manualCmd };
    }

    // Strip VSCode credential helper env vars - the GIT_ASKPASS socket is scoped
    // to the VSCode window process and is unreachable from spawned subprocesses,
    // causing ECONNREFUSED. Removing these lets git fall back to the next
    // configured helper (SSH agent, macOS Keychain, GCM, credential.helper store).
    const sanitizedEnv = { ...process.env };
    if (sanitizedEnv.VSCODE_GIT_ASKPASS_NODE !== undefined) {
      // VSCode set GIT_ASKPASS to its own script; remove it so git uses the real helper
      delete sanitizedEnv.GIT_ASKPASS;
    }
    delete sanitizedEnv.VSCODE_GIT_ASKPASS_NODE;
    delete sanitizedEnv.VSCODE_GIT_ASKPASS_MAIN;
    delete sanitizedEnv.VSCODE_GIT_ASKPASS_EXTRA_ARGS;
    await git.env(sanitizedEnv).push(remote, branch);

    return { skipped: false, success: true, commitMsg, remote };
  } catch (err) {
    const fullMessage = err instanceof Error ? err.message : String(err);
    const manualCmd =
      `git add .chiral/ && git commit -m "${commitMsg}" && git push ${remote} ${branch}`;
    return { skipped: false, success: false, message: fullMessage, manualCmd };
  }
}

export function formatSyncSuccess(result: SyncResult): string {
  return `  ✓ State synced → ${result.remote}  [${result.commitMsg}]`;
}

export function formatSyncFailure(result: SyncResult): string[] {
  const { userMessage, fix } = classifyError(result.message ?? '');
  return [
    `  ⚠ Git sync failed - ${userMessage}`,
    ...(fix ? [`    ${fix}`] : []),
    `    Sync manually when ready:`,
    `    ${result.manualCmd}`,
  ];
}

export function logSyncError(fullMessage: string): void {
  console.error('\n  [git-sync] Full error output:');
  for (const line of fullMessage.split('\n')) {
    if (line.trim()) console.error(`  ${line}`);
  }
  console.error();
}

interface ErrorClassification {
  userMessage: string;
  fix?: string;
}

function classifyError(msg: string): ErrorClassification {
  // VSCode credential socket - ECONNREFUSED on a .sock path
  if (msg.includes('ECONNREFUSED') && msg.includes('.sock')) {
    return {
      userMessage: 'git credential helper is not accessible from this process',
      fix: 'Switch the remote to SSH (recommended): git remote set-url origin git@github.com:org/repo.git\n    Or cache HTTPS credentials: git config --global credential.helper store && git push once manually',
    };
  }

  // General auth / repo not found
  if (
    msg.includes('Authentication failed') ||
    msg.includes('Invalid username or password') ||
    msg.includes('Repository not found')
  ) {
    const isHttps = msg.includes('https://');
    return {
      userMessage: 'git authentication failed',
      fix: isHttps
        ? 'Switch to SSH: git remote set-url origin git@github.com:org/repo.git\n    Or store credentials: git config --global credential.helper store'
        : 'Check that your SSH key is added to the remote (ssh-add -l)',
    };
  }

  // SSH key not found
  if (msg.includes('Permission denied (publickey)') || msg.includes('Could not read from remote')) {
    return {
      userMessage: 'SSH key not accepted by remote',
      fix: 'Check that your SSH key is added: ssh-add -l\n    And that the public key is registered on your git host',
    };
  }

  // Remote rejected (non-fast-forward / diverged)
  if (msg.includes('[rejected]') || msg.includes('failed to push')) {
    return {
      userMessage: 'remote rejected the push - branches have diverged',
      fix: `Rebase your local changes: git pull --rebase ${msg.match(/\S+\.git/)?.[0] ?? 'origin'} then retry`,
    };
  }

  // Network
  if (msg.includes('Could not resolve host') || msg.includes('Network unreachable') || msg.includes('ETIMEDOUT')) {
    return {
      userMessage: 'cannot reach remote - network unreachable',
    };
  }

  // Fallback: extract the most meaningful line but keep it readable
  return { userMessage: extractBestLine(msg) };
}

function extractBestLine(msg: string): string {
  const lines = msg.split('\n').map((l) => l.trim()).filter(Boolean);
  const tier1 = lines.find((l) => l.startsWith('error:') || l.startsWith('fatal:'));
  if (tier1) return tier1;
  const tier2 = lines.find((l) => l.includes('[rejected]'));
  if (tier2) return tier2;
  const tier3 = lines.find((l) => !l.startsWith('To ') && !l.startsWith('From ') && !l.startsWith('remote:'));
  return tier3 ?? lines[0] ?? msg;
}
