-- Shared public workspace. Visitors read through RLS. Writes go through
-- security-definer functions that only service_role may execute.
-- Local tests create the Supabase roles when they are missing.

create sequence if not exists public.workspace_seq;

create table if not exists public.workspace (
  id smallint primary key default 1 check (id = 1),
  title text not null default 'Shared workspace',
  budget_limit_usd numeric(12, 6) not null default 5,
  budget_spent_usd numeric(12, 6) not null default 0,
  max_queue integer not null default 20 check (max_queue > 0),
  max_message_chars integer not null default 8000 check (max_message_chars > 0),
  rate_limit_per_minute integer not null default 8 check (rate_limit_per_minute > 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.workspace (id) values (1) on conflict (id) do nothing;

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  seq bigint not null unique default nextval('public.workspace_seq'),
  request_id bigint,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 100000),
  status text not null check (status in ('complete', 'failed')),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.requests (
  id bigint generated always as identity primary key,
  client_key uuid not null unique,
  message_id bigint not null references public.messages (id),
  content text not null,
  status text not null check (status in (
    'queued', 'claimed', 'running', 'completed', 'failed', 'interrupted', 'cancelled'
  )),
  run_id bigint,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt integer not null default 0 check (attempt >= 0),
  cancel_requested boolean not null default false,
  error text,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists requests_message_id_idx on public.requests (message_id);
create index if not exists requests_queued_idx on public.requests (created_at, id)
  where status = 'queued';

alter table public.messages
  drop constraint if exists messages_request_id_fkey;
alter table public.messages
  add constraint messages_request_id_fkey
  foreign key (request_id) references public.requests (id);

create index if not exists messages_request_id_idx on public.messages (request_id);
create unique index if not exists messages_one_assistant_idx
  on public.messages (request_id)
  where role = 'assistant';

create table if not exists public.runs (
  id bigint generated always as identity primary key,
  request_id bigint not null unique references public.requests (id),
  status text not null check (status in ('running', 'completed', 'failed', 'interrupted')),
  coordinator_id text not null,
  lease_expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  draft_text text not null default '',
  draft_seq bigint not null default 0,
  summary text,
  cost_usd numeric(12, 6) not null default 0,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);

create unique index if not exists runs_one_active_idx
  on public.runs ((1))
  where status = 'running';

alter table public.requests
  drop constraint if exists requests_run_id_fkey;
alter table public.requests
  add constraint requests_run_id_fkey
  foreign key (run_id) references public.runs (id);

create table if not exists public.agent_tasks (
  id bigint generated always as identity primary key,
  run_id bigint not null references public.runs (id),
  role text not null check (role in ('scout', 'implementer', 'reviewer')),
  title text not null,
  instructions text not null,
  status text not null check (status in (
    'queued', 'running', 'completed', 'failed', 'interrupted'
  )),
  progress_summary text not null default '',
  result text,
  tools jsonb not null default '[]'::jsonb,
  tool_count integer not null default 0,
  side_effects boolean not null default false,
  worktree_path text,
  branch text,
  sort_order integer not null,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (run_id, role)
);

create index if not exists agent_tasks_run_id_idx on public.agent_tasks (run_id, sort_order);

create table if not exists public.events (
  id bigint generated always as identity primary key,
  seq bigint not null unique default nextval('public.workspace_seq'),
  run_id bigint references public.runs (id),
  task_id bigint references public.agent_tasks (id),
  request_id bigint references public.requests (id),
  kind text not null check (kind in (
    'progress', 'tool', 'status', 'checkpoint', 'result', 'error'
  )),
  dedupe_key text not null unique,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists events_run_id_idx on public.events (run_id);
create index if not exists events_task_id_idx on public.events (task_id);
create index if not exists events_request_id_idx on public.events (request_id);

create table if not exists public.rate_windows (
  ip_hash text primary key,
  window_start timestamptz not null,
  hits integer not null check (hits >= 0)
);

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

create or replace function public.submit_message(
  p_client_key uuid,
  p_content text,
  p_ip_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws public.workspace%rowtype;
  v_existing record;
  v_hits integer;
  v_depth integer;
  v_message_id bigint;
  v_request_id bigint;
  v_trimmed text;
begin
  if p_ip_hash is null or char_length(p_ip_hash) < 16 or char_length(p_ip_hash) > 128 then
    return jsonb_build_object('ok', false, 'error', 'invalid_client');
  end if;

  perform pg_advisory_xact_lock(641003);

  select * into v_existing
  from public.requests
  where client_key = p_client_key;

  if found then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'requestId', v_existing.id,
      'messageId', v_existing.message_id,
      'status', v_existing.status
    );
  end if;

  select * into v_ws from public.workspace where id = 1 for update;
  v_trimmed := btrim(p_content);

  if v_trimmed = '' then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  if char_length(v_trimmed) > v_ws.max_message_chars then
    return jsonb_build_object('ok', false, 'error', 'too_long', 'limit', v_ws.max_message_chars);
  end if;

  if v_ws.budget_spent_usd >= v_ws.budget_limit_usd then
    return jsonb_build_object('ok', false, 'error', 'budget');
  end if;

  insert into public.rate_windows as w (ip_hash, window_start, hits)
  values (p_ip_hash, date_trunc('minute', clock_timestamp()), 1)
  on conflict (ip_hash) do update
  set
    hits = case
      when w.window_start = date_trunc('minute', clock_timestamp()) then w.hits + 1
      else 1
    end,
    window_start = date_trunc('minute', clock_timestamp())
  returning hits into v_hits;

  if v_hits > v_ws.rate_limit_per_minute then
    return jsonb_build_object('ok', false, 'error', 'rate_limit');
  end if;

  select count(*) into v_depth
  from public.requests
  where status in ('queued', 'claimed', 'running');

  if v_depth >= v_ws.max_queue then
    return jsonb_build_object('ok', false, 'error', 'queue_full', 'limit', v_ws.max_queue);
  end if;

  insert into public.messages (role, content, status)
  values ('user', v_trimmed, 'complete')
  returning id into v_message_id;

  insert into public.requests (client_key, message_id, content, status)
  values (p_client_key, v_message_id, v_trimmed, 'queued')
  returning id into v_request_id;

  update public.messages
  set request_id = v_request_id
  where id = v_message_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'requestId', v_request_id,
    'messageId', v_message_id,
    'status', 'queued'
  );
exception
  when unique_violation then
    select * into v_existing from public.requests where client_key = p_client_key;
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'requestId', v_existing.id,
      'messageId', v_existing.message_id,
      'status', v_existing.status
    );
end;
$$;

create or replace function public.fail_run(
  p_run_id bigint,
  p_status text,
  p_summary text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_message_id bigint;
begin
  select * into v_run from public.runs where id = p_run_id for update;
  if not found or v_run.status <> 'running' then
    return;
  end if;

  update public.runs
  set status = p_status, summary = p_summary, finished_at = clock_timestamp()
  where id = p_run_id;

  update public.requests
  set status = p_status, error = p_summary, finished_at = clock_timestamp()
  where id = v_run.request_id;

  update public.agent_tasks
  set status = case when status in ('queued', 'running') then 'interrupted' else status end,
      finished_at = case when status in ('queued', 'running') then clock_timestamp() else finished_at end,
      updated_at = clock_timestamp()
  where run_id = p_run_id;

  insert into public.messages (request_id, role, content, status)
  values (v_run.request_id, 'assistant', p_summary, 'failed')
  on conflict (request_id) where role = 'assistant' do nothing
  returning id into v_message_id;
end;
$$;

create or replace function public.claim_next_request(
  p_owner text,
  p_lease_seconds integer default 20
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws public.workspace%rowtype;
  v_run public.runs%rowtype;
  v_request public.requests%rowtype;
  v_has_progress boolean;
begin
  if p_owner is null or char_length(p_owner) < 4 or char_length(p_owner) > 120 then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_owner');
  end if;
  if p_lease_seconds < 5 or p_lease_seconds > 120 then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_lease');
  end if;

  perform pg_advisory_xact_lock(641003);

  select * into v_run
  from public.runs
  where status = 'running' and lease_expires_at < clock_timestamp()
  order by id
  limit 1
  for update skip locked;

  if found then
    select * into v_request from public.requests where id = v_run.request_id for update;
    select exists (
      select 1 from public.agent_tasks
      where run_id = v_run.id and status = 'completed'
    ) into v_has_progress;

    if v_request.attempt >= 3 and not v_has_progress then
      perform public.fail_run(
        v_run.id,
        'failed',
        'The coordinator restarted repeatedly before this request made progress, so it was not run again.'
      );
    else
      update public.agent_tasks
      set status = 'interrupted',
          finished_at = clock_timestamp(),
          progress_summary = 'Stopped after a side effect. This task was not retried.',
          updated_at = clock_timestamp()
      where run_id = v_run.id and status = 'running' and side_effects;

      update public.agent_tasks
      set status = 'queued',
          started_at = null,
          progress_summary = 'Requeued after the coordinator lease expired.',
          updated_at = clock_timestamp()
      where run_id = v_run.id and status = 'running' and not side_effects;

      update public.runs
      set coordinator_id = p_owner,
          lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
          heartbeat_at = clock_timestamp()
      where id = v_run.id;

      update public.requests
      set status = 'running',
          lease_owner = p_owner,
          lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
          heartbeat_at = clock_timestamp(),
          attempt = attempt + 1,
          started_at = coalesce(started_at, clock_timestamp())
      where id = v_run.request_id;

      return jsonb_build_object(
        'claimed', true,
        'resumed', true,
        'requestId', v_run.request_id,
        'runId', v_run.id,
        'messageId', v_request.message_id,
        'content', v_request.content,
        'cancelRequested', v_request.cancel_requested
      );
    end if;
  end if;

  if exists (
    select 1 from public.runs
    where status = 'running' and lease_expires_at >= clock_timestamp()
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'busy');
  end if;

  select * into v_ws from public.workspace where id = 1;
  if v_ws.budget_spent_usd >= v_ws.budget_limit_usd then
    return jsonb_build_object('claimed', false, 'reason', 'budget');
  end if;

  select * into v_request
  from public.requests
  where status = 'queued'
  order by created_at, id
  limit 1
  for update skip locked;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'idle');
  end if;

  insert into public.runs (request_id, status, coordinator_id, lease_expires_at, heartbeat_at)
  values (
    v_request.id,
    'running',
    p_owner,
    clock_timestamp() + make_interval(secs => p_lease_seconds),
    clock_timestamp()
  )
  returning * into v_run;

  update public.requests
  set status = 'running',
      run_id = v_run.id,
      lease_owner = p_owner,
      lease_expires_at = v_run.lease_expires_at,
      heartbeat_at = v_run.heartbeat_at,
      attempt = attempt + 1,
      started_at = clock_timestamp()
  where id = v_request.id;

  return jsonb_build_object(
    'claimed', true,
    'resumed', false,
    'requestId', v_request.id,
    'runId', v_run.id,
    'messageId', v_request.message_id,
    'content', v_request.content,
    'cancelRequested', v_request.cancel_requested
  );
end;
$$;

create or replace function public.heartbeat_run(
  p_owner text,
  p_run_id bigint,
  p_lease_seconds integer default 20
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_cancel boolean;
begin
  update public.runs
  set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      heartbeat_at = clock_timestamp()
  where id = p_run_id
    and coordinator_id = p_owner
    and status = 'running'
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', false);
  end if;

  update public.requests r
  set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      heartbeat_at = clock_timestamp()
  from public.runs run
  where run.id = p_run_id and r.id = run.request_id
  returning r.cancel_requested into v_cancel;

  return jsonb_build_object('ok', true, 'cancelRequested', coalesce(v_cancel, false));
end;
$$;

create or replace function public.create_task(
  p_owner text,
  p_run_id bigint,
  p_role text,
  p_title text,
  p_instructions text,
  p_sort_order integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.agent_tasks%rowtype;
begin
  if not exists (
    select 1 from public.runs
    where id = p_run_id and coordinator_id = p_owner and status = 'running'
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_owner');
  end if;

  insert into public.agent_tasks (run_id, role, title, instructions, status, sort_order)
  values (p_run_id, p_role, left(p_title, 200), left(p_instructions, 8000), 'queued', p_sort_order)
  on conflict (run_id, role) do nothing
  returning * into v_task;

  if v_task.id is null then
    select * into v_task from public.agent_tasks where run_id = p_run_id and role = p_role;
  end if;

  return jsonb_build_object(
    'ok', true,
    'task', jsonb_build_object(
      'id', v_task.id,
      'runId', v_task.run_id,
      'role', v_task.role,
      'title', v_task.title,
      'instructions', v_task.instructions,
      'status', v_task.status,
      'progressSummary', v_task.progress_summary,
      'result', v_task.result,
      'tools', v_task.tools,
      'sideEffects', v_task.side_effects,
      'worktreePath', v_task.worktree_path,
      'branch', v_task.branch,
      'sortOrder', v_task.sort_order
    )
  );
end;
$$;

create or replace function public.set_task_state(
  p_owner text,
  p_task_id bigint,
  p_status text,
  p_progress text,
  p_result text,
  p_worktree text,
  p_branch text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.agent_tasks%rowtype;
begin
  select t.* into v_task
  from public.agent_tasks t
  join public.runs r on r.id = t.run_id
  where t.id = p_task_id
    and r.coordinator_id = p_owner
    and r.status = 'running'
  for update of t;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_owner');
  end if;

  update public.agent_tasks
  set status = coalesce(p_status, status),
      progress_summary = coalesce(p_progress, progress_summary),
      result = coalesce(p_result, result),
      worktree_path = coalesce(p_worktree, worktree_path),
      branch = coalesce(p_branch, branch),
      started_at = case
        when p_status = 'running' and started_at is null then clock_timestamp()
        else started_at
      end,
      finished_at = case
        when p_status in ('completed', 'failed', 'interrupted') then clock_timestamp()
        else finished_at
      end,
      updated_at = clock_timestamp()
  where id = p_task_id
  returning * into v_task;

  return jsonb_build_object('ok', true, 'status', v_task.status);
end;
$$;

create or replace function public.append_event(
  p_owner text,
  p_run_id bigint,
  p_task_id bigint,
  p_kind text,
  p_dedupe_key text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id bigint;
  v_event public.events%rowtype;
  v_inserted boolean := false;
  v_summary text;
  v_tools jsonb;
begin
  select request_id into v_request_id
  from public.runs
  where id = p_run_id and coordinator_id = p_owner and status = 'running';

  if v_request_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_owner');
  end if;

  insert into public.events (run_id, task_id, request_id, kind, dedupe_key, payload)
  values (p_run_id, p_task_id, v_request_id, p_kind, p_dedupe_key, p_payload)
  on conflict (dedupe_key) do nothing
  returning * into v_event;

  if v_event.id is null then
    select * into v_event from public.events where dedupe_key = p_dedupe_key;
  else
    v_inserted := true;
  end if;

  if v_inserted and p_kind = 'checkpoint' then
    update public.runs
    set draft_text = left(coalesce(p_payload->>'text', ''), 100000),
        draft_seq = v_event.seq
    where id = p_run_id and v_event.seq >= draft_seq;
  elsif v_inserted and p_kind = 'progress' and p_task_id is not null then
    v_summary := left(coalesce(p_payload->>'summary', ''), 500);
    update public.agent_tasks
    set progress_summary = v_summary, updated_at = clock_timestamp()
    where id = p_task_id;
  elsif v_inserted and p_kind = 'tool' and p_task_id is not null then
    select tools into v_tools from public.agent_tasks where id = p_task_id;
    update public.agent_tasks
    set tool_count = tool_count + 1,
        side_effects = side_effects or coalesce((p_payload->>'sideEffect')::boolean, false),
        tools = (
          select coalesce(jsonb_agg(x order by n), '[]'::jsonb)
          from (
            select x, n
            from jsonb_array_elements(coalesce(v_tools, '[]'::jsonb) || jsonb_build_array(p_payload))
              with ordinality as t(x, n)
            order by n desc
            limit 40
          ) q
        ),
        progress_summary = left(coalesce(p_payload->>'summary', progress_summary), 500),
        updated_at = clock_timestamp()
    where id = p_task_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'event', jsonb_build_object(
      'id', v_event.id,
      'seq', v_event.seq,
      'runId', v_event.run_id,
      'taskId', v_event.task_id,
      'requestId', v_event.request_id,
      'kind', v_event.kind,
      'dedupeKey', v_event.dedupe_key,
      'payload', v_event.payload,
      'createdAt', v_event.created_at
    )
  );
end;
$$;

create or replace function public.finish_run(
  p_owner text,
  p_run_id bigint,
  p_status text,
  p_content text,
  p_cost_usd numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_message_id bigint;
  v_status text;
begin
  if p_status not in ('completed', 'failed', 'interrupted') then
    return jsonb_build_object('ok', false, 'error', 'bad_status');
  end if;

  select * into v_run
  from public.runs
  where id = p_run_id and coordinator_id = p_owner and status = 'running'
  for update;

  if not found then
    select m.id into v_message_id
    from public.messages m
    join public.runs r on r.request_id = m.request_id
    where r.id = p_run_id and m.role = 'assistant';
    return jsonb_build_object('ok', false, 'error', 'not_owner', 'messageId', v_message_id);
  end if;

  v_status := case when p_status = 'completed' then 'complete' else 'failed' end;

  insert into public.messages (request_id, role, content, status)
  values (v_run.request_id, 'assistant', left(p_content, 100000), v_status)
  on conflict (request_id) where role = 'assistant' do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select id into v_message_id
    from public.messages
    where request_id = v_run.request_id and role = 'assistant';
  end if;

  update public.runs
  set status = p_status,
      summary = left(p_content, 500),
      draft_text = left(p_content, 100000),
      cost_usd = greatest(coalesce(p_cost_usd, 0), 0),
      finished_at = clock_timestamp()
  where id = p_run_id;

  update public.requests
  set status = p_status,
      finished_at = clock_timestamp(),
      error = case when p_status = 'completed' then null else left(p_content, 500) end
  where id = v_run.request_id;

  update public.workspace
  set budget_spent_usd = budget_spent_usd + greatest(coalesce(p_cost_usd, 0), 0),
      updated_at = clock_timestamp()
  where id = 1;

  return jsonb_build_object('ok', true, 'messageId', v_message_id, 'duplicate', false);
end;
$$;

create or replace function public.cancel_request(p_request_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.requests%rowtype;
begin
  select * into v_request from public.requests where id = p_request_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'missing');
  end if;

  if v_request.status = 'queued' then
    update public.requests
    set status = 'cancelled', finished_at = clock_timestamp()
    where id = p_request_id;
    return jsonb_build_object('ok', true, 'status', 'cancelled');
  end if;

  if v_request.status = 'running' then
    update public.requests set cancel_requested = true where id = p_request_id;
    return jsonb_build_object('ok', true, 'status', 'cancel_requested');
  end if;

  return jsonb_build_object('ok', true, 'status', v_request.status);
end;
$$;

create or replace function public.workspace_snapshot(p_after bigint default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws public.workspace%rowtype;
  v_last bigint;
begin
  select * into v_ws from public.workspace where id = 1;
  select coalesce(max(seq), 0) into v_last from (
    select seq from public.messages
    union all
    select seq from public.events
  ) s;

  return jsonb_build_object(
    'budget', jsonb_build_object(
      'spentUsd', v_ws.budget_spent_usd,
      'limitUsd', v_ws.budget_limit_usd
    ),
    'lastSeq', v_last,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'seq', m.seq,
        'requestId', m.request_id,
        'role', m.role,
        'content', m.content,
        'status', m.status,
        'createdAt', m.created_at
      ) order by m.seq)
      from (
        select * from public.messages order by seq desc limit 200
      ) m
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'content', left(r.content, 280),
        'status', r.status,
        'runId', r.run_id,
        'attempt', r.attempt,
        'cancelRequested', r.cancel_requested,
        'error', r.error,
        'createdAt', r.created_at,
        'startedAt', r.started_at,
        'finishedAt', r.finished_at
      ) order by r.created_at, r.id)
      from public.requests r
      where r.status in ('queued', 'claimed', 'running')
         or r.created_at > clock_timestamp() - interval '1 day'
    ), '[]'::jsonb),
    'run', (
      select jsonb_build_object(
        'id', run.id,
        'requestId', run.request_id,
        'status', run.status,
        'draftText', run.draft_text,
        'draftSeq', run.draft_seq,
        'summary', run.summary,
        'costUsd', run.cost_usd,
        'startedAt', run.started_at,
        'finishedAt', run.finished_at
      )
      from public.runs run
      where run.status = 'running'
         or run.id = (select max(id) from public.runs)
      order by case when run.status = 'running' then 0 else 1 end, run.id desc
      limit 1
    ),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'runId', t.run_id,
        'role', t.role,
        'title', t.title,
        'instructions', t.instructions,
        'status', t.status,
        'progressSummary', t.progress_summary,
        'result', t.result,
        'tools', t.tools,
        'toolCount', t.tool_count,
        'sideEffects', t.side_effects,
        'worktreePath', t.worktree_path,
        'branch', t.branch,
        'sortOrder', t.sort_order,
        'updatedAt', t.updated_at
      ) order by t.sort_order)
      from public.agent_tasks t
      where t.run_id in (
        select id from public.runs
        where status = 'running' or id = (select max(id) from public.runs)
      )
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'seq', e.seq,
        'runId', e.run_id,
        'taskId', e.task_id,
        'requestId', e.request_id,
        'kind', e.kind,
        'dedupeKey', e.dedupe_key,
        'payload', e.payload,
        'createdAt', e.created_at
      ) order by e.seq)
      from (
        select * from public.events
        where seq > p_after
        order by seq
        limit 2000
      ) e
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.list_tasks(p_run_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id,
      'runId', t.run_id,
      'role', t.role,
      'title', t.title,
      'instructions', t.instructions,
      'status', t.status,
      'progressSummary', t.progress_summary,
      'result', t.result,
      'tools', t.tools,
      'sideEffects', t.side_effects,
      'worktreePath', t.worktree_path,
      'branch', t.branch,
      'sortOrder', t.sort_order
    ) order by t.sort_order)
    from public.agent_tasks t
    where t.run_id = p_run_id
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Access. Roles exist on Supabase; create them for local Postgres tests.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

