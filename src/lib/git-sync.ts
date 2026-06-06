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
  'tables.json',
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
  const msg = result.message ?? '';
  const rule = classifyError(msg);
  const fix = typeof rule?.fix === 'function' ? rule.fix(msg) : rule?.fix;
  const lines: string[] = [];

  if (rule) {
    lines.push(`  ⚠ Git sync failed — ${rule.userMessage}`);
    if (fix) lines.push(`    ${fix}`);
  } else {
    lines.push(`  ⚠ Git sync failed`);
    for (const line of msg.split('\n').map((l) => l.trim()).filter(Boolean)) {
      lines.push(`    ${line}`);
    }
  }

  lines.push(`    Sync manually when ready:`);
  lines.push(`    ${result.manualCmd}`);
  return lines;
}

export function logSyncError(message: string): void {
  for (const line of message.split('\n')) {
    console.error(line);
  }
}

// ── Error classification ──────────────────────────────────────────────────────

type Fix = string | ((msg: string) => string);

interface ErrorRule {
  test: (msg: string) => boolean;
  userMessage: string;
  fix?: Fix;
}

const any = (...strings: string[]) => (msg: string) => strings.some((s) => msg.includes(s));
const all = (...strings: string[]) => (msg: string) => strings.every((s) => msg.includes(s));

// Strings verified against git source (connect.c, builtin/push.c, remote.c)
// and GitHub/GitLab server-side remote: prefix messages.
const ERROR_RULES: ErrorRule[] = [
  {
    // VSCode GIT_ASKPASS socket is scoped to the window process; unreachable from spawned children
    test: all('ECONNREFUSED', '.sock'),
    userMessage: 'git credential helper is not accessible from this process',
    fix: 'Switch to SSH: git remote set-url origin git@github.com:org/repo.git\n    Or cache HTTPS credentials: git config --global credential.helper store && git push once manually',
  },
  {
    // GitHub/GitLab server-side: repo URL is wrong, repo deleted, or not yet created
    test: any('Repository not found', 'repository not found'),
    userMessage: 'remote repository not found — check the remote URL',
    fix: 'Verify the remote: git remote -v\n    Update if wrong: git remote set-url origin <correct-url>',
  },
  {
    // Server-side HTTPS auth failure
    test: any('Authentication failed', 'Invalid username or password'),
    fix: (msg) =>
      msg.includes('https://')
        ? 'Switch to SSH: git remote set-url origin git@github.com:org/repo.git\n    Or store credentials: git config --global credential.helper store'
        : 'Check your SSH key is added: ssh-add -l\n    And the public key is registered on your git host',
    userMessage: 'authentication failed',
  },
  {
    // connect.c: "Could not read from remote repository." — SSH access denied or repo inaccessible
    test: any('Permission denied (publickey)', 'Could not read from remote repository'),
    userMessage: 'SSH key not accepted by remote',
    fix: 'Check your SSH key is added: ssh-add -l\n    And the public key is registered on your git host',
  },
  {
    // builtin/push.c: non-fast-forward rejection advice strings
    test: any('[rejected]', 'Updates were rejected', 'failed to push some refs'),
    userMessage: 'push rejected — branches have diverged',
    fix: 'Rebase: git pull --rebase then retry',
  },
  {
    // connect.c: "the remote end hung up upon initial contact"
    test: any('remote end hung up'),
    userMessage: 'connection dropped by remote',
  },
  {
    // HTTP transport: large payloads or flaky connections
    test: any('RPC failed'),
    userMessage: 'network error during push (RPC failed)',
    fix: 'Try increasing the HTTP buffer: git config http.postBuffer 524288000',
  },
  {
    // connect.c: "unable to look up %s" / OS-level network errors
    test: any('Could not resolve host', 'unable to look up', 'Network unreachable', 'ETIMEDOUT', 'ENOTFOUND'),
    userMessage: 'cannot reach remote — check your network connection',
  },
  {
    // GitHub/GitLab: authenticated but no write access to the repo
    test: any('Permission to', 'denied to', 'remote: Permission'),
    userMessage: 'permission denied — you do not have push access to this repository',
    fix: 'Check you have write access, or ask the repo owner to add you as a collaborator',
  },
  {
    // Corporate environments with self-signed or untrusted TLS certs
    test: any('SSL certificate problem', 'server certificate verification failed', 'SSL_ERROR'),
    userMessage: 'SSL certificate verification failed',
    fix: 'If using a self-signed cert, configure the CA bundle: git config http.sslCAInfo /path/to/ca.crt\n    Or (insecure) disable verification: git config http.sslVerify false',
  },
  {
    // No remote named 'origin' (or whatever gitSync.remote is set to)
    test: any('does not appear to be a git repository', 'No configured push destination', 'no such remote'),
    userMessage: 'no remote configured',
    fix: 'Add a remote: git remote add origin <url>\n    Or update gitSync.remote in .chiral/config.json',
  },
];

function classifyError(msg: string): ErrorRule | undefined {
  return ERROR_RULES.find((rule) => rule.test(msg));
}
