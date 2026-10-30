create table public.messages (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  run_id uuid,
  role text not null,
  content text not null,
  created_at timestamptz not null default now(),
  constraint messages_agent_id_known check (
    agent_id in ('quant', 'onchain', 'fundamental', 'market')
  ),
  constraint messages_role_known check (role in ('user', 'assistant'))
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  status text not null,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint runs_agent_id_known check (
    agent_id in ('quant', 'onchain', 'fundamental', 'market')
  ),
  constraint runs_status_known check (status in ('running', 'completed', 'failed'))
);

alter table public.messages
  add constraint messages_run_id_fkey
  foreign key (run_id) references public.runs (id);

create index messages_agent_created_idx
  on public.messages (agent_id, created_at);

create index runs_agent_created_idx
  on public.runs (agent_id, created_at desc);

create unique index runs_one_active_per_agent
  on public.runs (agent_id)
  where status = 'running';

alter table public.messages enable row level security;
alter table public.runs enable row level security;

revoke all on table public.messages from anon, authenticated;
revoke all on table public.runs from anon, authenticated;
