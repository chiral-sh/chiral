[![npm version](https://img.shields.io/npm/v/%40chiral-sh%2Fchiral.svg)](https://www.npmjs.com/package/@chiral-sh/chiral)
[![CI](https://github.com/chiral-sh/chiral/actions/workflows/ci.yml/badge.svg)](https://github.com/chiral-sh/chiral/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

# Chiral: promote n8n workflows from dev to production without breaking live automations

Chiral is a CLI for self-hosted n8n Community Edition teams who move workflows between dev, staging, and production. It gives you a real diff, a dry-run preview, and credential remapping before anything touches a live instance. No hosted backend, no database, works offline.

One stray edit to a live workflow, or a push that points at production when you meant staging, and a client's automation breaks at 2am. n8n's own Source Control feature solves this, but it is locked behind the Business plan at €800/month, which is not an option for teams self-hosting Community Edition. Chiral brings the same dev to production promotion to CE teams for $0.

<!-- TODO: replace with a 15-30s vhs GIF of `chiral diff` then `chiral push --dry-run`. -->

```console
$ chiral diff --source dev --target prod

  Comparing dev → prod

  ✓ Fetched 12 workflows from dev, 10 workflows from prod

  + New Webhook Handler      (will be created - wrong name? run: chiral workflow map)
  - Deprecated Cleanup       (in prod, not in dev)

  Order Pipeline      +3 ~1 -2   ████░
  Updated Workflow    +0 ~1 -0   █░░░░

  1 added, 2 modified, 1 removed.
  Run 'chiral push --source dev --target prod --dry-run' to preview.
```

## Quick start

```bash
npm install -g @chiral-sh/chiral

chiral init my-n8n                 # create a project
chiral environment add dev         # prompts for n8n URL + API key
chiral environment add prod
chiral adopt dev                   # discover the workflows already in dev
chiral diff --from dev --to prod
```

You now see exactly what differs between your two environments. When you are ready to promote, run `chiral pull dev` to refresh the snapshot, preview with `chiral push --from dev --to prod --dry-run`, then drop the `--dry-run`.

API keys go straight into `.chiral/config.json`, which is gitignored and written with `0600` permissions. Chiral never reads or stores your credential secret values.

## What it does

| Command | What it does |
|---------|--------------|
| `init` | Create a Chiral project and its `.chiral/` state |
| `adopt` | Discover an existing n8n instance and snapshot its workflows |
| `pull` | Download workflows from an environment into a local snapshot |
| `diff` | Show real differences between two environments, no false positives |
| `push` | Promote workflows between environments (with `--dry-run` preview) |
| `credential map` | Remap credential names across environments (names only, never secrets) |
| `workflow map` / `match` | Link workflows across environments by ID or matching structure |
| `lock` / `unlock` | Prevent concurrent pushes to an environment |
| `clone` | One-command teammate onboarding from a shared git repo |
| `status` / `log` | Inspect environment drift and the local audit history |

Selective promotion by `--tag` and `--pattern`, content fingerprinting that kills `versionId` false positives, and git sync of `.chiral/` state are all included. Run `chiral <command> --help` for the full flag reference of any command.

## Why not n8n's built-in Source Control?

n8n's Source Control is a good feature. It is gated behind the Business plan at €800/month, which includes Git version control and multiple environments. For agencies and teams self-hosting Community Edition specifically to avoid that cost, it is out of reach. Chiral brings environment promotion to CE teams without a plan change and without a hosted backend to depend on. It also handles two things n8n's feature does not: credential remapping across environments and a dry-run preview before any change lands.

## How it works

- State lives in a `.chiral/` directory inside your own git repo. There is no hosted backend and no database to maintain.
- Chiral talks to your instances over the n8n REST API only. No SSH, no Docker socket.
- It is offline-capable and works with any git host, or none at all.
- Credential secret values are never read or stored. Chiral remaps credential names between environments and leaves the secrets in n8n.
- Workflows are normalized and content-fingerprinted (stable SHA-256), so `diff` and `push` report genuine changes rather than churn from n8n reassigning a `versionId` on every save.

## Installation

Requires Node 20+ and git.

```bash
npm install -g @chiral-sh/chiral
```

## Command reference

Run `chiral --help` to list every command, or `chiral <command> --help` for its flags, output format, and exit codes. Core verbs are `init`, `environment`, `adopt`, `pull`, `diff`, `push`, `credential`, `workflow`, `lock`, `status`, and `log`.

## Configuration

`chiral environment add` writes your environments into `.chiral/config.json`. A teammate-safe `config.example.json` (with placeholder values, no secrets) is committed in its place:

```jsonc
{
  "version": 1,
  "project": "my-n8n",
  "environments": {
    "dev":  { "url": "https://dev.n8n.your-domain.com",  "apiKey": "YOUR_DEV_API_KEY" },
    "prod": { "url": "https://prod.n8n.your-domain.com", "apiKey": "YOUR_PROD_API_KEY" }
  }
}
```

`config.json` holds the real keys and stays out of git via `.chiral/.gitignore`. Optional git sync auto-commits the non-secret `.chiral/` state to your remote after each mutating command; set it up with `chiral remote set`.

## Contributing

Issues and pull requests are welcome. Run the test suite with `pnpm test` and the type checker with `pnpm typecheck` before opening a PR. Beginner-friendly issues are tagged `good first issue`.

## License

[MIT](./LICENSE)
