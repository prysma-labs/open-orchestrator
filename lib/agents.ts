export const AGENTS = [
  {
    id: "quant",
    name: "Quant researcher",
    blurb: "Price, volume, and derivatives signals",
  },
  {
    id: "onchain",
    name: "On-chain researcher",
    blurb: "Wallets, flows, and network usage",
  },
  {
    id: "fundamental",
    name: "Fundamental researcher",
    blurb: "Protocols, token economics, and teams",
  },
  {
    id: "market",
    name: "Market structure researcher",
    blurb: "Liquidity, books, funding, and mechanics",
  },
] as const;

export type AgentId = (typeof AGENTS)[number]["id"];

const URL_ENV: Record<AgentId, string> = {
  quant: "AGENT_URL_QUANT",
  onchain: "AGENT_URL_ONCHAIN",
  fundamental: "AGENT_URL_FUNDAMENTAL",
  market: "AGENT_URL_MARKET",
};

export function isAgentId(value: string): value is AgentId {
  return Object.prototype.hasOwnProperty.call(URL_ENV, value);
}

export function agentById(id: string) {
  return AGENTS.find((agent) => agent.id === id);
}

export function agentBaseUrl(agentId: AgentId, env: NodeJS.ProcessEnv = process.env) {
  const key = URL_ENV[agentId];
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value.replace(/\/$/, "");
}
