import assert from "node:assert/strict";
import test from "node:test";
import { buildRunRequest } from "../lib/dispatch.ts";

const env = {
  AGENT_SHARED_SECRET: "shared-secret",
  AGENT_URL_QUANT: "https://quant.example/",
  AGENT_URL_ONCHAIN: "https://onchain.example",
  AGENT_URL_FUNDAMENTAL: "https://fundamental.example",
  AGENT_URL_MARKET: "https://market.example",
};

test("the selected agent is sent to that agent's VM", () => {
  const quant = buildRunRequest("quant", "price?", [{ role: "user", content: "prior" }], env);
  const market = buildRunRequest("market", "book?", [], env);
  assert.equal(quant.url, "https://quant.example/runs");
  assert.equal(market.url, "https://market.example/runs");
  assert.equal(quant.init.headers.authorization, "Bearer shared-secret");
  assert.deepEqual(JSON.parse(quant.init.body as string).history, [{ role: "user", content: "prior" }]);
  assert.notEqual(quant.url, market.url);
});
