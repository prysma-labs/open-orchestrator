export type Role = "user" | "assistant";

export type HistoryMessage = {
  role: Role;
  content: string;
};

export type ChatMessage = HistoryMessage & {
  id: string;
  createdAt: string;
};

export type LatestRun = {
  id: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  createdAt: string;
};
