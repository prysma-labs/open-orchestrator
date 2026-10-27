import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { createSqlStore, expireRunningLeases, schemaSql, type QueryFn } from "../lib/store.ts";

async function database() {
  const db = new PGlite();
  await db.exec(schemaSql());
  const query: QueryFn = async (sql, params = []) => {
    const result = await db.query(sql, params);
    return result.rows as Record<string, unknown>[];
  };
  return { db, query, store: createSqlStore(query) };
}

const ip = "a".repeat(32);

test("duplicate submissions return the original request", async () => {
  const { store } = await database();
  const key = crypto.randomUUID();
  const first = await store.submit({ clientKey: key, content: "hello", ipHash: ip });
  const second = await store.submit({ clientKey: key, content: "hello again", ipHash: ip });
  assert.equal(first.ok && second.ok && first.requestId === second.requestId, true);
  assert.equal(second.ok && second.duplicate, true);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.requests.filter((item) => item.status === "queued").length, 1);
});

test("only one coordinator can own the running request", async () => {
  const { store } = await database();
  await store.submit({ clientKey: crypto.randomUUID(), content: "first", ipHash: ip });
  await store.submit({ clientKey: crypto.randomUUID(), content: "second", ipHash: ip });
  const first = await store.claim("owner-a");
  const second = await store.claim("owner-b");
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  if (second.claimed) return;
  assert.equal(second.reason, "busy");
  const snapshot = await store.snapshot();
  const queued = snapshot.requests.filter((item) => item.status === "queued");
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.content, "second");
});

test("a second finish from the same owner does not add another answer", async () => {
  const { store } = await database();
  await store.submit({ clientKey: crypto.randomUUID(), content: "first", ipHash: ip });
  const claim = await store.claim("owner-a");
  assert.equal(claim.claimed, true);
  if (!claim.claimed) return;
  const done = await store.finishRun({
    owner: "owner-a",
    runId: claim.runId,
    status: "completed",
    content: "answer",
    costUsd: 0.01,
  });
  const again = await store.finishRun({
    owner: "owner-a",
    runId: claim.runId,
    status: "completed",
    content: "answer again",
    costUsd: 0.01,
  });
  assert.equal(done.ok, true);
  assert.equal(again.ok, false);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(snapshot.budget.spentUsd, 0.01);
});

test("expired work without side effects is resumed, not duplicated", async () => {
  const { query, store } = await database();
  await store.submit({ clientKey: crypto.randomUUID(), content: "keep going", ipHash: ip });
  const claim = await store.claim("owner-a");
  assert.equal(claim.claimed, true);
  if (!claim.claimed) return;
  const task = await store.createTask({
    owner: "owner-a",
    runId: claim.runId,
    role: "scout",
    title: "Look",
    instructions: "Look around",
    sortOrder: 0,
  });
  await store.setTaskState({ owner: "owner-a", taskId: task.id, status: "running" });
  await expireRunningLeases(query);
  const resumed = await store.claim("owner-b");
  assert.equal(resumed.claimed && resumed.resumed && resumed.runId === claim.runId, true);
  const tasks = await store.listTasks(claim.runId);
  assert.equal(tasks[0]?.status, "queued");
  const busy = await store.claim("owner-c");
  assert.equal(busy.claimed, false);
});

test("side effects are not retried after the coordinator lease expires", async () => {
  const { query, store } = await database();
  await store.submit({ clientKey: crypto.randomUUID(), content: "edit the repo", ipHash: ip });
  const claim = await store.claim("owner-a");
  if (!claim.claimed) throw new Error("expected claim");
  const task = await store.createTask({
    owner: "owner-a",
    runId: claim.runId,
    role: "implementer",
    title: "Edit",
    instructions: "Edit",
    sortOrder: 0,
  });
  await store.setTaskState({ owner: "owner-a", taskId: task.id, status: "running" });
  const event = await store.appendEvent({
    owner: "owner-a",
    runId: claim.runId,
    taskId: task.id,
    kind: "tool",
    dedupeKey: "tool-1",
    payload: { tool: "write", phase: "start", summary: "write notes.txt", sideEffect: true },
  });
  const duplicate = await store.appendEvent({
    owner: "owner-a",
    runId: claim.runId,
    taskId: task.id,
    kind: "tool",
    dedupeKey: "tool-1",
    payload: { tool: "write", phase: "start", summary: "write notes.txt", sideEffect: true },
  });
  assert.equal(event.inserted, true);
  assert.equal(duplicate.inserted, false);
  await expireRunningLeases(query);
  const resumed = await store.claim("owner-b");
  assert.equal(resumed.claimed && resumed.resumed, true);
  const tasks = await store.listTasks(claim.runId);
  assert.equal(tasks[0]?.status, "interrupted");
  assert.equal(tasks[0]?.sideEffects, true);
  assert.equal(tasks[0]?.toolCount ?? tasks[0]?.tools.length, 1);
});

