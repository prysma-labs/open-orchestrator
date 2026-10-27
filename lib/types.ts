export type Role = "scout" | "implementer" | "reviewer";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

export type RequestStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type RunStatus = "running" | "completed" | "failed" | "interrupted";

export type Message = {
  id: number;
  seq: number;
  requestId: number | null;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "failed" | "streaming";
  createdAt: string;
};

export type QueueItem = {
  id: number;
  content: string;
  status: RequestStatus;
  runId: number | null;
  attempt: number;
  cancelRequested: boolean;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type Run = {
  id: number;
  requestId: number;
  status: RunStatus;
  draftText: string;
  draftSeq: number;
  summary: string | null;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
};

export type ToolEvent = {
  tool?: string;
  phase?: "start" | "end";
  summary?: string;
  sideEffect?: boolean;
};

export type Task = {
  id: number;
  runId: number;
  role: Role;
  title: string;
  instructions: string;
  status: TaskStatus;
  progressSummary: string;
  result: string | null;
  tools: ToolEvent[];
  toolCount?: number;
  sideEffects: boolean;
  worktreePath: string | null;
  branch: string | null;
  sortOrder: number;
  updatedAt?: string;
};

export type AgentEvent = {
  id: number;
  seq: number;
  runId: number | null;
  taskId: number | null;
  requestId: number | null;
  kind: "progress" | "tool" | "status" | "checkpoint" | "result" | "error";
  dedupeKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type Snapshot = {
  budget: { spentUsd: number; limitUsd: number };
  lastSeq: number;
  messages: Message[];
  requests: QueueItem[];
  run: Run | null;
  tasks: Task[];
  events: AgentEvent[];
};

export type SubmitResult =
  | {
      ok: true;
      duplicate: boolean;
      requestId: number;
      messageId: number;
      status: string;
    }
  | {
      ok: false;
      error: "empty" | "too_long" | "budget" | "rate_limit" | "queue_full" | "invalid_client";
      limit?: number;
    };

export type ClaimResult =
  | { claimed: false; reason: "idle" | "busy" | "budget" | "invalid_owner" | "invalid_lease" }
  | {
      claimed: true;
      resumed: boolean;
      requestId: number;
      runId: number;
      messageId: number;
      content: string;
      cancelRequested: boolean;
    };

export const ROLES: { role: Role; label: string; blurb: string }[] = [
  { role: "scout", label: "Scout", blurb: "Reads the workspace and gathers context." },
  { role: "implementer", label: "Implementer", blurb: "Makes the change on its own branch." },
  { role: "reviewer", label: "Reviewer", blurb: "Checks the result before it is integrated." },
];
