"use client";

import { useMemo } from "react";
import { Sidebar } from "@/components/sidebar";
import { SharedThread } from "@/components/shared-thread";
import { useSharedWorkspace } from "@/components/use-workspace";
import type { Message } from "@/lib/types";

export function Workspace() {
  const { view, mode, notice, submit, cancel, crash } = useSharedWorkspace();
  const runningRequest = view.requests.find((item) => item.status === "running");
  const messages = useMemo(() => {
    const list: Message[] = [...view.messages];
    if (view.run?.status === "running") {
      list.push({
        id: -view.run.id,
        seq: view.run.draftSeq || Number.MAX_SAFE_INTEGER,
        requestId: view.run.requestId,
        role: "assistant",
        content: view.run.draftText || "Working…",
        status: "streaming",
        createdAt: view.run.startedAt,
      });
    }
    return list;
  }, [view.messages, view.run]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        <div>
          <p className="text-sm uppercase tracking-[0.22em] text-[var(--amber)]">Open Orchestrator</p>
          <h1 className="text-lg font-medium">Shared workspace</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 text-sm text-[var(--muted)]">
          <span>{Math.max(view.viewers, 1)} viewing</span>
          <span>${Number(view.budget.spentUsd).toFixed(2)} / ${Number(view.budget.limitUsd).toFixed(0)}</span>
          <span className="inline-flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${view.connection === "live" ? "bg-emerald-300" : "bg-[var(--amber)]"}`} />
            {view.connection}
          </span>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        <main className="flex min-h-0 flex-col">
          <SharedThread
            messages={messages}
            running={Boolean(runningRequest)}
            notice={notice}
            onSubmit={submit}
            onCancel={() => {
              if (runningRequest) void cancel(runningRequest.id);
            }}
          />
        </main>
        <Sidebar view={view} mode={mode} onCrash={() => void crash()} />
      </div>
    </div>
  );
}