test("repeated crashes before progress fail the request instead of looping", async () => {
  const { query, store } = await database();
  await store.submit({ clientKey: crypto.randomUUID(), content: "unstable", ipHash: ip });
  const first = await store.claim("owner-a");
  if (!first.claimed) throw new Error("expected claim");
  await expireRunningLeases(query);
  const second = await store.claim("owner-b");
  assert.equal(second.claimed && second.resumed, true);
  await expireRunningLeases(query);
  const third = await store.claim("owner-c");
  assert.equal(third.claimed && third.resumed, true);
  await expireRunningLeases(query);
  const fourth = await store.claim("owner-d");
  assert.equal(fourth.claimed, false);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.requests.some((item) => item.status === "running" || item.status === "queued"), false);
  assert.equal(snapshot.messages.some((message) => message.role === "assistant"), true);
});

test("rate, queue, size, and budget limits reject new work", async () => {
  const { query, store } = await database();
  await query("update public.workspace set rate_limit_per_minute = 1, max_queue = 1, max_message_chars = 5");
  const empty = await store.submit({ clientKey: crypto.randomUUID(), content: "   ", ipHash: ip });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error, "empty");
  const long = await store.submit({ clientKey: crypto.randomUUID(), content: "too long", ipHash: ip });
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.error, "too_long");
  const first = await store.submit({ clientKey: crypto.randomUUID(), content: "ok", ipHash: ip });
  assert.equal(first.ok, true);
  const queued = await store.submit({ clientKey: crypto.randomUUID(), content: "next", ipHash: ip });
  assert.equal(queued.ok, false);
  if (!queued.ok) assert.equal(queued.error, "rate_limit");
  await query("update public.workspace set rate_limit_per_minute = 10");
  const full = await store.submit({ clientKey: crypto.randomUUID(), content: "next", ipHash: "c".repeat(32) });
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.error, "queue_full");
  await query("update public.workspace set max_queue = 10, budget_spent_usd = 5");
  const budget = await store.submit({ clientKey: crypto.randomUUID(), content: "more", ipHash: "d".repeat(32) });
  assert.equal(budget.ok, false);
  if (!budget.ok) assert.equal(budget.error, "budget");
});

test("anonymous visitors can read and cannot write or forge events", async () => {
  const { db, store } = await database();
  await store.submit({ clientKey: crypto.randomUUID(), content: "public", ipHash: ip });
  await db.query("begin");
  await db.query("set local role anon");
  const visible = await db.query<{ count: string }>("select count(*)::int as count from public.messages");
  assert.equal(Number(visible.rows[0]?.count), 1);
  await assert.rejects(db.query("insert into public.events (kind, dedupe_key, payload) values ('tool', 'forged', '{}'::jsonb)"));
  await assert.rejects(db.query("select public.claim_next_request('anon-owner', 20)"));
  await db.query("rollback");
});

test("checkpoints survive a fresh snapshot", async () => {
  const { store } = await database();
  await store.submit({ clientKey: crypto.randomUUID(), content: "stream", ipHash: ip });
  const claim = await store.claim("owner-a");
  if (!claim.claimed) throw new Error("expected claim");
  await store.appendEvent({
    owner: "owner-a",
    runId: claim.runId,
    taskId: null,
    kind: "checkpoint",
    dedupeKey: "draft-1",
    payload: { text: "partial answer" },
  });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.run?.draftText, "partial answer");
  assert.ok((snapshot.run?.draftSeq ?? 0) > 0);
});
