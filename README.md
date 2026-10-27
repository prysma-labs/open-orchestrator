# Open Orchestrator

A public multi-agent workspace. Everyone who opens the app sees the same conversation, queue, and agent activity. There are no accounts.

A visitor sends a message to the Next.js API. The API stores the message and a queued request in Postgres. A coordinator running outside Vercel claims that request, drives [Pi](https://github.com/earendil-works/pi) over its RPC interface, and delegates work to scout, implementer, and reviewer processes. Viewers receive persisted changes and throttled drafts through Supabase Realtime.

## Local development

```bash
npm install
npm test
npm run dev
```

Open http://localhost:3000 in two windows. The local process uses embedded Postgres (PGlite) and a simulated agent driver, so it runs without Supabase or a model key. Set `SIM_STEP_MS=1200` to slow the simulated agents down.

To drive the real Pi CLI instead:

```bash
PI_DRIVER=rpc npm run dev
```

Pi must be on `PATH` (`pi --version`). The coordinator starts one RPC process per task with `pi --mode rpc --no-session` and reads JSONL events from stdout. Thinking deltas are dropped. Tool commands are redacted before they are stored.

## Production shape

| Piece | Where it runs |
| --- | --- |
| Next.js UI and short API requests | Vercel |
| Postgres, Realtime, RLS | Supabase |
| Coordinator and Pi workers | exe.dev VM |

Vercel does not run Pi. The VM does.

### Supabase

1. Create a project.
2. Run `supabase/migrations/20261027143000_shared_workspace.sql` in the SQL editor, or with `supabase db push`.
3. In Realtime settings, turn **Allow public access** off so the private channel policies apply.
4. Copy the project URL, the anon or publishable key, and the service role key.

The migration enables row level security, lets anonymous visitors read the workspace, and grants write functions only to `service_role`. Anonymous clients can listen to broadcast and track presence. They cannot publish agent events or insert rows.

### Vercel

Import this repository as a Next.js app. Set:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `IP_HASH_SALT`

Do not set `PI_DRIVER` on Vercel. Leave the coordinator off the web deployment.

### exe.dev

Create a VM and install Node.js 22+ and Pi, then run the coordinator under systemd so it restarts after a crash or reboot. See `deploy/orchestrator.service`.

```bash
ssh exe.dev new --name=orchestrator
ssh orchestrator.exe.xyz
# install Node.js and Pi, clone this repo to ~/orchestrator
sudo cp deploy/orchestrator.service /etc/systemd/system/orchestrator.service
sudo systemctl daemon-reload
sudo systemctl enable --now orchestrator
```

Put secrets in `/home/exedev/orchestrator.env` with mode `600`. The unit loads that file. `PI_DRIVER=rpc` is the production setting.

## Environment

See `.env.example`. Local development needs none of them.

| Limit | Default |
| --- | --- |
| Message length | 8,000 characters |
| Queue depth | 20 active requests |
| Submissions | 8 per minute per hashed IP |
| Workers | scout, implementer, and reviewer, at most 3 |
| Active coordinator runs | 1 |
| Model budget | $5, then new work is rejected |
| Lease | 20 seconds, renewed by heartbeat |

## Recovery rules

- Claiming a request and publishing an event are idempotent.
- A second coordinator cannot start a run while a lease is valid.
- If the lease expires before a task has a side effect, that task is queued again on the same run.
- If a task already wrote files or ran a shell command, it is marked interrupted and is not run again.
- After three leases with no completed task, the request fails instead of looping.
- Draft text is checkpointed a few times a second, not on every token. Event ids and sequence numbers keep late or duplicate updates from rendering twice or out of order.

Coding tasks get a git worktree and branch per worker under the coordinator work directory. The coordinator merges the implementer branch. Reviewer and scout do not get write tools when Pi is in RPC mode.

In local development, a message containing `[[fail:implementer]]` makes that worker fail. The dev-only **Simulate coordinator restart** control drops the lease so the next claim recovers the run.

## Assumptions

- One global workspace is enough. There is no per-user history.
- The simulated driver is the default so the UI is usable before model credentials exist. Production on exe.dev should set `PI_DRIVER=rpc`.
- Pi 1.4.0's RPC records (`prompt`, `agent_settled`, `tool_execution_*`, `get_session_stats`) are the integration surface.
- This environment had no Docker daemon, so the migration is applied to embedded Postgres for local runs and is ready to apply to hosted Supabase. It was not applied to the existing Supabase projects in the account.
