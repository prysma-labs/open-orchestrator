import { createClient } from "@supabase/supabase-js";
import type { AgentId } from "./agents";
import type { ChatMessage, LatestRun } from "./types";

type MessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type RunRow = {
  id: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  created_at: string;
};

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function loadConversation(agentId: AgentId) {
  const supabase = client();
  const [messagesResult, runResult] = await Promise.all([
    supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: true }),
    supabase
      .from("runs")
      .select("id, status, error, created_at")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (messagesResult.error) throw new Error(messagesResult.error.message);
  if (runResult.error) throw new Error(runResult.error.message);

  const messages: ChatMessage[] = (messagesResult.data as MessageRow[]).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
  const latest = runResult.data as RunRow | null;
  const latestRun: LatestRun | null = latest
    ? { id: latest.id, status: latest.status, error: latest.error, createdAt: latest.created_at }
    : null;
  return { messages, latestRun };
}
