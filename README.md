# BOX Orchestrator

`BOX` is a Node.js-based orchestration runtime for autonomous software delivery. It coordinates leader/worker agent loops, reads project state, dispatches tasks, and records progress under `state/`.

## What is in this repository

- Runtime entrypoint: `src/cli.ts`
- Config loader: `src/config.ts`
- Main orchestration loop: `src/core/orchestrator.ts`
- Leadership coordination: `src/core/jesus_supervisor.ts`, `src/core/moses_coordinator.ts`
- Worker conversation runner: `src/core/worker_runner.ts`

## Requirements

- Node.js `>=20.0.0`
- Docker (for compose flow and worker container workflows)
- Copilot CLI available on PATH (`copilot` by default)
- GitHub token access for the target repo

## Quick start

1. Copy env template:

```bash
cp .env.example .env
```

2. Fill at least:

- `GITHUB_TOKEN`
- `TARGET_REPO` (format: `owner/repo`)
- `COPILOT_GITHUB_TOKEN` (or legacy fallback `GITHUB_FINEGRADED`)

3. Install deps and run one cycle:

```bash
npm install
npm run box:once
```

4. Run daemon mode:

```bash
npm run box:start
npm run box:stop
```

## NPM scripts

- `box:up` / `box:down`: start/stop docker-compose services.
- `box:start`: run daemon loop.
- `box:stop`: request daemon shutdown.
- `box:once`: run one startup cycle.
- `box:rebase`: compatibility command (currently returns not-applicable result).
- `box:dashboard`: run live dashboard process.
- `worker:run`: runs `src/workers/run_task.ts` — the containerised worker entry point. Requires env vars `WORKER_ROLE`, `TASK_PAYLOAD`, `TARGET_REPO`, `GITHUB_TOKEN`. See `docker/worker/Dockerfile` for the container contract.
- `doctor`: checks basic tool and env readiness.

## Environment variables

Authoritative source is `src/config.ts`; `.env.example` mirrors the currently supported env surface.

Practical minimum for real GitHub operations:

- `GITHUB_TOKEN`
- `TARGET_REPO`
- `COPILOT_GITHUB_TOKEN` (or `GITHUB_FINEGRADED`)

Common optional overrides:

- `TARGET_BASE_BRANCH` (default: `main`)
- `BOX_BUDGET_USD` (default: `15`)
- `BOX_MODE` (default: `local`)
- `CLAUDE_API_KEY` and `CLAUDE_MODEL` (for Anthropic reviewer/planner paths)

## Dependency audit (documentation-only)

Audit scope: `package.json`, lockfile metadata presence, and Dockerfiles.

Potential upgrade candidates (not upgraded in this change):

- `dotenv` (`^16.4.5`) - review against latest stable line.
- `eslint` (`^10.0.3`) - verify intended version line and ecosystem compatibility.
- `docker/worker/Dockerfile` pins `COPILOT_VERSION=v1.0.3` - review for newer Copilot CLI release.

To verify outdated and vulnerable packages in your environment:

```bash
npm outdated
npm audit
npm audit --omit=dev
```

## Notes from docs audit

- `src/config.ts` supports legacy env key `GITHUB_FINEGRADED` (spelling preserved for backward compatibility). Prefer `COPILOT_GITHUB_TOKEN` in new setups.
- Some historical README sections referenced files that are not present in this repo snapshot; this README now reflects current paths and scripts only.
