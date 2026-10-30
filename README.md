# Research chat

Four shared research conversations. The Next.js app on Vercel stores nothing about which VM it calls in the browser. Each agent is the same Node service on its own exe.dev VM. `AGENT_ID` picks the system prompt.

## Live services

Supabase project `two-sigma` is in Prysma Labs (`us-west-1`). The four VMs are public on port 8000 and run the same service under systemd:

- https://quant-researcher.exe.xyz
- https://onchain-researcher.exe.xyz
- https://fundamental-researcher.exe.xyz
- https://market-researcher.exe.xyz

The website is deployed at https://two-sigma-eight.vercel.app (Prysma Labs project `two-sigma`). Vercel Authentication is on, so opening it requires a Vercel account that can access the project. Do not commit `.env.local` or `.secrets/`.

Model for all four agents: `deepseek/deepseek-v4.1-flash-1017`.

## Secrets

| Name | Where |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Vercel server env and each VM env file |
| `AGENT_SHARED_SECRET` | Vercel server env and each VM env file |
| `AGENT_URL_*` | Vercel server env only |
| `OPENROUTER_API_KEY` | Each VM env file only |
| `AGENT_ID`, `OPENROUTER_MODEL` | Each VM env file |

Copy `.env.example` to `.env.local` for the Next.js app. Never commit `.env`, `.env.local`, `agent/.env`, or `.secrets/`. The secret key and the shared secret must not use a `NEXT_PUBLIC_` name.

Tables have row level security and no policies, so the public Data API cannot read or write them. The servers use the secret key.

## Local

```bash
npm install
npm test
npm run dev
```

```bash
cd agent
npm install
npm test
```

## VMs

Listen on `127.0.0.1:8000`. exe.dev proxies that port at `https://<name>.exe.xyz`. Make the share public so Vercel can call it, and keep `AGENT_SHARED_SECRET` on the request:

```bash
ssh exe.dev share port <vm> 8000
ssh exe.dev share set-public <vm>
```

Copy `agent/` to `/opt/research-agent`, write `/opt/research-agent/.env` as mode 600, then run `sh install.sh`. systemd unit: `agent/research-agent.service`. A restart marks that VM's running row failed.

Suggested VM names: `quant-researcher`, `onchain-researcher`, `fundamental-researcher`, `market-researcher`.

## Vercel

Put the server variables in the project environment, then deploy this directory. The browser polls `/api/agents/<id>` every 1.5 seconds only while that agent's latest run is `running`.
