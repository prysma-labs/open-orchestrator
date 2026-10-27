import { hostname } from "node:os";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { startCoordinator } from "@/coordinator/loop";
import type { ClaimResult, Snapshot, SubmitResult, Task } from "@/lib/types";
import { createSqlStore, type Heartbeat, type Store } from "@/lib/store";

type Rpc = <T>(fn: string, args: Record<string, unknown>) => Promise<T>;

export function createSupabaseStore(client: SupabaseClient): Store & { close: () => Promise<void> } {
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;
  const rpc: Rpc = async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data as never;
  };

  const publish = async (event: unknown) => {
    if (!channel) {
      channel = client.channel("workspace:shared", { config: { private: true } });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("realtime subscribe timed out")), 8000);
        channel?.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timer);
            resolve();
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timer);
            reject(new Error(status));
          }
        });
      }).catch(() => {
        channel = null;
      });
    }
    if (!channel) return;
    await channel.send({ type: "broadcast", event: "agent_event", payload: event }).catch(() => undefined);
  };

  return {
    submit: (input) => rpc<SubmitResult>("submit_message", {
      p_client_key: input.clientKey,
      p_content: input.content,
      p_ip_hash: input.ipHash,
    }),
    snapshot: (afterSeq = 0) => rpc<Snapshot>("workspace_snapshot", { p_after: afterSeq }),
    claim: (owner, leaseSeconds = 20) => rpc<ClaimResult>("claim_next_request", {
      p_owner: owner,
      p_lease_seconds: leaseSeconds,
    }),
    heartbeat: (owner, runId, leaseSeconds = 20) => rpc<Heartbeat>("heartbeat_run", {
      p_owner: owner,
      p_run_id: runId,
      p_lease_seconds: leaseSeconds,
    }),
    createTask: async (input) => {
      const result = await rpc<{ ok: boolean; task: Task }>("create_task", {
        p_owner: input.owner,
        p_run_id: input.runId,
        p_role: input.role,
        p_title: input.title,
        p_instructions: input.instructions,
        p_sort_order: input.sortOrder,
      });
      if (!result.ok) throw new Error("create_task rejected");
      return result.task;
    },
    listTasks: (runId) => rpc<Task[]>("list_tasks", { p_run_id: runId }),
    setTaskState: async (input) => {
      const result = await rpc<{ ok: boolean }>("set_task_state", {
        p_owner: input.owner,
        p_task_id: input.taskId,
        p_status: input.status ?? null,
        p_progress: input.progress ?? null,
        p_result: input.result ?? null,
        p_worktree: input.worktree ?? null,
        p_branch: input.branch ?? null,
      });
      if (!result.ok) throw new Error("set_task_state rejected");
    },
    appendEvent: async (input) => {
      const result = await rpc<{ ok: boolean; inserted: boolean; event?: Snapshot["events"][number] }>("append_event", {
        p_owner: input.owner,
        p_run_id: input.runId,
        p_task_id: input.taskId,
        p_kind: input.kind,
        p_dedupe_key: input.dedupeKey,
        p_payload: input.payload,
      });
      if (result.inserted && result.event) await publish(result.event);
      return result;
    },
    finishRun: (input) => rpc("finish_run", {
      p_owner: input.owner,
      p_run_id: input.runId,
      p_status: input.status,
      p_content: input.content,
      p_cost_usd: input.costUsd,
    }),
    cancel: (requestId) => rpc("cancel_request", { p_request_id: requestId }),
    async close() {
      if (channel) await client.removeChannel(channel);
    },
  };
}

export function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function runRemoteCoordinator(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const store = createSupabaseStore(client);
  const owner = process.env.COORDINATOR_ID || `exe-${hostname()}`;
  const handle = startCoordinator({
    store,
    owner,
    workRoot: process.env.WORK_ROOT || "/var/lib/orchestrator",
    allowFailureInjection: process.env.ALLOW_FAILURE_INJECTION === "1",
    pollMs: Number(process.env.POLL_MS ?? 1000),
  });
  const stop = async () => {
    await handle.stop();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
