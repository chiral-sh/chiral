import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { runStatus } from '../../../src/commands/status.js';
import { writeSnapshot, writeSnapshotMeta } from '../../../src/state/snapshots.js';
import { writeLock } from '../../../src/state/locks.js';

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

const SINGLE_ENV_CONFIG = JSON.stringify({
  version: 1,
  project: 'my-n8n',
  environments: {
    dev: { url: 'https://dev.n8n.example.com', apiKey: 'dev-key' },
  },
});

// Fixed "now" for deterministic time tests
const FIXED_NOW = new Date('2026-06-02T12:00:00.000Z');

// ── Audit entry builder ────────────────────────────────────────────────────────

let uuidCounter = 0;
function makeAuditEntry(overrides: Partial<{
  timestamp: string; action: string; target_env: string; result: string;
}> = {}): string {
  uuidCounter++;
  const pad = uuidCounter.toString().padStart(12, '0');
  return JSON.stringify({
    event_id: `00000000-0000-0000-0000-${pad}`,
    event_schema_version: 1,
    timestamp: overrides.timestamp ?? '2026-06-02T10:00:00.000Z',
    actor: 'test@example.com',
    action: overrides.action ?? 'pull',
    project: 'my-n8n',
    source_env: null,
    target_env: overrides.target_env ?? 'dev',
    workflow_ids: [],
    result: overrides.result ?? 'success',
    error: null,
    chiral_version: '0.1.0',
  });
}

// ── Snapshot helpers ───────────────────────────────────────────────────────────

const DEP_DEV = '20260602T100000Z-aabbccdd';
const DEP_PROD = '20260602T100000Z-eeff0011';

function writeDevSnapshot(workflowCount = 12) {
  const wfs = Array.from({ length: workflowCount }, (_, i) => ({
    id: `wf-${i}`,
    name: `Workflow ${i}`,
  }));
  for (const wf of wfs) writeSnapshot(CHIRAL_DIR, DEP_DEV, wf);
  writeSnapshotMeta(CHIRAL_DIR, DEP_DEV, {
    deployment_id: DEP_DEV,
    env: 'dev',
    command: 'pull',
    timestamp: '2026-06-02T10:00:00.000Z',
    workflow_count: workflowCount,
    filters: { tag: null, pattern: null, onlyActive: false, id: null },
  });
}

function writeProdSnapshot(workflowCount = 8) {
  const wfs = Array.from({ length: workflowCount }, (_, i) => ({
    id: `prod-wf-${i}`,
    name: `Prod Workflow ${i}`,
  }));
  for (const wf of wfs) writeSnapshot(CHIRAL_DIR, DEP_PROD, wf);
  writeSnapshotMeta(CHIRAL_DIR, DEP_PROD, {
    deployment_id: DEP_PROD,
    env: 'prod',
    command: 'pull',
    timestamp: '2026-05-25T12:00:00.000Z',
    workflow_count: workflowCount,
    filters: { tag: null, pattern: null, onlyActive: false, id: null },
  });
}

// ── Setup helpers ──────────────────────────────────────────────────────────────

