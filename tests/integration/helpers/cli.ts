import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CHIRAL_TEST_CLI_TARGET=dist points the runner at the built dist/index.js
// (run with `node`) instead of src/index.ts (run with `tsx`) — used by the
// pre-release dist-smoke CI job to exercise the published artifact.
const USE_DIST = process.env.CHIRAL_TEST_CLI_TARGET === 'dist';
const CLI_ENTRY = USE_DIST
  ? path.join(__dirname, '../../../dist/index.js')
  : path.join(__dirname, '../../../src/index.ts');
const CLI_RUNNER = USE_DIST ? 'node' : 'tsx';

export interface RunCliOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string[];
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawns the CLI (`tsx src/index.ts`, or `node dist/index.js` when
 * `CHIRAL_TEST_CLI_TARGET=dist`) as a child process and captures its
 * stdout/stderr/exitCode. Never rejects on non-zero exit.
 */
export function runCli(args: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_RUNNER, [CLI_ENTRY, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    if (opts.input) {
      for (const line of opts.input) {
        child.stdin.write(`${line}\n`);
      }
    }
    child.stdin.end();

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}
