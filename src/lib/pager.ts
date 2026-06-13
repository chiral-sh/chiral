import { spawn } from 'node:child_process';

export interface PagerOptions {
  noPager?: boolean;
}

// Registers EPIPE handler so piping to `head` exits cleanly instead of throwing.
function registerEpipeHandler(): void {
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
  });
}

function resolvedPager(): string {
  const chiralPager = process.env['CHIRAL_PAGER'];
  if (chiralPager !== undefined) return chiralPager;
  const systemPager = process.env['PAGER'];
  if (systemPager) return systemPager;
  return 'less -FIRX';
}

function shouldUsePager(opts: PagerOptions): boolean {
  if (opts.noPager) return false;
  if (process.env['CI'] === 'true') return false;
  const pager = resolvedPager();
  if (pager === 'cat' || pager === '') return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

export async function pageOutput(text: string, opts: PagerOptions = {}): Promise<void> {
  registerEpipeHandler();

  if (!shouldUsePager(opts)) {
    console.log(text);
    return;
  }

  const pagerCmd = resolvedPager();
  const [cmd, ...args] = pagerCmd.split(' ');

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });

    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') throw e;
    });

    child.on('close', () => resolve());

    child.stdin.write(text);
    child.stdin.end();
  });
}
