import { clip } from "@/lib/redact";

export type PiRecord = {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: { disposition?: string; cost?: number };
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  aborted?: boolean;
};

export type PiObservation =
  | { type: "text"; delta: string }
  | { type: "tool"; phase: "start" | "end"; name: string; summary: string; sideEffect: boolean }
  | { type: "settled"; aborted: boolean };

const SIDE_EFFECTS = new Set(["bash", "write", "edit"]);

export function toolSummary(name: string, args: unknown): { summary: string; sideEffect: boolean } {
  let detail = "";
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    detail = String(record.command ?? record.path ?? record.filePath ?? record.file_path ?? "");
  }
  return {
    summary: clip(`${name}${detail ? ` ${detail}` : ""}`),
    sideEffect: SIDE_EFFECTS.has(name),
  };
}

export function interpretPiRecord(record: PiRecord): PiObservation | null {
  if (record.type === "agent_settled") {
    return { type: "settled", aborted: Boolean(record.aborted) };
  }
  if (record.type === "message_update") {
    const event = record.assistantMessageEvent;
    if (event?.type === "text_delta" && event.delta) return { type: "text", delta: event.delta };
    return null;
  }
  if (record.type === "tool_execution_start" || record.type === "tool_execution_end") {
    const name = record.toolName || "tool";
    const summary = toolSummary(name, record.args);
    return {
      type: "tool",
      phase: record.type === "tool_execution_start" ? "start" : "end",
      name,
      summary: summary.summary,
      sideEffect: summary.sideEffect,
    };
  }
  return null;
}

export function createLineBuffer(onLine: (line: string) => void) {
  let pending = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const line = pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      pending = pending.subarray(newline + 1);
      if (line) onLine(line);
    }
  };
}