function setupProject(config = VALID_CONFIG) {
  vol.fromJSON({
    [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
    [`${CHIRAL_DIR}/config.json`]: config,
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

describe('runStatus — text table rendering', () => {
  it('renders box-drawing table with humanized timestamps and stale ! marker', async () => {
    setupProject();
    // dev: pulled 2h ago; prod: pulled 8 days ago (stale with default 7d)
    const devPull = '2026-06-02T10:00:00.000Z';   // 2h before FIXED_NOW
    const prodPull = '2026-05-25T12:00:00.000Z';  // 8 days before FIXED_NOW
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: devPull, target_env: 'dev' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: prodPull, target_env: 'prod' }) + '\n');
    writeDevSnapshot(12);
    writeProdSnapshot(8);

    const { stdoutLines } = captureOutput();
    await runStatus({});

    const output = stdoutLines.join('\n');
    // Box-drawing chars present
    expect(output).toContain('┌');
    expect(output).toContain('│');
    expect(output).toContain('└');
    // dev: 2 hours ago, no stale marker
    expect(output).toContain('2 hours ago');
    // prod: 8 days ago with stale marker
    expect(output).toContain('8 days ago !');
    // workflow counts
    expect(output).toContain('12');
    expect(output).toContain('8');
    // headers
    expect(output).toContain('last pull');
    expect(output).toContain('last push');
    expect(output).toContain('workflows');
  });

  it('renders only the specified env row when --env is passed', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'prod' }) + '\n');
    writeDevSnapshot();

    const { stdoutLines } = captureOutput();
    await runStatus({ env: 'dev' });

    const output = stdoutLines.join('\n');
    expect(output).toContain('dev');
    expect(output).not.toContain('prod');
  });

  it('throws UserError with "did you mean" suggestion for near-miss env name', async () => {
    setupProject();
    await expect(runStatus({ env: 'dov' })).rejects.toThrow(UserError);
    await expect(runStatus({ env: 'dov' })).rejects.toThrow(/did you mean/i);
    await expect(runStatus({ env: 'dov' })).rejects.toThrow(/dev/);
  });

  it('shows ISO-8601 timestamps when --no-humanize is set', async () => {
    setupProject();
    const ts = '2026-06-02T10:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: ts, target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    const { stdoutLines } = captureOutput();
    await runStatus({ noHumanize: true });

    const output = stdoutLines.join('\n');
    expect(output).toContain('2026-06-02T10:00:00.000Z');
    expect(output).not.toContain('hours ago');
  });

  it('renders "0 (!)" and footer hint for zero-workflow snapshot', async () => {
    setupProject();
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    writeDevSnapshot(0);

    const { stdoutLines } = captureOutput();
    await runStatus({});

    const output = stdoutLines.join('\n');
    expect(output).toContain('0 (!)');
    expect(output).toContain('has 0 workflows');
    expect(output).toContain("chiral pull --env dev");
  });
});

describe('runStatus — JSON output', () => {
  it('emits standard JSON envelope with project, environments, and locks', async () => {
    setupProject();
    const devPull = '2026-06-02T10:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: devPull, target_env: 'dev' }) + '\n');
    writeDevSnapshot(12);

    const { stdoutLines } = captureOutput();
    await runStatus({ json: true });

    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.project).toBe('my-n8n');
    expect(Array.isArray(parsed.data.environments)).toBe(true);
    expect(Array.isArray(parsed.data.locks)).toBe(true);

    const dev = parsed.data.environments.find((e: { name: string }) => e.name === 'dev');
    expect(dev).toBeDefined();
    expect(dev.last_pull).toBe(devPull);
    expect(dev.workflow_count).toBe(12);
    expect(dev.stale).toBe(false);
    expect(dev.drift).toBeNull();
  });

  it('shows null workflow_count in JSON when env has no snapshot', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    // No snapshot, no audit entries

    const { stdoutLines } = captureOutput();
    await runStatus({ json: true });

    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    const dev = parsed.data.environments[0];
    expect(dev.workflow_count).toBeNull();
    expect(dev.last_pull).toBeNull();
  });

  it('sets stale: true in JSON when last_pull is null', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    // No audit entries for dev

    const { stdoutLines } = captureOutput();
    await runStatus({ json: true });

    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    const dev = parsed.data.environments[0];
    expect(dev.stale).toBe(true);
    expect(dev.last_pull).toBeNull();
  });
});

describe('runStatus — staleness and exit codes', () => {
  it('marks a 4-day-old pull as stale when --stale-after 3 is set', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    // 4 days ago
    const fourDaysAgo = '2026-05-29T12:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: fourDaysAgo, target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    const { stdoutLines } = captureOutput();
    await expect(runStatus({ json: true, staleAfter: 3 })).rejects.toThrow();

    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    expect(parsed.data.environments[0].stale).toBe(true);
  });

  it('exits 0 when --stale-after is not passed even if pull is older than 7 days', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    // 8 days ago (older than default 7d)
    const eightDaysAgo = '2026-05-25T12:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: eightDaysAgo, target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    const { stdoutLines } = captureOutput();
    // Should NOT throw ControlledExit(3) — exits 0
    await expect(runStatus({ json: true })).resolves.not.toThrow();

    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    // stale=true because 8d > default 7d, but no exit 3
    expect(parsed.data.environments[0].stale).toBe(true);
  });
});

