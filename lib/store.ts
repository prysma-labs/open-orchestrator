import { readFileSync } from "node:fs";
import type { ClaimResult, Role, Snapshot, SubmitResult, Task } from "@/lib/types";

export type QueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export type Heartbeat = { ok: boolean; cancelRequested?: boolean };

export interface Store {
  submit(input: { clientKey: string; content: string; ipHash: string }): Promise<SubmitResult>;
  snapshot(afterSeq?: number): Promise<Snapshot>;
  claim(owner: string, leaseSeconds?: number): Promise<ClaimResult>;
  heartbeat(owner: string, runId: number, leaseSeconds?: number): Promise<Heartbeat>;
  createTask(input: {
    owner: string;
    runId: number;
    role: Role;
    title: string;
    instructions: string;
    sortOrder: number;
  }): Promise<Task>;
  listTasks(runId: number): Promise<Task[]>;
  setTaskState(input: {
    owner: string;
    taskId: number;
    status?: string | null;
    progress?: string | null;
    result?: string | null;
    worktree?: string | null;
    branch?: string | null;
  }): Promise<void>;
  appendEvent(input: {
    owner: string;
    runId: number;
    taskId: number | null;
    kind: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  }): Promise<{ ok: boolean; inserted: boolean; event?: Snapshot["events"][number] }>;
  finishRun(input: {
    owner: string;
    runId: number;
    status: "completed" | "failed" | "interrupted";
    content: string;
    costUsd: number;
  }): Promise<{ ok: boolean }>;
  cancel(requestId: number): Promise<{ ok: boolean; status?: string }>;
}

export function schemaSql(): string {
  return readFileSync(
    new URL("../supabase/migrations/20261027143000_shared_workspace.sql", import.meta.url),
    "utf8",
  );
}

function json<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

async function call<T>(query: QueryFn, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await query(sql, params);
  return json<T>(rows[0]?.result);
}

export function createSqlStore(query: QueryFn): Store {
  return {
    submit: (input) =>
      call<SubmitResult>(
        query,
        "select public.submit_message($1::uuid, $2::text, $3::text) as result",
        [input.clientKey, input.content, input.ipHash],
      ),
    snapshot: (afterSeq = 0) =>
      call<Snapshot>(query, "select public.workspace_snapshot($1::bigint) as result", [afterSeq]),
    claim: (owner, leaseSeconds = 20) =>
      call<ClaimResult>(
        query,
        "select public.claim_next_request($1::text, $2::int) as result",
        [owner, leaseSeconds],
      ),
    heartbeat: async (owner, runId, leaseSeconds = 20) =>
      call<Heartbeat>(
        query,
        "select public.heartbeat_run($1::text, $2::bigint, $3::int) as result",
        [owner, runId, leaseSeconds],
      ),
    createTask: async (input) => {
      const result = await call<{ ok: boolean; task: Task }>(
        query,
        "select public.create_task($1::text, $2::bigint, $3::text, $4::text, $5::text, $6::int) as result",
        [input.owner, input.runId, input.role, input.title, input.instructions, input.sortOrder],
      );
      if (!result.ok) throw new Error("create_task rejected");
      return result.task;
    },
    listTasks: (runId) =>
      call<Task[]>(query, "select public.list_tasks($1::bigint) as result", [runId]),
    setTaskState: async (input) => {
      const result = await call<{ ok: boolean }>(
        query,
        "select public.set_task_state($1::text, $2::bigint, $3::text, $4::text, $5::text, $6::text, $7::text) as result",
        [
          input.owner,
          input.taskId,
          input.status ?? null,
          input.progress ?? null,
          input.result ?? null,
          input.worktree ?? null,
          input.branch ?? null,
        ],
      );
      if (!result.ok) throw new Error("set_task_state rejected");
    },
    appendEvent: (input) =>
      call(
        query,
        "select public.append_event($1::text, $2::bigint, $3::bigint, $4::text, $5::text, $6::jsonb) as result",
        [
          input.owner,
          input.runId,
          input.taskId,
          input.kind,
          input.dedupeKey,
          JSON.stringify(input.payload),
        ],
      ),
    finishRun: (input) =>
      call(
        query,
        "select public.finish_run($1::text, $2::bigint, $3::text, $4::text, $5::numeric) as result",
        [input.owner, input.runId, input.status, input.content, input.costUsd],
      ),
    cancel: (requestId) =>
      call(query, "select public.cancel_request($1::bigint) as result", [requestId]),
  };
}

export async function expireRunningLeases(query: QueryFn): Promise<void> {
  await query(
    "update public.runs set lease_expires_at = clock_timestamp() - interval '1 minute' where status = 'running'",
  );
  await query(
    "update public.requests set lease_expires_at = clock_timestamp() - interval '1 minute' where status = 'running'",
  );
}
