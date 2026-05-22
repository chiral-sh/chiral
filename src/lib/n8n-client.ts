import { UserError } from './errors.js';
import type { Environment } from './config.js';

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

  private async request<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: { 'X-N8N-API-KEY': this.apiKey },
      });
    } catch {
      throw new UserError(
        `Cannot reach ${this.envName} at ${this.baseUrl.replace('/api/v1', '')} — connection refused`,
      );
    }

    if (response.status === 401) {
      throw new UserError(`API key for ${this.envName} is invalid or expired`);
    }
    if (response.status === 403) {
      throw new UserError(
        `API key for ${this.envName} does not have permission to list workflows`,
      );
    }
    if (!response.ok) {
      throw new UserError(
        `n8n API error for ${this.envName}: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  private async listAll<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | undefined;

    do {
      const url = cursor ? `${path}?limit=100&cursor=${encodeURIComponent(cursor)}` : `${path}?limit=100`;
      const page = await this.request<PaginatedResponse<T>>(url);
      results.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    return results;
  }

  async listWorkflows(): Promise<WorkflowSummary[]> {
    return this.listAll<WorkflowSummary>('/workflows');
  }

  async getWorkflow(id: string): Promise<WorkflowFull> {
    return this.request<WorkflowFull>(`/workflows/${id}`);
  }

  async listCredentials(): Promise<CredentialSummary[]> {
    return this.listAll<CredentialSummary>('/credentials');
  }

  async listTags(): Promise<TagSummary[]> {
    return this.listAll<TagSummary>('/tags');
  }
}
