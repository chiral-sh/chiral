import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ error: null })),
  execSync: vi.fn(),
}));

import { runLog } from '../../../src/commands/log.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const GLOBAL_DIR = '/mock-global';
const PROJECT_DIR = '/project';
const CHIRAL_DIR = `${PROJECT_DIR}/.chiral`;

const INDEX = JSON.stringify({
  version: 1,
  projects: { 'test-project': { path: PROJECT_DIR, createdAt: '2024-01-01T00:00:00.000Z' } },
});

const VALID_CONFIG = JSON.stringify({
  version: 1,
  project: 'my-n8n',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'dev-key' },
    prod: { url: 'https://prod.n8n.example.com', apiKey: 'prod-key' },
  },
});

const FIXED_NOW = new Date('2026-06-05T12:00:00.000Z');

// ── Audit entry builder ────────────────────────────────────────────────────────

let uuidCounter = 0;
function makeAuditEntry(overrides: Partial<{
  timestamp: string;
  action: string;
  target_env: string;
  source_env: string | null;
  result: string;
  error: string | null;
  actor: string;
}> = {}): string {
  uuidCounter++;
  const pad = uuidCounter.toString().padStart(12, '0');
  return JSON.stringify({
    event_id: `00000000-0000-0000-0000-${pad}`,
    event_schema_version: 1,
    timestamp: overrides.timestamp ?? '2026-06-05T10:00:00.000Z',
    actor: overrides.actor ?? 'test@example.com',
    action: overrides.action ?? 'pull',
    project: 'my-n8n',
    source_env: overrides.source_env ?? null,
    target_env: overrides.target_env ?? 'dev',
    workflow_ids: [],
    result: overrides.result ?? 'success',
    error: overrides.error ?? null,
    chiral_version: '0.1.0',
  });
}

// ── Setup helpers ──────────────────────────────────────────────────────────────

function setupProject() {
  vol.fromJSON({
    [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
    [`${CHIRAL_DIR}/config.json`]: VALID_CONFIG,
    [`${CHIRAL_DIR}/audit.jsonl`]: '',
  });
}

function captureOutput() {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdoutLines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(' '));
  });
  return { stdoutLines, stderrLines };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vol.reset();
  uuidCounter = 0;
  vi.clearAllMocks();
  vi.useFakeTimers({ now: FIXED_NOW });
  process.env['CHIRAL_PROJECTS_DIR'] = GLOBAL_DIR;
  process.env['CHIRAL_PROJECT'] = 'test-project';
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env['CHIRAL_PROJECTS_DIR'];
  delete process.env['CHIRAL_PROJECT'];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runLog — basic table rendering', () => {
  it('renders box-drawing table with count header and summary footer', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'pull', target_env: 'dev' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'push', target_env: 'prod' }) + '\n');

    const { stdoutLines } = captureOutput();
    await runLog({ limit: 50 }, PROJECT_DIR);

    const output = stdoutLines.join('\n');
    expect(output).toContain('┌');
    expect(output).toContain('│');
    expect(output).toContain('└');
    expect(output).toContain('TIME');
    expect(output).toContain('ACTION');
    expect(output).toContain('ENV');
    expect(output).toContain('RESULT');
    expect(output).toContain('ACTOR');
    // count header present
    expect(output).toMatch(/Showing \d+/);
  });
});

describe('runLog — action filter', () => {
  it('returns only push entries when --action push is passed', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'pull', target_env: 'dev' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'push', target_env: 'prod' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'push', target_env: 'dev' }) + '\n');

    const { stdoutLines } = captureOutput();
    await runLog({ action: 'push' }, PROJECT_DIR);

    const output = stdoutLines.join('\n');
    expect(output).toContain('push');
    // pull should not appear in table rows (may appear in headers)
    const tableLines = output.split('\n').filter((l) => l.includes('│') && !l.includes('ACTION'));
    expect(tableLines.every((l) => !l.includes('pull'))).toBe(true);
  });
});

describe('runLog — env filter', () => {
  it('matches entries where source_env OR target_env equals the filter', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'push', target_env: 'prod', source_env: 'dev' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'pull', target_env: 'dev' }) + '\n');

    const { stdoutLines } = captureOutput();
    await runLog({ env: 'prod' }, PROJECT_DIR);

    const output = stdoutLines.join('\n');
    // Only the push (target_env=prod) should be in data rows
    const tableDataLines = output.split('\n').filter((l) => l.includes('│') && !l.includes('ACTION') && !l.includes('TIME'));
    expect(tableDataLines.length).toBeGreaterThanOrEqual(1);
    expect(tableDataLines.some((l) => l.includes('prod'))).toBe(true);
  });
});

