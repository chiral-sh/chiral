import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_EXAMPLE_TEMPLATE = {
  version: 1 as const,
  project: 'your-project-name',
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
  credentialMap: {
    dev_database: 'prod_database',
  },
};

export function createFlightdeckDirectory(flightdeckDir: string, projectName: string): void {
  mkdirSync(flightdeckDir, { recursive: true });
  mkdirSync(join(flightdeckDir, 'locks'), { recursive: true });
  mkdirSync(join(flightdeckDir, 'snapshots'), { recursive: true });

  const configExample = { ...CONFIG_EXAMPLE_TEMPLATE, project: projectName };
  writeFileSync(
    join(flightdeckDir, 'config.example.json'),
    JSON.stringify(configExample, null, 2) + '\n',
    'utf-8',
  );
  writeFileSync(join(flightdeckDir, '.gitignore'), 'config.json\n', 'utf-8');
  writeFileSync(join(flightdeckDir, 'audit.jsonl'), '', 'utf-8');
}
