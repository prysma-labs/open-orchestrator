import assert from "node:assert/strict";
import test from "node:test";
import { PiRpcSession } from "../coordinator/pi-session.ts";
import { createLineBuffer, interpretPiRecord, toolSummary } from "../lib/pi.ts";

test("stdout frames split only on line feeds", () => {
  const lines = [];
  const push = createLineBuffer((line) => lines.push(line));
  push(Buffer.from('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"line\u2028one"}}'));
  push(Buffer.from("\n"));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).assistantMessageEvent.delta, "line\u2028one");
});

test("tool summaries hide credentials and thinking is dropped", () => {
  const summary = toolSummary("bash", { command: "echo API_KEY=sk-supersecretvalue" });
  assert.equal(summary.sideEffect, true);
  assert.equal(summary.summary.includes("sk-supersecretvalue"), false);
  assert.equal(summary.summary.includes("[redacted]"), true);
  const hidden = interpretPiRecord({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
  });
  assert.equal(hidden, null);
  const visible = interpretPiRecord({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  });
  assert.equal(visible?.type, "text");
});

test("the RPC client collects visible output from a Pi process", async () => {
  process.env.PI_BIN = `node ${new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname}`;
  const session = PiRpcSession.start({ cwd: process.cwd(), systemPrompt: "test", tools: "read" });
  let text = "";
  const tools = [];
  await session.prompt("hello", (observation) => {
    if (observation.type === "text") text += observation.delta;
    if (observation.type === "tool") tools.push(observation.summary);
  }, new AbortController().signal);
  const cost = await session.cost(new AbortController().signal);
  await session.close();
  assert.equal(text, "Visible");
  assert.equal(text.includes("hidden"), false);
  assert.equal(tools.some((item) => item.includes("sk-supersecretvalue")), false);
  assert.equal(cost, 0.02);
});