describe('runLog — result filter', () => {
  it('shows inline error sub-line for failed entries', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({
      action: 'push',
      target_env: 'prod',
      result: 'failure',
      error: 'API key for prod is invalid',
    }) + '\n');

    const { stdoutLines } = captureOutput();
    await runLog({ result: 'failure' }, PROJECT_DIR);

    const output = stdoutLines.join('\n');
    expect(output).toContain('failed');
    expect(output).toContain('API key for prod is invalid');
  });
});

describe('runLog — since filter', () => {
  it('filters entries to within the last 24h when --since 1d is passed', async () => {
    setupProject();
    // 2 hours ago — should be included
    const recent = '2026-06-05T10:00:00.000Z';
    // 3 days ago — should be excluded
    const old = '2026-06-02T10:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: recent, actor: 'recent@example.com' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: old, actor: 'old@example.com' }) + '\n');

    const { stdoutLines } = captureOutput();
    await runLog({ since: '1d' }, PROJECT_DIR);

    const output = stdoutLines.join('\n');
    expect(output).toContain('recent@example.com');
    expect(output).not.toContain('old@example.com');
  });

  it('reads state.json sentinel and filters correctly when --since last-status is used', async () => {
    setupProject();
    // sentinel: 1 hour ago
    const sentinelTime = '2026-06-05T11:00:00.000Z';
    vol.fromJSON({
      ...vol.toJSON(),
      [`${CHIRAL_DIR}/state.json`]: JSON.stringify({ last_status_at: sentinelTime }),
    });

    // Entry after sentinel
    const after = '2026-06-05T11:30:00.000Z';
    // Entry before sentinel
    const before = '2026-06-05T10:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: before, actor: 'before@example.com' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: after, actor: 'after@example.com' }) + '\n');

    const { stdoutLines } = captureOutput();
    await runLog({ since: 'last-status' }, PROJECT_DIR);

    const output = stdoutLines.join('\n');
    expect(output).toContain('after@example.com');
    expect(output).not.toContain('before@example.com');
  });

  it('throws UserError when --since last-status and state.json is absent', async () => {
    setupProject();
    // No state.json written

    await expect(runLog({ since: 'last-status' }, PROJECT_DIR)).rejects.toThrow(UserError);
    await expect(runLog({ since: 'last-status' }, PROJECT_DIR)).rejects.toThrow(/status sentinel/i);
  });
});

describe('runLog — JSON output', () => {
  it('emits standard JSON envelope with has_more: false when all entries fit', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'pull' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'push' }) + '\n');

    const { stdoutLines } = captureOutput();
    await runLog({ json: true }, PROJECT_DIR);

    const parsed = JSON.parse(stdoutLines.find((l) => l.startsWith('{'))!);
    expect(parsed.status).toBe('ok');
    expect(Array.isArray(parsed.data.entries)).toBe(true);
    expect(parsed.data.total_shown).toBe(2);
    expect(parsed.data.has_more).toBe(false);
  });

  it('sets has_more: true when more entries exist beyond --limit', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'pull' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'push' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'diff' }) + '\n');

    const { stdoutLines } = captureOutput();
    await runLog({ json: true, all: false, limit: 2 }, PROJECT_DIR);

    const parsed = JSON.parse(stdoutLines.find((l) => l.startsWith('{'))!);
    expect(parsed.data.total_shown).toBe(2);
    expect(parsed.data.has_more).toBe(true);
  });
});

describe('runLog — flag validation', () => {
  it('throws UserError when --json and --watch are combined', async () => {
    setupProject();
    await expect(runLog({ json: true, watch: true }, PROJECT_DIR)).rejects.toThrow(UserError);
    await expect(runLog({ json: true, watch: true }, PROJECT_DIR)).rejects.toThrow(/mutually exclusive/i);
  });

  it('throws UserError for unknown --action value', async () => {
    setupProject();
    await expect(runLog({ action: 'invalid' }, PROJECT_DIR)).rejects.toThrow(UserError);
    await expect(runLog({ action: 'invalid' }, PROJECT_DIR)).rejects.toThrow(/Valid actions/);
  });

  it('throws UserError for unknown --result value', async () => {
    setupProject();
    await expect(runLog({ result: 'bad' }, PROJECT_DIR)).rejects.toThrow(UserError);
    await expect(runLog({ result: 'bad' }, PROJECT_DIR)).rejects.toThrow(/Valid results/);
  });

  it('throws UserError for --limit 0', async () => {
    setupProject();
    await expect(runLog({ limit: 0 }, PROJECT_DIR)).rejects.toThrow(UserError);
    await expect(runLog({ limit: 0 }, PROJECT_DIR)).rejects.toThrow(/--limit must be a positive integer/);
  });

  it('throws UserError for unrecognized --since value', async () => {
    setupProject();
    await expect(runLog({ since: 'xyz' }, PROJECT_DIR)).rejects.toThrow(UserError);
    await expect(runLog({ since: 'xyz' }, PROJECT_DIR)).rejects.toThrow(/Unrecognized --since/);
  });
});

