import { mkdir } from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { startCoordinator, type CoordinatorHandle } from "@/coordinator/loop";
import { createSupabaseStore, supabaseConfigured } from "@/coordinator/supabase-store";
import type { AgentEvent } from "@/lib/types";
import { createSqlStore, expireRunningLeases, schemaSql, type Store } from "@/lib/store";

export type HubMessage =
  | { type: "invalidate" }
  | { type: "event"; event: AgentEvent };

type Listener = (message: HubMessage) => void;

export type LocalHub = {
  mode: "local";
  store: Store;
  subscribe: (listener: Listener) => () => void;
  viewerCount: () => number;
  touchViewer: (id: string) => number;
  crash: () => Promise<void>;
};

const viewers = new Map<string, number>();

function publishStore(store: Store, emit: (message: HubMessage) => void): Store {
  return {
    ...store,
    async submit(input) {
      const result = await store.submit(input);
      if (result.ok) emit({ type: "invalidate" });
      return result;
    },
    async appendEvent(input) {
      const result = await store.appendEvent(input);
      if (result.inserted && result.event?.kind === "checkpoint") emit({ type: "event", event: result.event });
      else if (result.inserted) emit({ type: "invalidate" });
      return result;
    },
    async finishRun(input) {
      const result = await store.finishRun(input);
      emit({ type: "invalidate" });
      return result;
    },
    async cancel(requestId) {
      const result = await store.cancel(requestId);
      emit({ type: "invalidate" });
      return result;
    },
    async setTaskState(input) {
      await store.setTaskState(input);
      emit({ type: "invalidate" });
    },
  };
}

export async function createLocalHub(): Promise<LocalHub> {
  const directory = path.join(process.cwd(), ".data", "pglite");
  await mkdir(directory, { recursive: true });
  const db = new PGlite(directory);
  await db.exec(schemaSql());
  const query = async (sql: string, params: unknown[] = []) => {
    const result = await db.query(sql, params);
    return result.rows as Record<string, unknown>[];
  };
  const listeners = new Set<Listener>();
  const emit = (message: HubMessage) => {
    for (const listener of listeners) listener(message);
  };
  const store = publishStore(createSqlStore(query), emit);
  let handle: CoordinatorHandle | null = null;
  const boot = () => {
    handle = startCoordinator({
      store,
      owner: process.env.COORDINATOR_ID || `local-${hostname()}`.slice(0, 120),
      workRoot: path.join(process.cwd(), ".data", "work"),
      allowFailureInjection: process.env.NODE_ENV !== "production",
      pollMs: 400,
    });
  };
  const countViewers = () => {
    const cutoff = Date.now() - 20000;
    for (const [id, seen] of viewers) if (seen < cutoff) viewers.delete(id);
    return viewers.size;
  };
  boot();
  return {
    mode: "local",
    store,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    viewerCount: countViewers,
    touchViewer(id) {
      viewers.set(id, Date.now());
      return countViewers();
    },
    async crash() {
      handle?.crash();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expireRunningLeases(query);
    },
  };
}

const globalHub = globalThis as { __openOrchestrator?: Promise<LocalHub> };

export function getLocalHub(): Promise<LocalHub> {
  if (!globalHub.__openOrchestrator) globalHub.__openOrchestrator = createLocalHub();
  return globalHub.__openOrchestrator;
}

export async function getServerStore(): Promise<Store> {
  if (supabaseConfigured()) {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    return createSupabaseStore(client);
  }
  return (await getLocalHub()).store;
}
