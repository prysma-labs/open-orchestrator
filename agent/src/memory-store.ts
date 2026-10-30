import { randomUUID } from "node:crypto";
import type { StoredMessage, StoredRun, Store } from "./types.js";

export class MemoryStore implements Store {
  messages: StoredMessage[] = [];
  runs: StoredRun[] = [];

  async listMessages(agentId: string) {
    return this.messages
      .filter((message) => message.agentId === agentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async latestRun(agentId: string) {
    return (
      this.runs
        .filter((run) => run.agentId === agentId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    );
  }

  async startRun(agentId: string, content: string) {
    if (this.runs.some((run) => run.agentId === agentId && run.status === "running")) {
      return { ok: false as const, busy: true as const };
    }
    const now = new Date().toISOString();
    const runId = randomUUID();
    this.runs.push({
      id: runId,
      agentId,
      status: "running",
      error: null,
      createdAt: now,
      finishedAt: null,
    });
    this.messages.push({
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content,
      createdAt: now,
    });
    return { ok: true as const, runId };
  }

  async completeRun(agentId: string, runId: string, content: string) {
    const run = this.runs.find((item) => item.id === runId && item.status === "running");
    if (!run) return;
    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    this.messages.push({
      id: randomUUID(),
      agentId,
      runId,
      role: "assistant",
      content,
      createdAt: run.finishedAt,
    });
  }

  async failRun(runId: string, error: string) {
    const run = this.runs.find((item) => item.id === runId && item.status === "running");
    if (!run) return;
    run.status = "failed";
    run.error = error;
    run.finishedAt = new Date().toISOString();
  }

  async failInterrupted(agentId: string) {
    const finishedAt = new Date().toISOString();
    for (const run of this.runs) {
      if (run.agentId === agentId && run.status === "running") {
        run.status = "failed";
        run.error = "Run interrupted by service restart.";
        run.finishedAt = finishedAt;
      }
    }
  }
}
