import type { Role } from "@/lib/types";

export type PlannedTask = {
  role: Role;
  title: string;
  instructions: string;
};

export type Plan = {
  coding: boolean;
  tasks: PlannedTask[];
};

const CODING = /\b(implement|code|fix|refactor|bug|component|function|write|add|build|edit|patch)\b/i;
const ROLES = new Set<Role>(["scout", "implementer", "reviewer"]);

export function heuristicPlan(content: string): Plan {
  const coding = CODING.test(content);
  const tasks: PlannedTask[] = [
    {
      role: "scout",
      title: "Survey the request",
      instructions: `Gather only the context required for this request. Do not edit files.\n\n${content}`,
    },
  ];
  if (coding) {
    tasks.push({
      role: "implementer",
      title: "Apply the change",
      instructions: `Make the requested change on your own branch. Leave unrelated files untouched.\n\n${content}`,
    });
  }
  tasks.push({
    role: "reviewer",
    title: coding ? "Review the change" : "Check the answer",
    instructions: `Check the work for mistakes, gaps, and risky side effects.\n\n${content}`,
  });
  return { coding, tasks };
}

export function parsePlan(text: string, fallback: string): Plan {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return heuristicPlan(fallback);
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      coding?: boolean;
      tasks?: { role?: string; title?: string; instructions?: string }[];
    };
    const tasks = (parsed.tasks ?? [])
      .filter((task): task is { role: Role; title?: string; instructions?: string } =>
        ROLES.has(task.role as Role),
      )
      .slice(0, 3)
      .map((task) => ({
        role: task.role,
        title: (task.title || task.role).slice(0, 160),
        instructions: (task.instructions || fallback).slice(0, 4000),
      }));
    const unique = new Map<Role, PlannedTask>();
    for (const task of tasks) unique.set(task.role, task);
    const chosen = [...unique.values()];
    if (!chosen.some((task) => task.role === "scout")) return heuristicPlan(fallback);
    return { coding: Boolean(parsed.coding), tasks: chosen };
  } catch {
    return heuristicPlan(fallback);
  }
}
