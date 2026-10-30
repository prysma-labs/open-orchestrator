export type Role = "user" | "assistant";

export type HistoryMessage = {
  role: Role;
  content: string;
};

export type StoredMessage = HistoryMessage & {
  id: string;
  agentId: string;
  runId: string | null;
  createdAt: string;
};

export type RunStatus = "running" | "completed" | "failed";

export type StoredRun = {
  id: string;
  agentId: string;
  status: RunStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type Store = {
  listMessages(agentId: string): Promise<StoredMessage[]>;
  latestRun(agentId: string): Promise<StoredRun | null>;
  startRun(
    agentId: string,
    content: string,
  ): Promise<{ ok: true; runId: string } | { ok: false; busy: true }>;
  completeRun(agentId: string, runId: string, content: string): Promise<void>;
  failRun(runId: string, error: string): Promise<void>;
  failInterrupted(agentId: string): Promise<void>;
};

export type RunInput = {
  systemPrompt: string;
  history: HistoryMessage[];
  content: string;
};

export type Runner = (input: RunInput) => Promise<string>;