grant select on
  public.workspace,
  public.messages,
  public.requests,
  public.runs,
  public.agent_tasks,
  public.events
to anon, authenticated;

revoke all on public.rate_windows from public, anon, authenticated;
grant select, insert, update, delete on public.rate_windows to service_role;

alter table public.workspace enable row level security;
alter table public.messages enable row level security;
alter table public.requests enable row level security;
alter table public.runs enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.events enable row level security;
alter table public.rate_windows enable row level security;

alter table public.workspace force row level security;
alter table public.messages force row level security;
alter table public.requests force row level security;
alter table public.runs force row level security;
alter table public.agent_tasks force row level security;
alter table public.events force row level security;
alter table public.rate_windows force row level security;

drop policy if exists workspace_read on public.workspace;
drop policy if exists messages_read on public.messages;
drop policy if exists requests_read on public.requests;
drop policy if exists runs_read on public.runs;
drop policy if exists tasks_read on public.agent_tasks;
drop policy if exists events_read on public.events;

create policy workspace_read on public.workspace
  for select to anon, authenticated using (true);
create policy messages_read on public.messages
  for select to anon, authenticated using (true);
create policy requests_read on public.requests
  for select to anon, authenticated using (true);
create policy runs_read on public.runs
  for select to anon, authenticated using (true);
