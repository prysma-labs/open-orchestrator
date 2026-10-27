"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { applyEvent, applySnapshot, emptyView, type ViewState } from "@/lib/reduce";
import type { AgentEvent, Snapshot } from "@/lib/types";

type StateResponse = Snapshot & { mode: "local" | "supabase"; viewers: number | null };

const ERRORS: Record<string, string> = {
  empty: "Write a message first.",
  too_long: "That message is too long.",
  budget: "The shared model budget is spent.",
  rate_limit: "Too many messages from this network. Wait a minute.",
  queue_full: "The shared queue is full.",
  invalid: "Could not accept that message.",
  invalid_client: "Could not accept that message.",
};

function viewerId() {
  const key = "orchestrator-viewer";
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const next = crypto.randomUUID();
  window.sessionStorage.setItem(key, next);
  return next;
}

export function useSharedWorkspace() {
  const [view, setView] = useState<ViewState>(emptyView);
  const [mode, setMode] = useState<"local" | "supabase">("local");
  const [notice, setNotice] = useState<string | null>(null);
  const loadLock = useRef(0);

  const load = useCallback(async () => {
    const token = ++loadLock.current;
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load the workspace.");
    const body = (await response.json()) as StateResponse;
    if (token !== loadLock.current) return;
    setMode(body.mode);
    setView((current) => ({
      ...applySnapshot(current, body),
      viewers: body.viewers && body.viewers > 0 ? body.viewers : current.viewers,
      connection: "live",
    }));
  }, []);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let channel: RealtimeChannel | null = null;
    let supabase: { removeChannel: (channel: RealtimeChannel) => Promise<unknown> } | null = null;
    let refreshTimer = 0;
    const schedule = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (!closed) void load().catch(() => setView((current) => ({ ...current, connection: "reconnecting" })));
      }, 120);
    };
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    void load().catch(() => setView((current) => ({ ...current, connection: "reconnecting" })));

    if (supabaseUrl && supabaseKey) {
      const supabaseClient = createClient(supabaseUrl, supabaseKey);
      supabase = supabaseClient;
      channel = supabaseClient.channel("workspace:shared", { config: { private: true } });
      channel
        .on("broadcast", { event: "agent_event" }, ({ payload }) => {
          setView((current) => applyEvent(current, payload as AgentEvent));
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, schedule)
        .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, schedule)
        .on("postgres_changes", { event: "*", schema: "public", table: "runs" }, schedule)
        .on("postgres_changes", { event: "*", schema: "public", table: "agent_tasks" }, schedule)
        .on("postgres_changes", { event: "*", schema: "public", table: "events" }, schedule)
        .on("presence", { event: "sync" }, () => {
          const count = Object.keys(channel?.presenceState() ?? {}).length;
          setView((current) => ({ ...current, viewers: Math.max(count, 1) }));
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            void channel?.track({ online_at: new Date().toISOString() });
            setView((current) => ({ ...current, connection: "live" }));
            schedule();
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setView((current) => ({ ...current, connection: "reconnecting" }));
          }
        });
    } else {
      source = new EventSource("/api/stream");
      source.onopen = () => {
        setView((current) => ({ ...current, connection: "live" }));
        schedule();
      };
      source.onerror = () => setView((current) => ({ ...current, connection: "reconnecting" }));
      source.onmessage = (message) => {
        const body = JSON.parse(message.data) as { type: string; event?: AgentEvent };
        if (body.type === "event" && body.event) setView((current) => applyEvent(current, body.event as AgentEvent));
        else schedule();
      };
      const id = viewerId();
      const beat = window.setInterval(() => {
        void fetch("/api/presence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ viewerId: id }),
        }).then(async (response) => {
          const body = (await response.json()) as { viewers?: number };
          if (typeof body.viewers === "number") setView((current) => ({ ...current, viewers: body.viewers as number }));
        }).catch(() => undefined);
      }, 8000);
      void fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewerId: id }),
      });
      return () => {
        closed = true;
        window.clearInterval(beat);
        window.clearTimeout(refreshTimer);
        source?.close();
      };
    }

    return () => {
      closed = true;
      window.clearTimeout(refreshTimer);
      if (channel && supabase) void supabase.removeChannel(channel);
    };
  }, [load]);

  const submit = useCallback(async (content: string) => {
    setNotice(null);
    const clientKey = crypto.randomUUID();
    const payload = JSON.stringify({ content, clientKey });
    let response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    if (response.status >= 500) {
      response = await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
    }
    const body = (await response.json()) as { ok: boolean; error?: string };
    if (!body.ok) {
      const message = ERRORS[body.error ?? ""] ?? "Could not send.";
      setNotice(message);
      throw new Error(message);
    }
    await load();
  }, [load]);

  const cancel = useCallback(async (requestId: number) => {
    await fetch("/api/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId }),
    });
    await load();
  }, [load]);

  const crash = useCallback(async () => {
    await fetch("/api/dev/crash", { method: "POST" });
    window.setTimeout(() => void load(), 600);
  }, [load]);

  return { view, mode, notice, submit, cancel, crash };
}