describe('runStatus — locks', () => {
  it('shows lock in text footer and in JSON data.locks array', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    writeDevSnapshot();
    // Write a lock (1 hour old — not stale with default 24h threshold)
    const lockTs = '2026-06-02T11:00:00.000Z';
    vol.fromJSON({
      ...vol.toJSON(),
      [`${CHIRAL_DIR}/locks/wf-abc.lock`]: JSON.stringify({
        actor: 'alice@example.com',
        hostname: 'laptop-pro',
        timestamp: lockTs,
      }),
    });

    const { stdoutLines } = captureOutput();
    await runStatus({});

    const output = stdoutLines.join('\n');
    expect(output).toContain('Locks (1 active)');
    expect(output).toContain('wf-abc');
    expect(output).toContain('alice@example.com');
    expect(output).toContain('laptop-pro');
  });

  it('shows lock in JSON data.locks', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    writeDevSnapshot();
    const lockTs = '2026-06-02T11:00:00.000Z';
    vol.fromJSON({
      ...vol.toJSON(),
      [`${CHIRAL_DIR}/locks/wf-abc.lock`]: JSON.stringify({
        actor: 'alice@example.com',
        hostname: 'laptop-pro',
        timestamp: lockTs,
      }),
    });

    const { stdoutLines } = captureOutput();
    await runStatus({ json: true });

    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    expect(parsed.data.locks).toHaveLength(1);
    expect(parsed.data.locks[0].workflow_id).toBe('wf-abc');
    expect(parsed.data.locks[0].actor).toBe('alice@example.com');
    expect(parsed.data.locks[0].hostname).toBe('laptop-pro');
    expect(parsed.data.locks[0].stale_lock).toBe(false);
  });

  it('marks a lock as STALE when older than --stale-lock-after hours', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    writeDevSnapshot();
    // 3 days old lock — older than default 24h
    const oldLockTs = '2026-05-30T08:00:00.000Z';
    vol.fromJSON({
      ...vol.toJSON(),
      [`${CHIRAL_DIR}/locks/wf-xyz.lock`]: JSON.stringify({
        actor: 'bob@example.com',
        hostname: 'workstation',
        timestamp: oldLockTs,
      }),
    });

    const { stdoutLines } = captureOutput();
    await runStatus({});

    const output = stdoutLines.join('\n');
    expect(output).toContain('STALE');
    expect(output).toContain('may be abandoned');
  });

  it('marks stale_lock: true in JSON for an old lock', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    const oldLockTs = '2026-05-30T08:00:00.000Z';
    vol.fromJSON({
      ...vol.toJSON(),
      [`${CHIRAL_DIR}/locks/wf-xyz.lock`]: JSON.stringify({
        actor: 'bob@example.com',
        hostname: 'workstation',
        timestamp: oldLockTs,
      }),
    });

    const { stdoutLines } = captureOutput();
    await runStatus({ json: true });

    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    expect(parsed.data.locks[0].stale_lock).toBe(true);
  });
});

describe('runStatus — audit corruption handling', () => {
  it('falls back to empty entries with stderr warning when audit.jsonl has malformed JSON', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    writeDevSnapshot();
    // Replace audit with malformed content
    vol.writeFileSync(`${CHIRAL_DIR}/audit.jsonl`, '{not valid json}\n');

    const { stdoutLines, stderrLines } = captureOutput();
    await runStatus({});

    expect(stderrLines.some(l => l.includes('incomplete'))).toBe(true);
    // No timestamp data → shows "never !" in output
    const output = stdoutLines.join('\n');
    expect(output).toContain('never !');
  });

  it('continues with parseable entries when last audit line has no event_id', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    writeDevSnapshot();
    // One valid pull entry + one invalid last line (valid JSON, no event_id)
    const validEntry = makeAuditEntry({ timestamp: '2026-06-02T10:00:00.000Z', target_env: 'dev' });
    vol.writeFileSync(`${CHIRAL_DIR}/audit.jsonl`, validEntry + '\n{"foo":"bar","no_event_id":true}\n');

    const { stdoutLines, stderrLines } = captureOutput();
    await runStatus({ json: true });

    // Warning emitted
    expect(stderrLines.some(l => l.includes('incomplete'))).toBe(true);

    // Data from valid line is used — dev shows a pull timestamp
    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    const dev = parsed.data.environments[0];
    expect(dev.last_pull).toBe('2026-06-02T10:00:00.000Z');
  });
});

