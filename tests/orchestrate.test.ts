import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { executeClaim } from "../coordinator/execute.ts";
import { heuristicPlan } from "../coordinator/plan.ts";
import { createSimulatedDriver, type AgentDriver, type TaskHooks, type TaskRequest } from "../coordinator/driver.ts";
import { createSqlStore, expireRunningLeases, schemaSql, type QueryFn } from "../lib/store.ts";

async function workspace() {
  const db = new PGlite();
  await db.exec(schemaSql());
  const query: QueryFn = async (sql, params = []) => {
    const result = await db.query(sql, params);
    return result.rows as Record<string, unknown>[];
  };
  const root = path.join(process.cwd(), ".data", "tests", crypto.randomUUID());
  await mkdir(root, { recursive: true });
  return { query, store: createSqlStore(query), root };
}

const ip = "e".repeat(32);

test("queued requests stay ordered while one run is active", async () => {
  const { store, root } = await workspace();
  await store.submit({ clientKey: crypto.randomUUID(), content: "What is shared?", ipHash: ip });
  await store.submit({ clientKey: crypto.randomUUID(), content: "Please implement a note", ipHash: ip });
  const driver = createSimulatedDriver(0);
  const first = await store.claim("owner-a");
  if (!first.claimed) throw new Error("expected claim");
  const controller = new AbortController();
  await executeClaim({
    store,
    driver,
    claim: first,
    owner: "owner-a",
    signal: controller.signal,
    workRoot: root,
    allowFailureInjection: true,
    abort: (reason) => controller.abort(reason),
  });
  let snapshot = await store.snapshot();
  assert.equal(snapshot.messages.some((message) => message.role === "assistant"), true);
  assert.equal(snapshot.requests.some((item) => item.content.startsWith("Please implement") && item.status === "queued"), true);
  const second = await store.claim("owner-a");
  if (!second.claimed) throw new Error("expected second claim");
  assert.match(second.content, /implement/);
  await executeClaim({
    store,
    driver,
    claim: second,
    owner: "owner-a",
    signal: new AbortController().signal,
    workRoot: root,
    allowFailureInjection: true,
    abort: () => undefined,
  });
  snapshot = await store.snapshot();
  assert.equal(snapshot.requests.some((item) => item.status === "queued" || item.status === "running"), false);
  assert.equal(snapshot.messages.filter((message) => message.role === "assistant").length, 2);
});

test("a crash after a side effect does not run that worker again", async () => {
  const { query, store, root } = await workspace();
  await store.submit({ clientKey: crypto.randomUUID(), content: "Please implement the notes", ipHash: ip });
  const claim = await store.claim("owner-a");
  if (!claim.claimed) throw new Error("expected claim");
  const calls: string[] = [];
  const hang = createHangDriver(calls);
  const controller = new AbortController();
  const abandoned = executeClaim({
    store,
    driver: hang,
    claim,
    owner: "owner-a",
    signal: controller.signal,
    workRoot: root,
    allowFailureInjection: false,
    abort: (reason) => controller.abort(reason),
  });
  await waitFor(async () => {
    const tasks = await store.listTasks(claim.runId);
    return Boolean(tasks.find((task) => task.role === "implementer" && task.sideEffects));
  });
  controller.abort("crash");
  await abandoned;
  await expireRunningLeases(query);
  const resumed = await store.claim("owner-b");
  assert.equal(resumed.claimed && resumed.resumed, true);
  if (!resumed.claimed) return;
  calls.length = 0;
  await executeClaim({
    store,
    driver: hang,
    claim: resumed,
    owner: "owner-b",
    signal: new AbortController().signal,
    workRoot: path.join(root, "resume"),
    allowFailureInjection: false,
    abort: () => undefined,
  });
  assert.equal(calls.includes("implementer"), false);
  const tasks = await store.listTasks(resumed.runId);
  assert.equal(tasks.find((task) => task.role === "implementer")?.status, "interrupted");
});

function createHangDriver(calls: string[]): AgentDriver {
  return {
    plan: async (content) => heuristicPlan(content),
    async runTask(request: TaskRequest, hooks: TaskHooks, signal: AbortSignal) {
      calls.push(request.role);
      if (request.role === "implementer") {
        await hooks.onTool({ name: "write", phase: "start", summary: "write notes.txt", sideEffect: true });
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return { result: `${request.role} finished`, costUsd: 0 };
    },
    async synthesize(notes) {
      return { text: notes, costUsd: 0 };
    },
  };
}

async function waitFor(ready: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the worker");
}

test("an injected worker failure is stored and not retried", async () => {
  const { store, root } = await workspace();
  await store.submit({
    clientKey: crypto.randomUUID(),
    content: "Please implement the change [[fail:implementer]]",
    ipHash: ip,
  });
  const claim = await store.claim("owner-a");
  if (!claim.claimed) throw new Error("expected claim");
  await executeClaim({
    store,
    driver: createSimulatedDriver(0),
    claim,
    owner: "owner-a",
    signal: new AbortController().signal,
    workRoot: root,
    allowFailureInjection: true,
    abort: () => undefined,
  });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.run?.status, "failed");
  assert.equal(snapshot.tasks.find((task) => task.role === "implementer")?.status, "failed");
  assert.equal(snapshot.messages.some((message) => message.role === "assistant"), true);
});
