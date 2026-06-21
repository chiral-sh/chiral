import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/errors.js';
import { writeJsonAtomic } from './atomic.js';
import {
  findLatestDeploymentForEnv,
  readAllWorkflowsInDeployment,
  type SnapshotWorkflow,
} from './snapshots.js';

export const UrlEntrySchema = z.object({
  exact: z.boolean().optional(),
  values: z.record(z.string(), z.string()).default({}),
});

export type UrlEntry = z.infer<typeof UrlEntrySchema>;

export const UrlMapSchema = z.object({
  version: z.literal(1),
  urls: z.record(z.string(), UrlEntrySchema).default({}),
});

export type UrlMap = z.infer<typeof UrlMapSchema>;

export function loadUrlMap(chiralDir: string): UrlMap {
  const path = join(chiralDir, 'url-map.json');
  if (!existsSync(path)) return { version: 1, urls: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new UserError('url-map.json is not valid JSON — fix it before running commands');
  }
  const result = UrlMapSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new UserError(
      `url-map.json has an invalid structure:\n${issues}\n\nMake sure url-map.json is valid JSON with the correct format.`,
    );
  }
  return result.data;
}

export function writeUrlMap(chiralDir: string, data: UrlMap): void {
  const path = join(chiralDir, 'url-map.json');
  writeJsonAtomic(path, data);
}

export function validateUrlValue(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UserError(`Invalid URL: "${value}" — must be a valid http:// or https:// URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UserError(`Invalid URL scheme: "${value}" — only http:// and https:// are allowed`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new UserError(
      `URL contains credentials: "${value}" — userinfo in URLs (user:pass@host) would commit secrets to git. Use environment variables or a credential manager instead.`,
    );
  }
}

export function normalizeUrlValue(value: string): string {
  validateUrlValue(value);
  return value.endsWith('/') && new URL(value).pathname === '/' ? value.slice(0, -1) : value;
}

export interface UrlSubstitution {
  logicalName: string;
  sourceValue: string;
  targetValue: string;
  exact: boolean;
  affectedNodes: string[];
}

export interface UrlWarning {
  value: string;
  suggestedKey: string;
  affectedNodes: string[];
}

export function deriveUrlLogicalName(value: string): string {
  try {
    return new URL(value).hostname.replace(/\./g, '_');
  } catch {
    return value.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function matchesEntry(paramValue: string, sourceValue: string, exact: boolean): boolean {
  if (exact) return paramValue === sourceValue;
  try {
    return new URL(paramValue).origin === new URL(sourceValue).origin;
  } catch {
    return false;
  }
}

function walkForSubstitutions(
  obj: unknown,
  nodeName: string,
  sourceEnv: string,
  targetEnv: string,
  urlMap: UrlMap,
  substitutions: Map<string, UrlSubstitution>,
  warnings: Map<string, UrlWarning>,
): void {
  if (typeof obj === 'string') {
    if (!isHttpUrl(obj)) return;
    let matched = false;
    for (const [logicalName, entry] of Object.entries(urlMap.urls)) {
      const sourceValue = entry.values[sourceEnv];
      const targetValue = entry.values[targetEnv];
      if (!sourceValue || !targetValue) continue;
      const isExact = entry.exact ?? false;
      if (matchesEntry(obj, sourceValue, isExact)) {
        matched = true;
        const existing = substitutions.get(logicalName);
        if (existing) {
          if (!existing.affectedNodes.includes(nodeName)) existing.affectedNodes.push(nodeName);
        } else {
          substitutions.set(logicalName, {
            logicalName,
            sourceValue,
            targetValue,
            exact: isExact,
            affectedNodes: [nodeName],
          });
        }
        break;
      }
    }
    if (!matched) {
      const existing = warnings.get(obj);
      if (existing) {
        if (!existing.affectedNodes.includes(nodeName)) existing.affectedNodes.push(nodeName);
      } else {
        warnings.set(obj, { value: obj, suggestedKey: deriveUrlLogicalName(obj), affectedNodes: [nodeName] });
      }
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) walkForSubstitutions(item, nodeName, sourceEnv, targetEnv, urlMap, substitutions, warnings);
    return;
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      walkForSubstitutions(val, nodeName, sourceEnv, targetEnv, urlMap, substitutions, warnings);
    }
  }
}

export function buildUrlMap(
  nodes: unknown[],
  sourceEnv: string,
  targetEnv: string,
  urlMap: UrlMap,
): { substitutions: UrlSubstitution[]; warnings: UrlWarning[] } {
  const substitutions = new Map<string, UrlSubstitution>();
  const warnings = new Map<string, UrlWarning>();
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const nodeObj = node as Record<string, unknown>;
    const nodeName = typeof nodeObj['name'] === 'string' ? nodeObj['name'] : 'unknown';
    const parameters = nodeObj['parameters'];
    if (parameters === undefined || parameters === null) continue;
    walkForSubstitutions(parameters, nodeName, sourceEnv, targetEnv, urlMap, substitutions, warnings);
  }
  return { substitutions: [...substitutions.values()], warnings: [...warnings.values()] };
}

