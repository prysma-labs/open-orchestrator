#!/usr/bin/env node
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "prompt") {
    write({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    write({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hidden chain" } });
    process.stdout.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Vis');
    process.stdout.write('ible"}}\n');
    write({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "echo API_KEY=sk-supersecretvalue" },
    });
    write({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", args: { command: "echo API_KEY=sk-supersecretvalue" }, isError: false });
    write({ type: "agent_settled", aborted: false });
    return;
  }
  if (command.type === "get_session_stats") {
    write({ id: command.id, type: "response", command: "get_session_stats", success: true, data: { cost: 0.02 } });
    return;
  }
  if (command.type === "abort") {
    write({ id: command.id, type: "response", command: "abort", success: true });
  }
});
