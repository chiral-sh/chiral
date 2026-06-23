import chalk from 'chalk';
import { UserError } from './errors.js';
import type { Environment } from './config.js';

const EXPIRY_WARN_DAYS = 7;

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tags: Array<{ id: string; name: string }>;
  versionId: string;
}

export interface WorkflowFull extends WorkflowSummary {
  nodes: unknown[];
  connections: unknown;
  settings: unknown;
  [key: string]: unknown;
}

export interface CredentialSummary {
  id: string;
  name: string;
  type: string;
}

export interface TagSummary {
  id: string;
  name: string;
}

interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
}

export class N8nClient {
  private baseUrl: string;
  private apiKey: string;
  private envName: string;

  constructor(env: Environment, envName: string) {
    this.baseUrl = env.url.replace(/\/$/, '') + '/api/v1';
    this.apiKey = env.apiKey;
    this.envName = envName;
  }

  // Returns the JWT exp claim as a Date, or null if the token is not a JWT or has no exp.
  static parseJwtExpiry(token: string): Date | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
      if (typeof payload.exp === 'number') return new Date(payload.exp * 1000);
    } catch {
      // not a valid JWT
    }
    return null;
  }

  warnIfExpiringSoon(): void {
    const expiry = N8nClient.parseJwtExpiry(this.apiKey);
    if (!expiry) return;
    const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysLeft > 0 && daysLeft <= EXPIRY_WARN_DAYS) {
      console.error(
        chalk.yellow(`  ⚠ API key for ${this.envName} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`) +
        chalk.dim(` - run chiral environment configure ${this.envName} to rotate it`),
      );
    }
  }

  private scopeHint(): string {
    return (
      '  Recreate your key at n8n Settings → API with these scopes:\n' +
      '    workflow:list  workflow:read  workflow:create  workflow:update  workflow:activate  workflow:deactivate\n' +
      '    credential:list  tag:list  tag:create\n' +
      `  Then run: chiral environment configure ${this.envName}`
    );
  }

  private async request<T>(
    path: string,
    options: {
      signal?: AbortSignal;
      scope?: string;
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: string;
      on404?: string;
      captureHeaders?: { n8nVersion?: string };
    } = {},
  ): Promise<T> {
    const expiry = N8nClient.parseJwtExpiry(this.apiKey);
    if (expiry && expiry <= new Date()) {
      throw new UserError(
        `API key for ${this.envName} expired on ${expiry.toLocaleDateString()}`,
        `  Run: chiral environment configure ${this.envName} to save a new key`,
      );
    }

    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { 'X-N8N-API-KEY': this.apiKey };
    if (options.body) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body,
        signal: options.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new UserError(`Connection to ${this.envName} timed out after 10 seconds`);
      }
      throw new UserError(
        `Cannot reach ${this.envName} at ${this.baseUrl.replace('/api/v1', '')} - connection refused`,
      );
    }

    if (response.status === 401) {
      throw new UserError(
        `API key for ${this.envName} is invalid or expired`,
        `  Run: chiral environment configure ${this.envName} to save a new key`,
      );
    }
    if (response.status === 404 && options.on404) {
      throw new UserError(options.on404);
    }
    if (response.status === 403) {
      const scopePart = options.scope
        ? ` - missing scope: ${options.scope}`
        : ' - insufficient permissions';
      throw new UserError(
        `API key for ${this.envName}${scopePart}`,
        this.scopeHint(),
      );
    }
    if (!response.ok) {
      throw new UserError(
        `n8n API error for ${this.envName}: ${response.status} ${response.statusText}`,
      );
    }

    if (options.captureHeaders) {
      const v = response.headers?.get?.('x-n8n-version');
      if (v) options.captureHeaders.n8nVersion = v;
    }

    // 204 No Content - return empty object
    if (response.status === 204) return {} as T;

    return response.json() as Promise<T>;
  }

  private async listAll<T>(path: string, scope: string, extra?: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({ limit: '100', ...extra });
      if (cursor) params.set('cursor', cursor);
      const page = await this.request<PaginatedResponse<T>>(`${path}?${params.toString()}`, { scope });
      results.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    return results;
  }

  async listWorkflows(filters?: { active?: boolean; tags?: string }): Promise<WorkflowSummary[]> {
    const extra: Record<string, string> = {};
    if (filters?.active !== undefined) extra.active = String(filters.active);
    if (filters?.tags) extra.tags = filters.tags;
    return this.listAll<WorkflowSummary>('/workflows', 'workflow:list', extra);
  }

  async getWorkflow(id: string): Promise<WorkflowFull> {
    return this.request<WorkflowFull>(`/workflows/${id}`, { scope: 'workflow:read' });
  }

  async listCredentials(): Promise<CredentialSummary[]> {
    return this.listAll<CredentialSummary>('/credentials', 'credential:list');
  }

  async getDataTable(id: string): Promise<{ id: string; name: string; projectId: string }> {
    return this.request<{ id: string; name: string; projectId: string }>(
      `/data-tables/${id}`,
      { scope: 'datatable:read', on404: `Table ID ${id} not found in ${this.envName} — check the ID in the n8n Data Tables UI` },
    );
  }

  async listTags(): Promise<TagSummary[]> {
    return this.listAll<TagSummary>('/tags', 'tag:list');
  }

  async testConnection(timeoutMs = 10_000): Promise<{ workflowCount: number; n8nVersion?: string }> {
    this.warnIfExpiringSoon();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const captureHeaders: { n8nVersion?: string } = {};
    try {
      const workflows = await this.request<{ data: unknown[] }>(
        '/workflows?limit=100&excludePinnedData=true',
        { signal: controller.signal, scope: 'workflow:list', captureHeaders },
      );
      await this.request('/credentials?limit=1', { signal: controller.signal, scope: 'credential:list' });
      await this.request('/tags?limit=1', { signal: controller.signal, scope: 'tag:list' });
      return { workflowCount: workflows.data.length, n8nVersion: captureHeaders.n8nVersion };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async createWorkflow(body: WorkflowFull): Promise<{ id: string; versionId: string }> {
    const response = await this.request<{ id: string; versionId: string }>(
      '/workflows',
      { method: 'POST', body: JSON.stringify(body), scope: 'workflow:create' },
    );
    return { id: response.id, versionId: response.versionId };
  }

  async updateWorkflow(id: string, body: WorkflowFull): Promise<{ versionId: string }> {
    const response = await this.request<{ id: string; versionId: string }>(
      `/workflows/${id}`,
      { method: 'PUT', body: JSON.stringify(body), scope: 'workflow:update' },
    );
    return { versionId: response.versionId };
  }

  async activateWorkflow(id: string): Promise<void> {
    await this.request<void>(
      `/workflows/${id}/activate`,
      { method: 'POST', scope: 'workflow:activate' },
    );
  }

  async deactivateWorkflow(id: string): Promise<void> {
    await this.request<void>(
      `/workflows/${id}/deactivate`,
      { method: 'POST', scope: 'workflow:deactivate' },
    );
  }
}
