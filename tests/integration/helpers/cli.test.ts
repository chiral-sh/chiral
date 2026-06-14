import { describe, it, expect } from 'vitest';
import { runCli } from './cli.js';

describe('runCli', () => {
  it('exits 0 with version on stdout for --version', async () => {
    const result = await runCli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 1 with error on stderr for an unknown command', async () => {
    const result = await runCli(['nope']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('nope');
  });

  it('exits 1 for an unknown flag', async () => {
    const result = await runCli(['push', '--not-a-real-flag']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