describe('runLog — empty and missing audit log', () => {
  it('exits 0 and prints "No activity recorded yet." when audit.jsonl is missing', async () => {
    vol.fromJSON({
      [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
      [`${CHIRAL_DIR}/config.json`]: VALID_CONFIG,
      // No audit.jsonl
    });

    const { stdoutLines } = captureOutput();
    await expect(runLog({}, PROJECT_DIR)).resolves.not.toThrow();

    const output = stdoutLines.join('\n');
    expect(output).toContain('No activity recorded yet.');
  });
});

describe('runLog — corrupt audit.jsonl', () => {
  it('prints stderr warning and renders valid entries when tail line is corrupt', async () => {
    setupProject();
    const validEntry = makeAuditEntry({ action: 'pull', target_env: 'dev' });
    vol.writeFileSync(`${CHIRAL_DIR}/audit.jsonl`, validEntry + '\n{not valid json}\n');

    const { stdoutLines, stderrLines } = captureOutput();
    await expect(runLog({}, PROJECT_DIR)).resolves.not.toThrow();

    // Warning emitted to stderr
    expect(stderrLines.some((l) => l.includes('malformed'))).toBe(true);
    // Valid entries still rendered
    const output = stdoutLines.join('\n');
    expect(output).toContain('pull');
  });
});

describe('runLog — --all overrides --limit', () => {
  it('shows all entries when --all is set even if --limit is lower', async () => {
    setupProject();
    for (let i = 0; i < 5; i++) {
      vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'pull' }) + '\n');
    }

    const { stdoutLines } = captureOutput();
    await runLog({ all: true, limit: 2, json: true }, PROJECT_DIR);

    const parsed = JSON.parse(stdoutLines.find((l) => l.startsWith('{'))!);
    expect(parsed.data.total_shown).toBe(5);
    expect(parsed.data.has_more).toBe(false);
  });
});

describe('runLog — watch mode', () => {
  it('runs once and exits 0 when --watch is set but stdout is not a TTY', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'pull' }) + '\n');

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const { stdoutLines } = captureOutput();

    await expect(runLog({ watch: true }, PROJECT_DIR)).resolves.not.toThrow();

    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    const output = stdoutLines.join('\n');
    expect(output).toContain('│');
  });

  it('prints "Stopped watching." and resolves on SIGINT', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'pull' }) + '\n');

    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const writeChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writeChunks.push(String(chunk));
      return true;
    });

    const nodeFs = await import('node:fs');
    const watchSpy = vi.spyOn(nodeFs, 'watch').mockImplementation((_path: any, _cb?: any) => {
      return { close: vi.fn() } as any;
    });

    captureOutput();
    const runPromise = runLog({ watch: true }, PROJECT_DIR);

    await Promise.resolve();
    await Promise.resolve();

    process.emit('SIGINT', 'SIGINT');
    await runPromise;

    expect(writeChunks.some((c) => c.includes('Stopped watching'))).toBe(true);

    watchSpy.mockRestore();
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('re-renders on file change after 150ms debounce', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ action: 'pull' }) + '\n');

    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let watchCallback: ((event: string) => void) | null = null;
    const mockWatcher = { close: vi.fn() };
    const nodeFs = await import('node:fs');
    const watchSpy = vi.spyOn(nodeFs, 'watch').mockImplementation((_path: any, cb?: any) => {
      watchCallback = cb;
      return mockWatcher as any;
    });

    const { stdoutLines } = captureOutput();
    const runPromise = runLog({ watch: true }, PROJECT_DIR);

    await Promise.resolve();
    await Promise.resolve();
    const initialCount = stdoutLines.length;

    // Fire 3 rapid events
    watchCallback!('change');
    watchCallback!('change');
    watchCallback!('change');

    // Before debounce expires (150ms)
    await vi.advanceTimersByTimeAsync(100);
    expect(stdoutLines.length).toBe(initialCount);

    // After debounce
    await vi.advanceTimersByTimeAsync(100);

    process.emit('SIGINT', 'SIGINT');
    await runPromise;

    expect(stdoutLines.length).toBeGreaterThanOrEqual(initialCount + 1);
    expect(mockWatcher.close).toHaveBeenCalled();

    watchSpy.mockRestore();
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });
});