create policy tasks_read on public.agent_tasks
  for select to anon, authenticated using (true);
create policy events_read on public.events
  for select to anon, authenticated using (true);

revoke all on function public.submit_message(uuid, text, text) from public, anon, authenticated;
revoke all on function public.fail_run(bigint, text, text) from public, anon, authenticated;
revoke all on function public.claim_next_request(text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_run(text, bigint, integer) from public, anon, authenticated;
revoke all on function public.create_task(text, bigint, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.set_task_state(text, bigint, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.append_event(text, bigint, bigint, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.finish_run(text, bigint, text, text, numeric) from public, anon, authenticated;
revoke all on function public.cancel_request(bigint) from public, anon, authenticated;
revoke all on function public.list_tasks(bigint) from public, anon, authenticated;
revoke all on function public.workspace_snapshot(bigint) from public;

grant execute on function public.submit_message(uuid, text, text) to service_role;
grant execute on function public.fail_run(bigint, text, text) to service_role;
grant execute on function public.claim_next_request(text, integer) to service_role;
grant execute on function public.heartbeat_run(text, bigint, integer) to service_role;
grant execute on function public.create_task(text, bigint, text, text, text, integer) to service_role;
grant execute on function public.set_task_state(text, bigint, text, text, text, text, text) to service_role;
grant execute on function public.append_event(text, bigint, bigint, text, text, jsonb) to service_role;
grant execute on function public.finish_run(text, bigint, text, text, numeric) to service_role;
grant execute on function public.cancel_request(bigint) to service_role;
grant execute on function public.list_tasks(bigint) to service_role;
grant execute on function public.workspace_snapshot(bigint) to anon, authenticated, service_role;

-- Postgres Changes: tables join the realtime publication when it exists.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['workspace', 'messages', 'requests', 'runs', 'agent_tasks', 'events']
    loop
      if not exists (
        select 1
        from pg_publication_rel pr
        join pg_publication p on p.oid = pr.prpubid
        join pg_class c on c.oid = pr.prrelid
        join pg_namespace n on n.oid = c.relnamespace
        where p.pubname = 'supabase_realtime'
          and n.nspname = 'public'
          and c.relname = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- Private broadcast/presence. Anon may listen and announce presence.
-- Anon may not insert broadcast rows, so agent events cannot be forged.
-- Disable "Allow public access" in the Supabase Realtime settings so these
-- policies are what actually gates the private channel.
do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'realtime' and c.relname = 'messages'
  ) then
    execute 'drop policy if exists workspace_receive on realtime.messages';
    execute 'drop policy if exists workspace_presence on realtime.messages';
    execute $policy$
      create policy workspace_receive on realtime.messages
      for select to anon, authenticated
      using (
        (select realtime.topic()) = 'workspace:shared'
        and realtime.messages.extension in ('broadcast', 'presence')
      )
    $policy$;
    execute $policy$
      create policy workspace_presence on realtime.messages
      for insert to anon, authenticated
      with check (
        (select realtime.topic()) = 'workspace:shared'
        and realtime.messages.extension = 'presence'
      )
    $policy$;
  end if;
end $$;
