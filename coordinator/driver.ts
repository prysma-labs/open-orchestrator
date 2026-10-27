import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plan } from "@/coordinator/plan";
import { heuristicPlan, parsePlan } from "@/coordinator/plan";
import { PiRpcSession } from "@/coordinator/pi-session";
import { commitAll } from "@/coordinator/worktree";

export type ToolNote = {
  name: string;
  phase: "start" | "end";
  summary: string;
  sideEffect: boolean;
};

export type TaskHooks = {
  onProgress: (summary: string) => Promise<void>;
  onTool: (tool: ToolNote) => Promise<void>;
};

export type TaskRequest = {
  role: string;
  instructions: string;
  context: string;
  cwd: string;
  coding: boolean;
  runId: number;
  allowFailureInjection: boolean;
};

export interface AgentDriver {
  plan(content: string, history: string, signal: AbortSignal): Promise<Plan>;
  runTask(request: TaskRequest, hooks: TaskHooks, signal: AbortSignal): Promise<{ result: string; costUsd: number }>;
  synthesize(
    notes: string,
    onDraft: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<{ text: string; costUsd: number }>;
}

const PROMPTS: Record<string, string> = {
  scout: "You are the scout. Use read-only tools. Return a short briefing of facts the coordinator needs. Do not include hidden reasoning and do not edit files.",
  implementer: "You are the implementer. Change only what the task asks for, on this checkout. Finish with the files you changed.",
  reviewer: "You are the reviewer. Use read-only tools. Return concrete findings and risks. Do not edit files.",
  plan: "You plan work for scout, implementer, and reviewer. Reply with JSON only: {\"coding\":boolean,\"tasks\":[{\"role\":\"scout|implementer|reviewer\",\"title\":string,\"instructions\":string}]}. At most three tasks. Always include scout.",
  synthesize: "You write the final answer for a shared chat. Use the worker notes. Be concise. Do not include hidden reasoning or credentials.",
};

const TOOLS: Record<string, string> = {
  scout: "read,grep,find,ls",
  implementer: "read,grep,find,ls,bash,edit,write",
  reviewer: "read,grep,find,ls",
  plan: "read,grep,find,ls",
  synthesize: "read,grep,find,ls",
};

function aborted(signal: AbortSignal): Error {
  return new Error(typeof signal.reason === "string" ? signal.reason : "aborted");
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw aborted(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(aborted(signal));
      },
      { once: true },
    );
  });
}

export function createSimulatedDriver(stepMs: number): AgentDriver {
  return {
    async plan(content) {
      return heuristicPlan(content);
    },
    async runTask(request, hooks, signal) {
      const source = `${request.instructions}\n${request.context}`;
      const failHere = request.allowFailureInjection && source.includes(`[[fail:${request.role}]]`);
      const failAfterWrite = request.allowFailureInjection && source.includes("[[fail:side-effect]]") && request.role === "implementer";
      await hooks.onProgress(`Reading the request as ${request.role}.`);
      await pause(stepMs, signal);
      await hooks.onTool({ name: "read", phase: "start", summary: "read README.md", sideEffect: false });
      await hooks.onTool({ name: "read", phase: "end", summary: "read README.md", sideEffect: false });
      if (failHere) throw new Error(`${request.role} stopped before making changes`);
      if (request.role === "implementer" && request.coding) {
        await hooks.onTool({
          name: "write",
          phase: "start",
          summary: `write notes/run-${request.runId}.txt`,
          sideEffect: true,
        });
        await mkdir(path.join(request.cwd, "notes"), { recursive: true });
        await writeFile(
          path.join(request.cwd, "notes", `run-${request.runId}.txt`),
          `${request.instructions.slice(0, 500)}\n`,
        );
        await commitAll(request.cwd, `Run ${request.runId} implementer notes`);
        await hooks.onTool({
          name: "write",
          phase: "end",
          summary: `write notes/run-${request.runId}.txt`,
          sideEffect: true,
        });
        if (failAfterWrite) throw new Error("implementer failed after writing");
        return { result: `Wrote notes/run-${request.runId}.txt on this branch.`, costUsd: 0.001 };
      }
      await pause(stepMs, signal);
      const result = request.role === "reviewer"
        ? "No blocking issues in the visible work."
        : "The request is clear enough to answer from the shared workspace.";
      return { result, costUsd: 0.001 };
    },
    async synthesize(notes, onDraft, signal) {
      const text = notes.trim();
      const midpoint = Math.max(1, Math.ceil(text.length / 2));
      await onDraft(text.slice(0, midpoint));
      await pause(stepMs, signal);
      await onDraft(text);
      return { text, costUsd: 0.001 };
    },
  };
}

async function withSession<T>(
  options: { cwd: string; role: string },
  signal: AbortSignal,
  body: (session: PiRpcSession) => Promise<T>,
): Promise<T> {
  const session = PiRpcSession.start({
    cwd: options.cwd,
    systemPrompt: PROMPTS[options.role] ?? PROMPTS.scout,
    tools: TOOLS[options.role] ?? TOOLS.scout,
  });
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}

export function createRpcDriver(): AgentDriver {
  return {
    async plan(content, history, signal) {
      return withSession({ cwd: process.cwd(), role: "plan" }, signal, async (session) => {
        let text = "";
        await session.prompt(
          `History:\n${history}\n\nRequest:\n${content}`,
          (observation) => {
            if (observation.type === "text") text += observation.delta;
          },
          signal,
        );
        return parsePlan(text, content);
      });
    },
    async runTask(request, hooks, signal) {
      return withSession({ cwd: request.cwd, role: request.role }, signal, async (session) => {
        let text = "";
        await session.prompt(`${request.instructions}\n\nContext:\n${request.context}`, (observation) => {
          if (observation.type === "text") {
            text += observation.delta;
            const line = text.trim().split("\n").at(-1) ?? "";
            if (line) void hooks.onProgress(line.slice(0, 240));
          }
          if (observation.type === "tool") void hooks.onTool(observation);
        }, signal);
        const costUsd = await session.cost(signal);
        return { result: text.trim().slice(0, 8000) || "No visible output.", costUsd };
      });
    },
    async synthesize(notes, onDraft, signal) {
      return withSession({ cwd: process.cwd(), role: "synthesize" }, signal, async (session) => {
        let text = "";
        await session.prompt(notes, async (observation) => {
          if (observation.type === "text") {
            text += observation.delta;
            await onDraft(text);
          }
        }, signal);
        return { text: text.trim(), costUsd: await session.cost(signal) };
      });
    },
  };
}
