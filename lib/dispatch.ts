import { agentBaseUrl, type AgentId } from "./agents";
import type { HistoryMessage } from "./types";

const HISTORY_LIMIT = 40;

export function buildRunRequest(
  agentId: AgentId,
  content: string,
  history: HistoryMessage[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const secret = env.AGENT_SHARED_SECRET?.trim();
  if (!secret) throw new Error("Missing AGENT_SHARED_SECRET");
  return {
    url: `${agentBaseUrl(agentId, env)}/runs`,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content,
        history: history.slice(-HISTORY_LIMIT),
      }),
      signal: AbortSignal.timeout(15_000),
    } satisfies RequestInit,
  };
}
