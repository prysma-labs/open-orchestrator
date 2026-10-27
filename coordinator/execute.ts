import type { AgentDriver } from "@/coordinator/driver";
import type { ClaimResult, Role, Task } from "@/lib/types";
import type { Store } from "@/lib/store";
import { addWorktree, ensureRepo, integrateBranch } from "@/coordinator/worktree";

const LABEL: Record<Role, string> = {
  scout: "Scout",
  implementer: "Implementer",
  reviewer: "Reviewer",
};

function reason(signal: AbortSignal): string {
  return typeof signal.reason === "string" ? signal.reason : signal.aborted ? "aborted" : "";
}

export async function executeClaim(options: {
  store: Store;
  driver: AgentDriver;
  claim: Extract<ClaimResult, { claimed: true }>;
  owner: string;
  signal: AbortSignal;
  workRoot: string;
  allowFailureInjection: boolean;
  abort: (reason: "lost" | "cancel") => void;
}): Promise<"finished" | "abandoned"> {
  const { store, claim, owner, signal } = options;
  let active = true;
  const timer = setInterval(() => {
    void store.heartbeat(owner, claim.runId).then((beat) => {
      if (!active || signal.aborted) return;
      if (!beat.ok) options.abort("lost");
      if (beat.cancelRequested) options.abort("cancel");
    }).catch(() => undefined);
  }, 5000);

  try {
    if (signal.aborted && (reason(signal) === "crash" || reason(signal) === "lost")) return "abandoned";
    let costUsd = 0;
    let tasks = await store.listTasks(claim.runId);
    const snapshot = await store.snapshot(0);
    const history = snapshot.messages
      .slice(-8)
      .map((message) => `${message.role}: ${message.content.slice(0, 400)}`)
      .join("\n");
    let coding = tasks.some((task) => task.role === "implementer");
    if (tasks.length === 0) {
      const plan = await options.driver.plan(claim.content, history, signal);
      coding = plan.coding;
      for (const [index, task] of plan.tasks.entries()) {
        tasks.push(await store.createTask({
          owner,
          runId: claim.runId,
          role: task.role,
          title: task.title,
          instructions: task.instructions,
          sortOrder: index,
        }));
      }
    }

    const repo = await ensureRepo(options.workRoot);
    const runRole = async (role: Role, extra: string) => {
      const task = tasks.find((item) => item.role === role && item.status === "queued");
      if (!task || signal.aborted) return 0;
      const cost = await runTask(options, task, repo, coding, extra);
      tasks = await store.listTasks(claim.runId);
      return cost;
    };

    const parallel: Role[] = coding ? ["scout", "implementer"] : ["scout", "reviewer"];
    costUsd += (await Promise.all(parallel.map((role) => runRole(role, "")))).reduce((sum, cost) => sum + cost, 0);
    if (coding) {
      tasks = await store.listTasks(claim.runId);
      const implementer = tasks.find((task) => task.role === "implementer");
      costUsd += await runRole("reviewer", implementer?.result ?? "");
    }

    if (reason(signal) === "crash" || reason(signal) === "lost") return "abandoned";
    tasks = await store.listTasks(claim.runId);
    let integration = "";
    const implementer = tasks.find((task) => task.role === "implementer" && task.status === "completed" && task.branch);
    if (coding && implementer?.branch) integration = await integrateBranch(repo, implementer.branch);

    const notes = [
      claim.content.trim(),
      ...tasks.map((task) => {
        if (task.result) return `${LABEL[task.role]}: ${task.result}`;
        if (task.status === "failed") return `${LABEL[task.role]} failed. ${task.progressSummary}`;
        if (task.status === "interrupted") return `${LABEL[task.role]} was interrupted and was not retried.`;
        return `${LABEL[task.role]} is ${task.status}.`;
      }),
      integration,
    ].filter(Boolean).join("\n\n");

    let draftCount = 0;
    const draft = await options.driver.synthesize(notes, async (text) => {
      draftCount += 1;
      await store.appendEvent({
        owner,
        runId: claim.runId,
        taskId: null,
        kind: "checkpoint",
        dedupeKey: `checkpoint:${claim.runId}:${draftCount}:${text.length}`,
        payload: { text },
      });
    }, signal);

    if (reason(signal) === "crash" || reason(signal) === "lost") return "abandoned";
    const failed = tasks.some((task) => task.status === "failed");
    const interrupted = tasks.some((task) => task.status === "interrupted") || reason(signal) === "cancel";
    await store.finishRun({
      owner,
      runId: claim.runId,
      status: failed ? "failed" : interrupted ? "interrupted" : "completed",
      content: draft.text || notes,
      costUsd: draft.costUsd + costUsd,
    });
    return "finished";
  } finally {
    active = false;
    clearInterval(timer);
  }
}

async function runTask(
  options: {
    store: Store;
    driver: AgentDriver;
    claim: Extract<ClaimResult, { claimed: true }>;
    owner: string;
    signal: AbortSignal;
    allowFailureInjection: boolean;
  },
  task: Task,
  repo: string,
  coding: boolean,
  extra: string,
): Promise<number> {
  const { store, owner, signal, claim } = options;
  let cwd = repo;
  let branch: string | null = null;
  if (coding) {
    try {
      const tree = await addWorktree(repo, claim.runId, task.role);
      cwd = tree.path;
      branch = tree.branch;
    } catch (error) {
      const message = error instanceof Error ? error.message : "worktree failed";
      await store.setTaskState({
        owner,
        taskId: task.id,
        progress: `Working in the main checkout. ${message}`.slice(0, 400),
      });
    }
  }
  await store.setTaskState({
    owner,
    taskId: task.id,
    status: "running",
    worktree: cwd,
    branch,
    progress: "Started",
  });
  let toolCount = 0;
  try {
    const outcome = await options.driver.runTask({
      role: task.role,
      instructions: task.instructions,
      context: `User request:\n${claim.content}\n\n${extra}`,
      cwd,
      coding,
      runId: claim.runId,
      allowFailureInjection: options.allowFailureInjection,
    }, {
      onProgress: async (summary) => {
        await store.appendEvent({
          owner,
          runId: claim.runId,
          taskId: task.id,
          kind: "progress",
          dedupeKey: `progress:${task.id}:${summary}`,
          payload: { summary },
        });
      },
      onTool: async (tool) => {
        toolCount += 1;
        await store.appendEvent({
          owner,
          runId: claim.runId,
          taskId: task.id,
          kind: "tool",
          dedupeKey: `tool:${task.id}:${tool.name}:${tool.phase}:${toolCount}`,
          payload: tool,
        });
      },
    }, signal);
    if (reason(signal) === "crash" || reason(signal) === "lost") return 0;
    await store.setTaskState({
      owner,
      taskId: task.id,
      status: "completed",
      result: outcome.result,
      progress: "Finished",
    });
    return outcome.costUsd;
  } catch (error) {
    if (reason(signal) === "crash" || reason(signal) === "lost") return 0;
    const message = error instanceof Error ? error.message : "Task failed";
    await store.setTaskState({
      owner,
      taskId: task.id,
      status: reason(signal) === "cancel" ? "interrupted" : "failed",
      progress: message.slice(0, 400),
      result: message.slice(0, 400),
    });
    return 0;
  }
}
