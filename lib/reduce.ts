import type { AgentEvent, Snapshot, Task } from "@/lib/types";

export type ViewState = {
  budget: Snapshot["budget"];
  messages: Snapshot["messages"];
  requests: Snapshot["requests"];
  run: Snapshot["run"];
  tasks: Task[];
  events: AgentEvent[];
  lastSeq: number;
  seen: Set<number>;
  viewers: number;
  connection: "connecting" | "live" | "reconnecting";
};

export function emptyView(): ViewState {
  return {
    budget: { spentUsd: 0, limitUsd: 5 },
    messages: [],
    requests: [],
    run: null,
    tasks: [],
    events: [],
    lastSeq: 0,
    seen: new Set(),
    viewers: 1,
    connection: "connecting",
  };
}

function sorted(events: AgentEvent[]): AgentEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq || a.id - b.id);
}

export function applySnapshot(prev: ViewState, snapshot: Snapshot): ViewState {
  const known = new Set(snapshot.events.map((event) => event.id));
  const extra = prev.events.filter((event) => event.seq > snapshot.lastSeq && !known.has(event.id));
  const events = sorted([...snapshot.events, ...extra]);
  const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), snapshot.lastSeq);
  let run = snapshot.run;
  if (
    run &&
    prev.run &&
    prev.run.id === run.id &&
    prev.run.draftSeq > run.draftSeq
  ) {
    run = { ...run, draftText: prev.run.draftText, draftSeq: prev.run.draftSeq };
  }
  return {
    budget: snapshot.budget,
    messages: snapshot.messages,
    requests: snapshot.requests,
    run,
    tasks: snapshot.tasks,
    events,
    lastSeq,
    seen: new Set(events.map((event) => event.id)),
    viewers: prev.viewers,
    connection: prev.connection,
  };
}

export function applyEvent(prev: ViewState, event: AgentEvent): ViewState {
  if (prev.seen.has(event.id)) return prev;
  const events = sorted([...prev.events, event]);
  const seen = new Set(prev.seen);
  seen.add(event.id);
  let run = prev.run;
  let tasks = prev.tasks;

  if (event.kind === "checkpoint" && run && event.runId === run.id && event.seq >= run.draftSeq) {
    run = {
      ...run,
      draftText: String(event.payload.text ?? ""),
      draftSeq: event.seq,
    };
  }

  if (event.kind === "tool" && event.taskId != null) {
    tasks = tasks.map((task) => {
      if (task.id !== event.taskId) return task;
      const tool = {
        tool: String(event.payload.tool ?? ""),
        phase: event.payload.phase === "end" ? "end" as const : "start" as const,
        summary: String(event.payload.summary ?? ""),
        sideEffect: Boolean(event.payload.sideEffect),
      };
      return {
        ...task,
        tools: [...task.tools, tool].slice(-40),
        progressSummary: tool.summary || task.progressSummary,
        sideEffects: task.sideEffects || tool.sideEffect,
      };
    });
  }

  if (event.kind === "progress" && event.taskId != null) {
    const summary = String(event.payload.summary ?? "");
    tasks = tasks.map((task) =>
      task.id === event.taskId ? { ...task, progressSummary: summary } : task,
    );
  }

  return {
    ...prev,
    run,
    tasks,
    events,
    seen,
    lastSeq: Math.max(prev.lastSeq, event.seq),
  };
}
