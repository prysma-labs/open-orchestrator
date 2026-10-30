import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authorized } from "./auth.js";
import { promptFor } from "./prompts.js";
import type { HistoryMessage, Runner, Store } from "./types.js";

const MAX_BODY = 1_000_000;
const MAX_CONTENT = 8_000;
const MAX_HISTORY = 40;

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function parseHistory(value: unknown): HistoryMessage[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("history must be an array");
  return value.slice(-MAX_HISTORY).map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid history");
    const record = item as { role?: unknown; content?: unknown };
    if (record.role !== "user" && record.role !== "assistant") {
      throw new Error("invalid history role");
    }
    if (typeof record.content !== "string" || record.content.length > MAX_CONTENT) {
      throw new Error("invalid history content");
    }
    return { role: record.role, content: record.content };
  });
}

export function createAgentServer(options: {
  agentId: string;
  secret: string;
  store: Store;
  run: Runner;
}) {
  const { agentId, secret, store, run } = options;
  const systemPrompt = promptFor(agentId);

  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    try {
      if (req.method === "GET" && path === "/health") {
        send(res, 200, { ok: true, agentId });
        return;
      }

      if (req.method !== "POST" || path !== "/runs") {
        send(res, 404, { error: "not found" });
        return;
      }

      if (!authorized(req.headers.authorization, secret)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      const body = await readJson(req);
      if (!body || typeof body !== "object") {
        send(res, 400, { error: "invalid request" });
        return;
      }
      const record = body as { content?: unknown; history?: unknown };
      const content = typeof record.content === "string" ? record.content.trim() : "";
      if (!content || content.length > MAX_CONTENT) {
        send(res, 400, { error: "content is required" });
        return;
      }
      const history = parseHistory(record.history);
      const started = await store.startRun(agentId, content);
      if (!started.ok) {
        send(res, 409, { error: "busy" });
        return;
      }

      send(res, 202, { runId: started.runId });
      void run({ systemPrompt, history, content })
        .then((text) => store.completeRun(agentId, started.runId, text))
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : "The run failed.";
          await store.failRun(started.runId, message.slice(0, 500)).catch(() => undefined);
        });
    } catch {
      if (!res.headersSent) send(res, 400, { error: "invalid request" });
    }
  });
}
