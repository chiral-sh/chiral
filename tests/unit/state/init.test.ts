import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { createChiralDirectory } from '../../../src/state/init.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

beforeEach(() => vol.reset());

describe('createChiralDirectory', () => {
  it('creates the .chiral directory', () => {
    createChiralDirectory('/project/.chiral', 'my-project');
    expect(vol.existsSync('/project/.chiral')).toBe(true);
  });

  it('creates locks/ subdirectory', () => {
    createChiralDirectory('/project/.chiral', 'my-project');
    expect(vol.existsSync('/project/.chiral/locks')).toBe(true);
  });

  it('creates snapshots/ subdirectory', () => {
    createChiralDirectory('/project/.chiral', 'my-project');
    expect(vol.existsSync('/project/.chiral/snapshots')).toBe(true);
  });

  it('writes config.example.json with the given project name', () => {
    createChiralDirectory('/project/.chiral', 'my-agency-client');
    const raw = vol.readFileSync('/project/.chiral/config.example.json', 'utf-8') as string;
    const config = JSON.parse(raw);
    expect(config.project).toBe('my-agency-client');
  });

  it('writes config.example.json with version 1 and dev/prod environments', () => {
    createChiralDirectory('/project/.chiral', 'test');
    const raw = vol.readFileSync('/project/.chiral/config.example.json', 'utf-8') as string;
    const config = JSON.parse(raw);
    expect(config.version).toBe(1);
    expect(config.environments).toHaveProperty('dev');
    expect(config.environments).toHaveProperty('prod');
  });

  it('writes .gitignore containing config.json', () => {
    createChiralDirectory('/project/.chiral', 'test');
    const gitignore = vol.readFileSync('/project/.chiral/.gitignore', 'utf-8') as string;
    expect(gitignore).toContain('config.json');
  });

  it('creates empty audit.jsonl', () => {
    createChiralDirectory('/project/.chiral', 'test');
    const audit = vol.readFileSync('/project/.chiral/audit.jsonl', 'utf-8') as string;
    expect(audit).toBe('');
  });

  it('creates credentials.json with version 1 and empty credentials', () => {
    createChiralDirectory('/project/.chiral', 'test');
    const raw = vol.readFileSync('/project/.chiral/credentials.json', 'utf-8') as string;
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.credentials).toEqual({});
  });

  it('does not mutate CONFIG_EXAMPLE_TEMPLATE across calls', () => {
    createChiralDirectory('/project/.chiral', 'project-a');
    createChiralDirectory('/project2/.chiral', 'project-b');
    const a = JSON.parse(
      vol.readFileSync('/project/.chiral/config.example.json', 'utf-8') as string,
    );
    const b = JSON.parse(
      vol.readFileSync('/project2/.chiral/config.example.json', 'utf-8') as string,
    );
    expect(a.project).toBe('project-a');
    expect(b.project).toBe('project-b');
  });
});
