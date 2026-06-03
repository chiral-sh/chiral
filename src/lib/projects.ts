import envPaths from 'env-paths';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  writeFile,
  readdirSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { z } from 'zod';
import { UserError } from './errors.js';

// ── Schemas ────────────────────────────────────────────────────────────────────

const ProjectEntrySchema = z.object({
  path: z.string(),
  createdAt: z.string().datetime(),
});

const IndexSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), ProjectEntrySchema),
});

const SessionSchema = z.object({
  project: z.string(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
});

type Index = z.infer<typeof IndexSchema>;
export type Session = z.infer<typeof SessionSchema>;

// ── Path helpers ───────────────────────────────────────────────────────────────

export function getGlobalDir(): string {
  return process.env['CHIRAL_PROJECTS_DIR'] ?? envPaths('chiral', { suffix: '' }).data;
}

export function getProjectsDir(): string {
  return join(getGlobalDir(), 'projects');
}

export function getSessionsDir(): string {
  return join(getGlobalDir(), 'sessions');
}

export function getIndexPath(): string {
  return join(getProjectsDir(), 'index.json');
}

// ── Index read / write ─────────────────────────────────────────────────────────

function readIndex(): Index {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) return { version: 1, projects: {} };
  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf-8')) as unknown;
    const result = IndexSchema.safeParse(raw);
    return result.success ? result.data : { version: 1, projects: {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

function writeIndex(index: Index): void {
  const projectsDir = getProjectsDir();
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(getIndexPath(), JSON.stringify(index, null, 2) + '\n', 'utf-8');
}

// ── Project registry helpers ───────────────────────────────────────────────────

export interface ProjectEntry {
  name: string;
  path: string;
  createdAt: string;
}

export function listProjects(): ProjectEntry[] {
  const index = readIndex();
  return Object.entries(index.projects).map(([name, entry]) => ({
    name,
    path: entry.path,
    createdAt: entry.createdAt,
  }));
}

export function getProjectCount(): number {
  return listProjects().length;
}

function findProjectKey(name: string, index: Index): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(index.projects).find((k) => k.toLowerCase() === lower);
}

export function projectExists(name: string): boolean {
  const index = readIndex();
  return findProjectKey(name, index) !== undefined;
}

export function getProjectPath(name: string): string | null {
  const index = readIndex();
  const key = findProjectKey(name, index);
  return key ? (index.projects[key].path) : null;
}

export function registerProject(name: string, path: string): void {
  const index = readIndex();
  const existing = findProjectKey(name, index);
  if (existing && existing !== name) {
    throw new UserError(
      `A project named "${existing}" already exists. Project names are case-insensitive.`,
    );
  }
  index.projects[name] = { path, createdAt: new Date().toISOString() };
  writeIndex(index);
}

export function unregisterProject(name: string): void {
  const index = readIndex();
  const key = findProjectKey(name, index);
  if (!key) return;
  delete index.projects[key];
  writeIndex(index);
}

export function renameProjectInIndex(oldName: string, newName: string, newPath: string): void {
  const index = readIndex();
  const oldKey = findProjectKey(oldName, index);
  if (!oldKey) {
    throw new UserError(`Project "${oldName}" not found.`);
  }
  const conflictKey = findProjectKey(newName, index);
  if (conflictKey && conflictKey !== oldKey) {
    throw new UserError(`A project named "${conflictKey}" already exists.`);
  }
  const entry = index.projects[oldKey];
  delete index.projects[oldKey];
  entry.path = newPath;
  index.projects[newName] = entry;
  writeIndex(index);
}

// ── Session management ─────────────────────────────────────────────────────────

function getSessionPath(ppid: number): string {
  return join(getSessionsDir(), `${ppid}.json`);
}

export function readSession(ppid: number): { project: string; lastUsedAt: string } | null {
  const sessionPath = getSessionPath(ppid);
  if (!existsSync(sessionPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(sessionPath, 'utf-8')) as unknown;
    const result = SessionSchema.safeParse(raw);
    if (!result.success) return null;
    return { project: result.data.project, lastUsedAt: result.data.lastUsedAt };
  } catch {
    return null;
  }
}

export function writeSession(ppid: number, projectName: string): void {
  const sessionsDir = getSessionsDir();
  mkdirSync(sessionsDir, { recursive: true });
  const now = new Date().toISOString();
  const session: Session = { project: projectName, createdAt: now, lastUsedAt: now };
  writeFileSync(getSessionPath(ppid), JSON.stringify(session, null, 2) + '\n', 'utf-8');
}

// Updates lastUsedAt without blocking the caller - fire-and-forget.
// Writes to a .tmp file then renames atomically so concurrent readers never see a truncated file.
function touchSession(ppid: number): void {
  const sessionPath = getSessionPath(ppid);
  if (!existsSync(sessionPath)) return;
  try {
    const raw = JSON.parse(readFileSync(sessionPath, 'utf-8')) as Session;
    raw.lastUsedAt = new Date().toISOString();
    const tmp = sessionPath + '.tmp';
    writeFile(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8', (err) => {
      if (!err) try { renameSync(tmp, sessionPath); } catch { /* ignore */ }
    });
  } catch {
    // ignore read errors
  }
}

export function clearSessionsForProject(projectName: string): void {
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) return;
  try {
    for (const file of readdirSync(sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      const sessionPath = join(sessionsDir, file);
      try {
        const raw = JSON.parse(readFileSync(sessionPath, 'utf-8')) as { project?: unknown };
        if (raw.project === projectName) rmSync(sessionPath, { force: true });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore - best-effort
  }
}

export function pruneDeadSessions(): void {
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) return;
  try {
    for (const file of readdirSync(sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      const pid = parseInt(file.slice(0, -5), 10);
      if (isNaN(pid)) continue;
      try {
        process.kill(pid, 0); // 0 = check existence only, no signal sent
      } catch {
        // PID not alive - remove stale session file
        rmSync(join(sessionsDir, file), { force: true });
      }
    }
  } catch {
    // ignore - best-effort GC
  }
}

// ── Active project resolution ──────────────────────────────────────────────────

const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

export interface ResolvedProject {
  name: string;
  chiralDir: string;
  inactiveReminder: boolean; // true → caller should print "Using project <name>"
}

export function resolveActiveProject(): ResolvedProject {
  // 1. CHIRAL_PROJECT env var (CI / scripted override)
  const envProject = process.env['CHIRAL_PROJECT'];
  if (envProject) {
    const projectPath = getProjectPath(envProject);
    if (!projectPath) {
      throw new UserError(
        `Project "${envProject}" not found. Run 'chiral project list' to see available projects.`,
      );
    }
    return { name: envProject, chiralDir: join(projectPath, '.chiral'), inactiveReminder: false };
  }

  // 2. Session file keyed by parent PID
  const ppid = process.ppid;
  if (ppid) {
    const session = readSession(ppid);
    if (session) {
      const projectPath = getProjectPath(session.project);
      if (projectPath) {
        const stale = Date.now() - new Date(session.lastUsedAt).getTime() > INACTIVITY_MS;
        touchSession(ppid); // non-blocking update
        return {
          name: session.project,
          chiralDir: join(projectPath, '.chiral'),
          inactiveReminder: stale,
        };
      }
      // Session points to a deleted project - fall through
    }
  }

  // 3. Project count auto-selection
  const projects = listProjects();
  if (projects.length === 0) {
    throw new UserError("No projects found. Run 'chiral init <name>' to create one.");
  }
  if (projects.length === 1) {
    const project = projects[0];
    return { name: project.name, chiralDir: join(project.path, '.chiral'), inactiveReminder: false };
  }
  const names = projects.map((p) => p.name).join(', ');
  throw new UserError(
    `Multiple projects found. Run 'chiral use <name>' to select one.\n  Available: ${names}`,
  );
}

// ── Disk operations for project lifecycle ──────────────────────────────────────

export function renameProjectDir(oldPath: string, newName: string): string {
  const parent = join(oldPath, '..');
  const newPath = join(parent, newName);
  renameSync(oldPath, newPath);
  return newPath;
}
