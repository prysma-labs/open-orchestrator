import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { MemoryStore } from "./memory-store.js";
import { promptFor } from "./prompts.js";
import { createAgentServer } from "./server.js";
import type { HistoryMessage, RunInput } from "./types.js";

const secret = "test-secret";

function deferred() {
  let resolve: (value: string) => void = () => undefined;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function listen(agentId: string, store: MemoryStore, run: (input: RunInput) => Promise<string>) {
  const server = createAgentServer({ agentId, secret, store, run });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function post(url: string, body: unknown, token = secret) {
  return fetch(`${url}/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("routes each agent to its own service and keeps histories apart", async () => {
  const store = new MemoryStore();
  const seen: Record<string, RunInput[]> = { quant: [], onchain: [] };
  const gates = { quant: deferred(), onchain: deferred() };

  const quant = await listen("quant", store, async (input) => {
    seen.quant.push(input);
    return gates.quant.promise;
  });
  const onchain = await listen("onchain", store, async (input) => {
    seen.onchain.push(input);
    return gates.onchain.promise;
  });

  try {
    const quantHealth = await fetch(`${quant.url}/health`).then((response) => response.json());
    const onchainHealth = await fetch(`${onchain.url}/health`).then((response) => response.json());
    assert.deepEqual(quantHealth, { ok: true, agentId: "quant" });
    assert.deepEqual(onchainHealth, { ok: true, agentId: "onchain" });

    const targets = { quant: quant.url, onchain: onchain.url };
    const first = await post(targets.quant, {
      content: "Signal from price?",
      history: [{ role: "user", content: "Earlier quant note" }],
    });
    assert.equal(first.status, 202);
    const busy = await post(targets.quant, { content: "Again", history: [] });
    assert.equal(busy.status, 409);

    const second = await post(targets.onchain, {
      content: "Wallet flow?",
      history: [{ role: "assistant", content: "Earlier chain note" }],
    });
    assert.equal(second.status, 202);

    assert.equal(seen.quant[0]?.systemPrompt, promptFor("quant"));
    assert.equal(seen.onchain[0]?.systemPrompt, promptFor("onchain"));
    assert.deepEqual(seen.quant[0]?.history, [{ role: "user", content: "Earlier quant note" }]);
    assert.deepEqual(seen.onchain[0]?.history, [
      { role: "assistant", content: "Earlier chain note" },
    ]);
    assert.equal(seen.quant[0]?.content, "Signal from price?");

    gates.onchain.resolve("No chain data was provided.");
    await waitFor(async () => (await store.listMessages("onchain")).some((message) => message.role === "assistant"));
    gates.quant.resolve("No price data was provided.");
    await waitFor(async () => (await store.latestRun("quant"))?.status === "completed");

    const quantMessages = await store.listMessages("quant");
    const onchainMessages = await store.listMessages("onchain");
    assert.deepEqual(
      quantMessages.map((message) => message.content),
      ["Signal from price?", "No price data was provided."],
    );
    assert.deepEqual(
      onchainMessages.map((message) => message.content),
      ["Wallet flow?", "No chain data was provided."],
    );
    assert.equal((await store.listMessages("quant")).length, quantMessages.length);
  } finally {
    quant.server.close();
    onchain.server.close();
  }
});

test("a restart marks the active run failed and a late reply does not complete it", async () => {
  const store = new MemoryStore();
  const gate = deferred();
  const agent = await listen("fundamental", store, () => gate.promise);
  try {
    const response = await post(agent.url, { content: "Who is the team?", history: [] });
    assert.equal(response.status, 202);
    await store.failInterrupted("fundamental");
    gate.resolve("This should not be saved.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const latest = await store.latestRun("fundamental");
    assert.equal(latest?.status, "failed");
    assert.equal(latest?.error, "Run interrupted by service restart.");
    assert.equal((await store.listMessages("fundamental")).some((message) => message.role === "assistant"), false);
  } finally {
    agent.server.close();
  }
});

test("rejects missing credentials", async () => {
  const store = new MemoryStore();
  const agent = await listen("market", store, async () => "ok");
  try {
    const response = await post(agent.url, { content: "Book?", history: [] as HistoryMessage[] }, "nope");
    assert.equal(response.status, 401);
  } finally {
    agent.server.close();
  }
});

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}
