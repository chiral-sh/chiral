import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { createFlightdeckDirectory } from '../../../src/state/init.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

beforeEach(() => vol.reset());

describe('createFlightdeckDirectory', () => {
  it('creates the .flightdeck directory', () => {
    createFlightdeckDirectory('/project/.flightdeck', 'my-project');
    expect(vol.existsSync('/project/.flightdeck')).toBe(true);
  });

  it('creates locks/ subdirectory', () => {
    createFlightdeckDirectory('/project/.flightdeck', 'my-project');
    expect(vol.existsSync('/project/.flightdeck/locks')).toBe(true);
  });

  it('creates snapshots/ subdirectory', () => {
    createFlightdeckDirectory('/project/.flightdeck', 'my-project');
    expect(vol.existsSync('/project/.flightdeck/snapshots')).toBe(true);
  });

  it('writes config.example.json with the given project name', () => {
    createFlightdeckDirectory('/project/.flightdeck', 'my-agency-client');
    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    const config = JSON.parse(raw);
    expect(config.project).toBe('my-agency-client');
  });

  it('writes config.example.json with version 1 and dev/prod environments', () => {
    createFlightdeckDirectory('/project/.flightdeck', 'test');
    const raw = vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string;
    const config = JSON.parse(raw);
    expect(config.version).toBe(1);
    expect(config.environments).toHaveProperty('dev');
    expect(config.environments).toHaveProperty('prod');
  });

  it('writes .gitignore containing config.json', () => {
    createFlightdeckDirectory('/project/.flightdeck', 'test');
    const gitignore = vol.readFileSync('/project/.flightdeck/.gitignore', 'utf-8') as string;
    expect(gitignore).toContain('config.json');
  });

  it('creates empty audit.jsonl', () => {
    createFlightdeckDirectory('/project/.flightdeck', 'test');
    const audit = vol.readFileSync('/project/.flightdeck/audit.jsonl', 'utf-8') as string;
    expect(audit).toBe('');
  });

  it('does not mutate CONFIG_EXAMPLE_TEMPLATE across calls', () => {
    createFlightdeckDirectory('/project/.flightdeck', 'project-a');
    createFlightdeckDirectory('/project2/.flightdeck', 'project-b');
    const a = JSON.parse(
      vol.readFileSync('/project/.flightdeck/config.example.json', 'utf-8') as string,
    );
    const b = JSON.parse(
      vol.readFileSync('/project2/.flightdeck/config.example.json', 'utf-8') as string,
    );
    expect(a.project).toBe('project-a');
    expect(b.project).toBe('project-b');
  });
});
