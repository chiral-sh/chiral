import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitSync } from '../lib/config.js';
import { writeJsonAtomic } from './atomic.js';
import { writeTeam } from './team.js';
import { writeTableMap } from './tables.js';
import { writeUrlMap } from './url-map.js';

const CREDENTIALS_TEMPLATE = {
  version: 1 as const,
  credentials: {} as Record<string, Record<string, string>>,
};

const WORKFLOWS_TEMPLATE = {
  version: 1 as const,
  workflows: {} as Record<string, Record<string, string>>,
};

export function createChiralDirectory(
  chiralDir: string,
  projectName: string,
  gitSync?: GitSync,
  ownerEmail?: string,
): void {
  mkdirSync(chiralDir, { recursive: true });
  mkdirSync(join(chiralDir, 'locks'), { recursive: true });
  mkdirSync(join(chiralDir, 'snapshots'), { recursive: true });

  const configExample: Record<string, unknown> = {
    version: 1,
    project: projectName,
    environments: {
      dev: {
        url: 'https://dev.n8n.your-domain.com',
        apiKey: 'YOUR_DEV_API_KEY',
      },
      prod: {
        url: 'https://prod.n8n.your-domain.com',
        apiKey: 'YOUR_PROD_API_KEY',
      },
    },
  };
  if (gitSync) {
    configExample['gitSync'] = gitSync;
  }

  writeFileSync(
    join(chiralDir, 'config.example.json'),
    JSON.stringify(configExample, null, 2) + '\n',
    'utf-8',
  );
  writeFileSync(join(chiralDir, '.gitignore'), 'config.json\n', 'utf-8');
  writeFileSync(join(chiralDir, 'audit.jsonl'), '', 'utf-8');
  writeJsonAtomic(join(chiralDir, 'credentials.json'), CREDENTIALS_TEMPLATE);
  writeJsonAtomic(join(chiralDir, 'workflows.json'), WORKFLOWS_TEMPLATE);

  if (!existsSync(join(chiralDir, 'tables.json'))) {
    writeTableMap(chiralDir, { version: 1, tables: {} });
  }

  if (!existsSync(join(chiralDir, 'url-map.json'))) {
    writeUrlMap(chiralDir, { version: 1, urls: {} });
  }

  if (ownerEmail) {
    const now = new Date().toISOString();
    writeTeam(chiralDir, {
      version: 1,
      members: {
        [ownerEmail]: { role: 'owner', addedBy: ownerEmail, addedAt: now },
      },
    });
  }
}