function deepRewriteParameters(obj: unknown, substitutions: UrlSubstitution[]): unknown {
  if (typeof obj === 'string') {
    if (!isHttpUrl(obj)) return obj;
    for (const sub of substitutions) {
      if (matchesEntry(obj, sub.sourceValue, sub.exact)) {
        if (sub.exact) return sub.targetValue;
        const srcOrigin = new URL(sub.sourceValue).origin;
        const dstOrigin = new URL(sub.targetValue).origin;
        return dstOrigin + obj.slice(srcOrigin.length);
      }
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((item) => deepRewriteParameters(item, substitutions));
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = deepRewriteParameters(v, substitutions);
    }
    return result;
  }
  return obj;
}

export function applyUrlMap(
  workflow: Record<string, unknown>,
  substitutions: UrlSubstitution[],
): Record<string, unknown> {
  if (substitutions.length === 0) return { ...workflow };
  const nodes = workflow['nodes'];
  if (!Array.isArray(nodes)) return { ...workflow };
  const remappedNodes = (nodes as unknown[]).map((node) => {
    if (typeof node !== 'object' || node === null) return node;
    const nodeObj = node as Record<string, unknown>;
    const parameters = nodeObj['parameters'];
    if (parameters === undefined || parameters === null) return { ...nodeObj };
    return { ...nodeObj, parameters: deepRewriteParameters(parameters, substitutions) };
  });
  return { ...workflow, nodes: remappedNodes };
}

export interface DiscoveredUrl {
  value: string;
  hostname: string;
  env: string;
  workflowNames: string[];
}

function collectHttpUrls(obj: unknown, found: Set<string>): void {
  if (typeof obj === 'string') {
    if (isHttpUrl(obj)) found.add(obj.endsWith('/') && new URL(obj).pathname === '/' ? obj.slice(0, -1) : obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectHttpUrls(item, found);
    return;
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      collectHttpUrls(val, found);
    }
  }
}

export function extractUrlsFromSnapshots(chiralDir: string, envs: string[]): DiscoveredUrl[] {
  const discovered = new Map<string, DiscoveredUrl>();

  for (const env of envs) {
    let deploymentId: string | undefined;
    try {
      deploymentId = findLatestDeploymentForEnv(chiralDir, env);
    } catch {
      continue;
    }
    if (!deploymentId) continue;

    let workflows: SnapshotWorkflow[];
    try {
      workflows = readAllWorkflowsInDeployment(chiralDir, deploymentId).workflows;
    } catch {
      continue;
    }

    for (const workflow of workflows) {
      const nodes = (workflow as Record<string, unknown>)['nodes'];
      if (!Array.isArray(nodes)) continue;

      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue;
        const nodeObj = node as Record<string, unknown>;
        const parameters = nodeObj['parameters'];
        if (parameters === undefined || parameters === null) continue;

        const urlsInNode = new Set<string>();
        collectHttpUrls(parameters, urlsInNode);

        for (const urlValue of urlsInNode) {
          const key = `${env}::${urlValue}`;
          const existing = discovered.get(key);
          if (existing) {
            if (!existing.workflowNames.includes(workflow.name)) {
              existing.workflowNames.push(workflow.name);
            }
          } else {
            let hostname: string;
            try {
              hostname = new URL(urlValue).hostname;
            } catch {
              hostname = urlValue;
            }
            discovered.set(key, { value: urlValue, hostname, env, workflowNames: [workflow.name] });
          }
        }
      }
    }
  }

  return Array.from(discovered.values());
}
