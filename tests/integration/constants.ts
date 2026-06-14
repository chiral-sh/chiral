// Pinned exact patch tag — the /rest/* bootstrap (owner setup, api-keys) is an
// undocumented, version-sensitive surface. Bumping this is a deliberate,
// reviewable change; never use `:latest` or a minor-only tag.
export const N8N_IMAGE = 'n8nio/n8n:2.26.3';

// Prefix for any resource (project, workflow, tag) created by an integration
// run, so cleanup and cross-test isolation can target by name.
export const RUN_ID_PREFIX = `chiral-it-${Date.now()}`;
