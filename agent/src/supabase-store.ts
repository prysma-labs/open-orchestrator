import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { StoredMessage, StoredRun, Store } from "./types.js";

type MessageRow = {
  id: string;
  agent_id: string;
  run_id: string | null;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type RunRow = {
  id: string;
  agent_id: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

function messageFrom(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    agentId: row.agent_id,
    runId: row.run_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

function runFrom(row: RunRow): StoredRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export class SupabaseStore implements Store {
  constructor(private readonly supabase: SupabaseClient) {}

  async listMessages(agentId: string) {
    const { data, error } = await this.supabase
      .from("messages")
      .select("id, agent_id, run_id, role, content, created_at")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data as MessageRow[]).map(messageFrom);
  }

  async latestRun(agentId: string) {
    const { data, error } = await this.supabase
      .from("runs")
      .select("id, agent_id, status, error, created_at, finished_at")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? runFrom(data as RunRow) : null;
  }

  async startRun(agentId: string, content: string) {
    const runId = randomUUID();
    const { error } = await this.supabase.from("runs").insert({
      id: runId,
      agent_id: agentId,
      status: "running",
    });
    if (error?.code === "23505") return { ok: false as const, busy: true as const };
    if (error) throw new Error(error.message);

    const { error: messageError } = await this.supabase.from("messages").insert({
      id: randomUUID(),
      agent_id: agentId,
      run_id: runId,
      role: "user",
      content,
    });
    if (messageError) {
      await this.failRun(runId, "Could not save the message.");
      throw new Error(messageError.message);
    }
    return { ok: true as const, runId };
  }

  async completeRun(agentId: string, runId: string, content: string) {
    const finishedAt = new Date().toISOString();
    const { data, error } = await this.supabase
      .from("runs")
      .update({ status: "completed", error: null, finished_at: finishedAt })
      .eq("id", runId)
      .eq("status", "running")
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) return;

    const { error: messageError } = await this.supabase.from("messages").insert({
      id: randomUUID(),
      agent_id: agentId,
      run_id: runId,
      role: "assistant",
      content,
    });
    if (messageError) {
      await this.supabase
        .from("runs")
        .update({
          status: "failed",
          error: "Could not save the response.",
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
      throw new Error(messageError.message);
    }
  }

  async failRun(runId: string, errorMessage: string) {
    const { error } = await this.supabase
      .from("runs")
      .update({
        status: "failed",
        error: errorMessage.slice(0, 500),
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("status", "running");
    if (error) throw new Error(error.message);
  }

  async failInterrupted(agentId: string) {
    const { error } = await this.supabase
      .from("runs")
      .update({
        status: "failed",
        error: "Run interrupted by service restart.",
        finished_at: new Date().toISOString(),
      })
      .eq("agent_id", agentId)
      .eq("status", "running");
    if (error) throw new Error(error.message);
  }
}

export function createSupabaseStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  return new SupabaseStore(
    createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
  );
}
