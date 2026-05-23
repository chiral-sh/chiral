import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitSync } from '../lib/config.js';

const CREDENTIALS_TEMPLATE = {
  version: 1 as const,
  credentials: {} as Record<string, Record<string, string>>,
};

export function createFlightdeckDirectory(
  flightdeckDir: string,
  projectName: string,
  gitSync?: GitSync,
): void {
  mkdirSync(flightdeckDir, { recursive: true });
  mkdirSync(join(flightdeckDir, 'locks'), { recursive: true });
  mkdirSync(join(flightdeckDir, 'snapshots'), { recursive: true });

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
    join(flightdeckDir, 'config.example.json'),
    JSON.stringify(configExample, null, 2) + '\n',
    'utf-8',
  );
  writeFileSync(join(flightdeckDir, '.gitignore'), 'config.json\n', 'utf-8');
  writeFileSync(join(flightdeckDir, 'audit.jsonl'), '', 'utf-8');
  writeFileSync(
    join(flightdeckDir, 'credentials.json'),
    JSON.stringify(CREDENTIALS_TEMPLATE, null, 2) + '\n',
    'utf-8',
  );
}