describe('runStatus — snapshot meta mismatch', () => {
  it('emits per-env stderr warning and uses file listing count when meta.json is missing', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    // Write workflow snapshot files + a partial meta.json (has env but fails full Zod validation)
    // findLatestDeploymentForEnvLenient picks it up by raw env check; readSnapshotMeta returns null
    vol.fromJSON({
      ...vol.toJSON(),
      [`${CHIRAL_DIR}/snapshots/${DEP_DEV}/wf-0.json`]: JSON.stringify({ id: 'wf-0', name: 'WF 0' }),
      [`${CHIRAL_DIR}/snapshots/${DEP_DEV}/wf-1.json`]: JSON.stringify({ id: 'wf-1', name: 'WF 1' }),
      [`${CHIRAL_DIR}/snapshots/${DEP_DEV}/meta.json`]: JSON.stringify({ env: 'dev' }), // partial — passes raw check, fails Zod
    });

    const { stdoutLines, stderrLines } = captureOutput();
    await runStatus({ json: true });

    expect(stderrLines.some(l => l.includes('snapshot meta unreadable'))).toBe(true);
    // Falls back to listing files: 2 workflow files
    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    expect(parsed.data.environments[0].workflow_count).toBe(2);
  });
});

describe('runStatus — sentinel', () => {
  it('writes state.json with valid ISO-8601 after successful run', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    captureOutput();
    await runStatus({});

    const raw = JSON.parse(vol.readFileSync(`${CHIRAL_DIR}/state.json`, 'utf-8') as string);
    expect(raw.last_status_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('runStatus — compact mode', () => {
  it('outputs one tab-separated line per env with correct field order', async () => {
    setupProject();
    const devPull = '2026-06-02T10:00:00.000Z'; // 2h before FIXED_NOW
    const prodPull = '2026-05-25T12:00:00.000Z'; // 8 days before FIXED_NOW
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: devPull, target_env: 'dev' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: prodPull, target_env: 'prod' }) + '\n');
    writeDevSnapshot(12);
    writeProdSnapshot(8);

    const { stdoutLines } = captureOutput();
    // prod is stale (8d > 7d default), so exits 3
    await expect(runStatus({ compact: true })).rejects.toThrow();

    expect(stdoutLines).toHaveLength(2);
    const devLine = stdoutLines[0].split('\t');
    expect(devLine[0]).toBe('dev');
    expect(devLine[1]).toBe('✓');     // not stale
    expect(devLine[2]).toBe('2h');    // 2 hours ago
    expect(devLine[3]).toBe('12wf');
    expect(devLine[4]).toBe('0 locks');

    const prodLine = stdoutLines[1].split('\t');
    expect(prodLine[0]).toBe('prod');
    expect(prodLine[1]).toBe('!');    // stale
    expect(prodLine[2]).toBe('8d');   // 8 days ago
    expect(prodLine[3]).toBe('8wf');
    expect(prodLine[4]).toBe('0 locks');
  });

  it('exits 3 when any env is stale; exits 0 when all are fresh', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    // fresh pull: 1 hour ago
    const recentPull = '2026-06-02T11:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: recentPull, target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    captureOutput();
    await expect(runStatus({ compact: true })).resolves.not.toThrow();
  });

  it('exits 3 when stale in compact mode', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    // stale: 8 days ago
    const stalePull = '2026-05-25T12:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: stalePull, target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    captureOutput();
    const { ControlledExit } = await import('../../../src/lib/errors.js');
    await expect(runStatus({ compact: true })).rejects.toThrow(ControlledExit);
  });
});

describe('runStatus — summary mode', () => {
  it('outputs "N/N envs synced, 0 locks" when all envs are fresh', async () => {
    setupProject();
    // Both pulled recently (1h ago = just now, within 7d threshold)
    const recentPull = '2026-06-02T11:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: recentPull, target_env: 'dev' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: recentPull, target_env: 'prod' }) + '\n');
    writeDevSnapshot();
    writeProdSnapshot();

    const { stdoutLines } = captureOutput();
    await expect(runStatus({ summary: true })).resolves.not.toThrow();

    expect(stdoutLines[0]).toBe('2/2 envs synced, 0 locks');
  });

  it('outputs "N/M envs stale, 0 locks" when one env is stale and exits 3', async () => {
    setupProject();
    const recentPull = '2026-06-02T11:00:00.000Z';
    const stalePull = '2026-05-25T12:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: recentPull, target_env: 'dev' }) + '\n');
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: stalePull, target_env: 'prod' }) + '\n');
    writeDevSnapshot();
    writeProdSnapshot();

    const { stdoutLines } = captureOutput();
    const { ControlledExit } = await import('../../../src/lib/errors.js');
    await expect(runStatus({ summary: true })).rejects.toThrow(ControlledExit);

    expect(stdoutLines[0]).toBe('1/2 envs stale, 0 locks');
  });
});

