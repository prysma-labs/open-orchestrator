import { agentById, isAgentId } from "@/lib/agents";
import { loadConversation } from "@/lib/db";
import { buildRunRequest } from "@/lib/dispatch";
import type { HistoryMessage } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUSY = "This agent is busy. Try again in a moment.";

type RouteParams = { params: Promise<{ agentId: string }> };

export async function GET(_request: Request, context: RouteParams) {
  const { agentId } = await context.params;
  if (!isAgentId(agentId)) return Response.json({ error: "Unknown agent" }, { status: 404 });
  try {
    const conversation = await loadConversation(agentId);
    return Response.json({
      agentId,
      name: agentById(agentId)?.name,
      ...conversation,
    });
  } catch {
    return Response.json({ error: "Could not load the conversation." }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteParams) {
  const { agentId } = await context.params;
  if (!isAgentId(agentId)) return Response.json({ error: "Unknown agent" }, { status: 404 });

  let content = "";
  try {
    const body = (await request.json()) as { content?: unknown };
    content = typeof body.content === "string" ? body.content.trim() : "";
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!content || content.length > 8000) {
    return Response.json({ error: "Write a message under 8000 characters." }, { status: 400 });
  }

  try {
    const conversation = await loadConversation(agentId);
    const history: HistoryMessage[] = conversation.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const { url, init } = buildRunRequest(agentId, content, history);
    const response = await fetch(url, init);
    if (response.status === 409) return Response.json({ error: BUSY }, { status: 409 });
    if (!response.ok) return Response.json({ error: "The agent did not accept the message." }, { status: 502 });
    const payload = (await response.json()) as { runId?: string };
    return Response.json({ runId: payload.runId }, { status: 202 });
  } catch {
    return Response.json({ error: "Could not reach the agent." }, { status: 502 });
  }
}
