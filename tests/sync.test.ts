import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, applySnapshot, emptyView } from "../lib/reduce.ts";
import type { AgentEvent, Snapshot } from "../lib/types.ts";

function event(seq: number, id = seq, text = `draft ${seq}`): AgentEvent {
  return {
    id,
    seq,
    runId: 1,
    taskId: null,
    requestId: 1,
    kind: "checkpoint",
    dedupeKey: `checkpoint-${id}`,
    payload: { text },
    createdAt: "2026-10-27T00:00:00.000Z",
  };
}

const base = (): Snapshot => ({
  budget: { spentUsd: 0, limitUsd: 5 },
  lastSeq: 1,
  messages: [{
    id: 1,
    seq: 1,
    requestId: 1,
    role: "user",
    content: "hello",
    status: "complete",
    createdAt: "2026-10-27T00:00:00.000Z",
  }],
  requests: [],
  run: {
    id: 1,
    requestId: 1,
    status: "running",
    draftText: "",
    draftSeq: 0,
    summary: null,
    costUsd: 0,
    startedAt: "2026-10-27T00:00:00.000Z",
    finishedAt: null,
  },
  tasks: [],
  events: [event(2, 2, "first")],
});

test("duplicate and out-of-order events stay ordered", () => {
  let view = applySnapshot(emptyView(), { ...base(), events: [], lastSeq: 1 });
  view = applyEvent(view, event(3, 3, "third"));
  view = applyEvent(view, event(2, 2, "second"));
  view = applyEvent(view, event(3, 3, "third again"));
  assert.deepEqual(view.events.map((item) => item.seq), [2, 3]);
  assert.equal(view.run?.draftText, "third");
  assert.equal(view.lastSeq, 3);
});

test("a snapshot catch-up keeps newer live events and the newer draft", () => {
  let view = applySnapshot(emptyView(), base());
  view = applyEvent(view, event(4, 4, "live"));
  const caughtUp = applySnapshot(view, base());
  assert.equal(caughtUp.run?.draftText, "live");
  assert.equal(caughtUp.events.some((item) => item.id === 4), true);
  assert.equal(caughtUp.messages.length, 1);
  const again = applyEvent(caughtUp, event(2, 2, "second"));
  assert.equal(again, caughtUp);
});
