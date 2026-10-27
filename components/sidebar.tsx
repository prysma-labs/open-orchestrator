"use client";

import type { ViewState } from "@/lib/reduce";
import { ROLES } from "@/lib/types";
import { StatusPill } from "@/components/status-pill";

export function Sidebar({
  view,
  mode,
  onCrash,
}: {
  view: ViewState;
  mode: "local" | "supabase";
  onCrash: () => void;
}) {
  const running = view.run?.status === "running";
  const queued = view.requests.filter((item) => item.status === "queued");
  const coordinator = running ? "running" : "idle";

  return (
    <aside className="flex h-full max-h-[80vh] flex-col gap-6 overflow-y-auto border-[var(--line)] bg-[#0c0c0e] p-4 lg:max-h-none lg:border-l" aria-label="Agents">
      <section>
        <h2 className="mb-3 text-xs uppercase tracking-[0.18em] text-[var(--muted)]">Agents</h2>
        <ul className="space-y-2">
          <li className="rounded-xl border border-[var(--line)] px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">Coordinator</span>
              <StatusPill status={coordinator} />
            </div>
            <p className="mt-1 text-sm text-[var(--muted)]">Claims the next request and integrates the workers.</p>
          </li>
          {ROLES.map((agent) => {
            const task = view.tasks.find((item) => item.role === agent.role);
            return (
              <li key={agent.role} className="rounded-xl border border-[var(--line)] px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{agent.label}</span>
                  <StatusPill status={task?.status ?? "idle"} />
                </div>
                <p className="mt-1 text-sm text-[var(--muted)]">{task?.progressSummary || agent.blurb}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-xs uppercase tracking-[0.18em] text-[var(--muted)]">Queue</h2>
        {queued.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing waiting.</p>
        ) : (
          <ol className="space-y-2">
            {queued.map((item, index) => (
              <li key={item.id} className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm">
                <span className="mr-2 text-[var(--amber)]">{index + 1}</span>
                {item.content}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="min-h-0 flex-1 overflow-auto">
        <h2 className="mb-3 text-xs uppercase tracking-[0.18em] text-[var(--muted)]">Tasks</h2>
        {view.tasks.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No tasks in the latest run.</p>
        ) : (
          <div className="space-y-2">
            {view.tasks.map((task) => (
              <details key={task.id} className="rounded-xl border border-[var(--line)] px-3 py-2">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <span className="font-medium capitalize">{task.role}</span>
                  <StatusPill status={task.status} />
                </summary>
                <div className="mt-3 space-y-2 text-sm text-[#d9d4cb]">
                  <p>{task.title}</p>
                  <p className="text-[var(--muted)]">{task.progressSummary || "Waiting to start."}</p>
                  {task.branch ? <p className="font-mono text-xs text-[var(--amber)]">{task.branch}</p> : null}
                  {task.tools.length > 0 ? (
                    <ul className="space-y-1 font-mono text-xs text-[#c7c1b6]">
                      {task.tools.slice(-6).map((tool, index) => (
                        <li key={`${task.id}-${index}`}>{tool.summary}</li>
                      ))}
                    </ul>
                  ) : null}
                  {task.result ? <p className="whitespace-pre-wrap">{task.result}</p> : null}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>

      {mode === "local" && process.env.NODE_ENV === "development" ? (
        <button type="button" onClick={onCrash} className="rounded-full border border-[var(--line)] px-3 py-2 text-left text-sm text-[var(--muted)] hover:text-[var(--ink)]">
          Simulate coordinator restart
        </button>
      ) : null}
    </aside>
  );
}
