import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import * as fs from 'node:fs';
import { createChiralDirectory } from '../../../src/state/init.js';
import { loadCredentials } from '../../../src/state/credentials.js';

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

  it('creates url-map.json with version 1 and empty urls on fresh init', () => {
    createChiralDirectory('/project/.chiral', 'test');
    const raw = vol.readFileSync('/project/.chiral/url-map.json', 'utf-8') as string;
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.urls).toEqual({});
  });

  it('does not overwrite an existing url-map.json on re-init', () => {
    vol.fromJSON({ '/project/.chiral/url-map.json': JSON.stringify({ version: 1, urls: { api_base: { values: { dev: 'https://dev.example.com' } } } }) });
    createChiralDirectory('/project/.chiral', 'test');
    const raw = vol.readFileSync('/project/.chiral/url-map.json', 'utf-8') as string;
    const parsed = JSON.parse(raw);
    expect(parsed.urls).toHaveProperty('api_base');
  });

  it('does not leave credentials.json at final path when renameSync throws during its write', () => {
    // first renameSync call inside writeJsonAtomic is for credentials.json
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => createChiralDirectory('/project/.chiral', 'test')).toThrow();
    expect(vol.existsSync('/project/.chiral/credentials.json')).toBe(false);
    renameSpy.mockRestore();
  });

  it('does not leave workflows.json at final path when renameSync throws during its write', () => {
    const originalRename = fs.renameSync;
    let callCount = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      callCount++;
      if (callCount === 2) throw new Error('disk full');
      return originalRename(...(args as Parameters<typeof fs.renameSync>));
    });
    expect(() => createChiralDirectory('/project/.chiral', 'test')).toThrow();
    expect(vol.existsSync('/project/.chiral/workflows.json')).toBe(false);
    renameSpy.mockRestore();
  });

  it('B9: loadCredentials throws "not found" (not "invalid JSON") after failed init — file is absent, not truncated', () => {
    // Before the fix, writeFileSync wrote directly to credentials.json, so a
    // failed write left a truncated file. writeJsonAtomic writes to a tmp then
    // renames, so the final path is either absent or complete — never truncated.
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => createChiralDirectory('/project/.chiral', 'test')).toThrow();
    renameSpy.mockRestore();

    // File must be absent (not truncated) — loadCredentials should surface
    // "credentials.json" (file not found), NOT "valid JSON" (invalid content).
    let thrown: unknown;
    try {
      loadCredentials('/project/.chiral');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toContain('credentials.json');
    expect((thrown as Error).message).not.toContain('valid JSON');
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
