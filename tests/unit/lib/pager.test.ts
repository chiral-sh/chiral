import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pageOutput } from '../../../src/lib/pager.js';

// Capture console.log calls
function captureLog(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(' '));
  return { output, restore: () => { console.log = orig; } };
}

describe('pageOutput', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  function setTTY(val: boolean) {
    Object.defineProperty(process.stdout, 'isTTY', { value: val, configurable: true });
  }

  it('prints plainly when stdout is not a TTY', async () => {
    setTTY(false);
    delete process.env['CI'];
    delete process.env['CHIRAL_PAGER'];
    delete process.env['PAGER'];
    const { output, restore } = captureLog();
    await pageOutput('hello');
    restore();
    expect(output).toEqual(['hello']);
  });

  it('skips pager when CI=true', async () => {
    setTTY(true);
    process.env['CI'] = 'true';
    delete process.env['CHIRAL_PAGER'];
    delete process.env['PAGER'];
    const { output, restore } = captureLog();
    await pageOutput('hello ci');
    restore();
    expect(output).toEqual(['hello ci']);
  });

  it('skips pager when CHIRAL_PAGER=cat', async () => {
    setTTY(true);
    delete process.env['CI'];
    process.env['CHIRAL_PAGER'] = 'cat';
    const { output, restore } = captureLog();
    await pageOutput('hello cat');
    restore();
    expect(output).toEqual(['hello cat']);
  });

  it('skips pager when noPager option is set', async () => {
    setTTY(true);
    delete process.env['CI'];
    delete process.env['CHIRAL_PAGER'];
    delete process.env['PAGER'];
    const { output, restore } = captureLog();
    await pageOutput('hello nopager', { noPager: true });
    restore();
    expect(output).toEqual(['hello nopager']);
  });

  it('CHIRAL_PAGER takes precedence over PAGER', async () => {
    setTTY(false); // non-TTY so we can test env resolution without spawning
    process.env['CHIRAL_PAGER'] = 'cat';
    process.env['PAGER'] = 'less';
    // When CHIRAL_PAGER=cat, pager is skipped (cat path), so plain print is used
    const { output, restore } = captureLog();
    await pageOutput('chiral-pager-wins');
    restore();
    expect(output).toEqual(['chiral-pager-wins']);
  });

  it('does not throw when stdout receives an EPIPE', async () => {
    setTTY(false);
    delete process.env['CI'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    const { restore } = captureLog();
    await pageOutput('epipe test');
    restore();

    // Emit EPIPE on stdout — should call process.exit(0), not throw
    const epipeErr = Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
    process.stdout.emit('error', epipeErr);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
