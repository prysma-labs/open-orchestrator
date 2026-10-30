import { createAgentServer } from "./server.js";
import { createSupabaseStore } from "./supabase-store.js";
import { runPi } from "./run-pi.js";
import { promptFor } from "./prompts.js";

const agentId = process.env.AGENT_ID?.trim() ?? "";
const secret = process.env.AGENT_SHARED_SECRET?.trim() ?? "";
if (!agentId || !secret) {
  console.error("AGENT_ID and AGENT_SHARED_SECRET are required");
  process.exit(1);
}
promptFor(agentId);

const store = createSupabaseStore();
await store.failInterrupted(agentId);

const server = createAgentServer({
  agentId,
  secret,
  store,
  run: runPi,
});

const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(`agent ${agentId} listening on ${host}:${port}`);
});