describe('runStatus — --fields mode', () => {
  it('renders only requested columns in text mode', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    const { stdoutLines } = captureOutput();
    await runStatus({ fields: 'name,last_pull' });

    const output = stdoutLines.join('\n');
    expect(output).toContain('env');
    expect(output).toContain('last pull');
    expect(output).not.toContain('last push');
    expect(output).not.toContain('workflows');
    expect(output).not.toContain('drift');
  });

  it('omits unrequested fields from JSON env objects when --fields is used', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    const devPull = '2026-06-02T10:00:00.000Z';
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ timestamp: devPull, target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    const { stdoutLines } = captureOutput();
    await runStatus({ json: true, fields: 'name,last_pull' });

    const parsed = JSON.parse(stdoutLines.find(l => l.startsWith('{'))!);
    const env = parsed.data.environments[0];
    expect(env.name).toBeDefined();
    expect(env.last_pull).toBeDefined();
    expect(env.last_push).toBeUndefined();
    expect(env.workflow_count).toBeUndefined();
    expect(env.stale).toBeUndefined();
    expect(env.drift).toBeUndefined();
  });

  it('throws UserError for unknown column in --fields', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    await expect(runStatus({ fields: 'name,bogus_col' })).rejects.toThrow(UserError);
    await expect(runStatus({ fields: 'name,bogus_col' })).rejects.toThrow(/bogus_col/);
  });

  it('throws UserError when --compact is combined with --json', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    await expect(runStatus({ compact: true, json: true })).rejects.toThrow(UserError);
    await expect(runStatus({ compact: true, json: true })).rejects.toThrow(/--compact/);
  });

  it('throws UserError when --summary is combined with --json', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    await expect(runStatus({ summary: true, json: true })).rejects.toThrow(UserError);
    await expect(runStatus({ summary: true, json: true })).rejects.toThrow(/--summary/);
  });
});

