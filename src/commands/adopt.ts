import { execSync } from 'node:child_process';
import { Command } from 'commander';
import { loadConfigAndDir, resolveEnv } from '../lib/config.js';
import { N8nClient } from '../lib/n8n-client.js';
import { UserError } from '../lib/errors.js';
import { generateDeploymentId, writeSnapshot } from '../state/snapshots.js';
import { writeAuditEntry } from '../state/audit.js';

function getGitActor(): string {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    throw new UserError(
      'git config user.email is not set — configure it before running flightdeck',
    );
  }
}

export async function runAdopt(
  options: { env: string },
  cwd: string = process.cwd(),
): Promise<void> {
  const actor = getGitActor();
  const { config, flightdeckDir } = loadConfigAndDir(cwd);
  const env = resolveEnv(config, options.env);
  const client = new N8nClient(env, options.env);

  const baseEntry = {
    event_id: crypto.randomUUID(),
    event_schema_version: 1 as const,
    timestamp: new Date().toISOString(),
    actor,
    action: 'adopt' as const,
    project: config.project,
    source_env: null,
    target_env: options.env,
    workflow_ids: [],
    flightdeck_version: '0.1.0',
  };

  try {
    console.log(`Connecting to ${options.env} (${env.url})...`);

    const [summaries, credentials, tags] = await Promise.all([
      client.listWorkflows(),
      client.listCredentials(),
      client.listTags(),
    ]);

    const workflows = await Promise.all(summaries.map((s) => client.getWorkflow(s.id)));

    console.log(`✓ Discovered ${workflows.length} workflows`);
    console.log(
      `✓ Discovered ${credentials.length} credentials (names only — secrets are never read)`,
    );
    console.log(`✓ Discovered ${tags.length} tags`);

    const deploymentId = generateDeploymentId();
    for (const workflow of workflows) {
      writeSnapshot(flightdeckDir, deploymentId, workflow);
    }

    console.log(`✓ Snapshot saved to .flightdeck/snapshots/${deploymentId}/`);
    console.log('');
    console.log('  Workflows:');
    for (const wf of workflows) {
      console.log(`    - ${wf.name} (${wf.active ? 'active' : 'inactive'})`);
    }
    console.log('');
    console.log(`Run 'flightdeck pull --env ${options.env}' to keep snapshots up to date.`);

    writeAuditEntry(flightdeckDir, { ...baseEntry, result: 'success', error: null });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      writeAuditEntry(flightdeckDir, { ...baseEntry, result: 'failure', error: errorMsg });
    } catch {
      // best-effort — don't mask the original error
    }
    throw err;
  }
}

export const adoptCommand = new Command('adopt')
  .description('Import an existing n8n instance into flightdeck state')
  .requiredOption('--env <env>', 'Environment name from config.json')
  .action(async (options) => {
    await runAdopt(options);
  });
