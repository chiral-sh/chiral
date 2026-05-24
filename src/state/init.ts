import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitSync } from '../lib/config.js';

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
  writeFileSync(
    join(chiralDir, 'credentials.json'),
    JSON.stringify(CREDENTIALS_TEMPLATE, null, 2) + '\n',
    'utf-8',
  );
  writeFileSync(
    join(chiralDir, 'workflows.json'),
    JSON.stringify(WORKFLOWS_TEMPLATE, null, 2) + '\n',
    'utf-8',
  );
}