describe('runStatus — watch mode', () => {
  it('runs once and exits 0 when --watch is set but stdout is not a TTY', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    writeDevSnapshot();
    // process.stdout.isTTY is undefined (falsy) in the test environment by default
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const { stdoutLines } = captureOutput();

    await expect(runStatus({ watch: true })).resolves.not.toThrow();

    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    expect(stdoutLines.some(l => l.includes('│'))).toBe(true); // table rendered once
  });

  it('respects the 300ms debounce — rapid file changes trigger at most one re-render', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let watchCallback: ((event: string, filename: string) => void) | null = null;
    const mockWatcher = { close: vi.fn() };
    const nodeFs = await import('node:fs');
    const watchSpy = vi.spyOn(nodeFs, 'watch').mockImplementation((_path: any, _opts: any, cb?: any) => {
      watchCallback = cb ?? _opts;
      return mockWatcher as any;
    });

    const { stdoutLines } = captureOutput();
    const runPromise = runStatus({ watch: true });

    // Flush microtasks to let the initial doOnce() and watch setup complete
    await Promise.resolve();
    await Promise.resolve();
    const initialCount = stdoutLines.length;

    // Fire 3 rapid events
    watchCallback!('change', 'audit.jsonl');
    watchCallback!('change', 'audit.jsonl');
    watchCallback!('change', 'audit.jsonl');

    // 100ms — debounce timer not yet expired
    await vi.advanceTimersByTimeAsync(100);
    expect(stdoutLines.length).toBe(initialCount);

    // Advance past debounce threshold (300ms total from last event)
    await vi.advanceTimersByTimeAsync(250);

    // Trigger SIGINT to end the watch loop
    process.emit('SIGINT', 'SIGINT');
    await runPromise;

    // Should have rendered at least once more after debounce
    expect(stdoutLines.length).toBeGreaterThanOrEqual(initialCount + 1);
    expect(mockWatcher.close).toHaveBeenCalled();

    watchSpy.mockRestore();
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('prints "Stopped watching." and resolves on SIGINT', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const writeChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writeChunks.push(String(chunk));
      return true;
    });

    const nodeFs = await import('node:fs');
    const watchSpy = vi.spyOn(nodeFs, 'watch').mockImplementation((_path: any, _opts: any, _cb?: any) => {
      return { close: vi.fn() } as any;
    });

    captureOutput();
    const runPromise = runStatus({ watch: true });

    // Flush microtasks to let the initial render complete and watch loop to be established
    await Promise.resolve();
    await Promise.resolve();

    process.emit('SIGINT', 'SIGINT');
    await runPromise;

    expect(writeChunks.some(c => c.includes('Stopped watching'))).toBe(true);

    watchSpy.mockRestore();
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('--watch --json re-emits a full JSON envelope on each re-render', async () => {
    setupProject(SINGLE_ENV_CONFIG);
    vol.appendFileSync(`${CHIRAL_DIR}/audit.jsonl`, makeAuditEntry({ target_env: 'dev' }) + '\n');
    writeDevSnapshot();

    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let watchCallback: ((event: string, filename: string) => void) | null = null;
    const mockWatcher = { close: vi.fn() };
    const nodeFs = await import('node:fs');
    const watchSpy = vi.spyOn(nodeFs, 'watch').mockImplementation((_path: any, _opts: any, cb?: any) => {
      watchCallback = cb ?? _opts;
      return mockWatcher as any;
    });

    const { stdoutLines } = captureOutput();
    const runPromise = runStatus({ watch: true, json: true });

    // Flush microtasks to let initial render complete
    await Promise.resolve();
    await Promise.resolve();

    const firstJsonLines = stdoutLines.filter(l => l.startsWith('{'));
    expect(firstJsonLines).toHaveLength(1);
    expect(JSON.parse(firstJsonLines[0]).status).toBe('ok');

    // Fire a file event and let debounce expire
    watchCallback!('change', 'audit.jsonl');
    await vi.advanceTimersByTimeAsync(350);

    process.emit('SIGINT', 'SIGINT');
    await runPromise;

    // Should have two JSON envelopes (initial + one re-render)
    const allJsonLines = stdoutLines.filter(l => l.startsWith('{'));
    expect(allJsonLines.length).toBeGreaterThanOrEqual(2);
    for (const line of allJsonLines) {
      expect(JSON.parse(line).status).toBe('ok');
    }

    watchSpy.mockRestore();
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });
});

describe('runStatus — error cases', () => {
  it('throws UserError when no environments are configured', async () => {
    vol.fromJSON({
      [`${GLOBAL_DIR}/projects/index.json`]: INDEX,
      [`${CHIRAL_DIR}/config.json`]: JSON.stringify({ version: 1, project: 'x', environments: {} }),
    });
    // Zod schema rejects empty environments before runStatus checks — still a UserError
    await expect(runStatus({})).rejects.toThrow(UserError);
    await expect(runStatus({})).rejects.toThrow(/environment/i);
  });

  it('throws UserError for unknown env with no near-miss', async () => {
    setupProject();
    await expect(runStatus({ env: 'staging' })).rejects.toThrow(UserError);
    await expect(runStatus({ env: 'staging' })).rejects.toThrow(/Unknown environment/);
    // 'staging' is far from 'dev'/'prod', no "did you mean"
    await expect(runStatus({ env: 'staging' })).rejects.not.toThrow(/did you mean/i);
  });

  it('throws UserError for --stale-after 0', async () => {
    setupProject();
    await expect(runStatus({ staleAfter: 0 })).rejects.toThrow(UserError);
    await expect(runStatus({ staleAfter: 0 })).rejects.toThrow('--stale-after must be a positive integer');
  });

  it('throws UserError for --stale-lock-after 0', async () => {
    setupProject();
    await expect(runStatus({ staleLockAfter: 0 })).rejects.toThrow(UserError);
    await expect(runStatus({ staleLockAfter: 0 })).rejects.toThrow('--stale-lock-after must be a positive integer');
  });
});
