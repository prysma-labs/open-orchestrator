import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { HistoryMessage, RunInput } from "./types.js";

const emptyUsage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toPiMessage(message: HistoryMessage, modelId: string): UserMessage | AssistantMessage {
  const timestamp = Date.now();
  if (message.role === "user") return { role: "user", content: message.content, timestamp };
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: "openai-completions",
    provider: "openrouter",
    model: modelId,
    usage: emptyUsage,
    stopReason: "stop",
    timestamp,
  };
}

let runtimePromise: Promise<ModelRuntime> | undefined;

async function modelRuntime() {
  runtimePromise ??= (async () => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("Missing OPENROUTER_API_KEY");
    const runtime = await ModelRuntime.create();
    await runtime.setRuntimeApiKey("openrouter", key);
    return runtime;
  })();
  return runtimePromise;
}

export async function runPi(input: RunInput) {
  const modelId = process.env.OPENROUTER_MODEL?.trim();
  if (!modelId) throw new Error("Missing OPENROUTER_MODEL");
  const runtime = await modelRuntime();
  let model = runtime.getModel("openrouter", modelId);
  if (!model) {
    await runtime.refresh();
    model = runtime.getModel("openrouter", modelId);
  }
  if (!model) throw new Error(`OpenRouter model is not available: ${modelId}`);

  const cwd = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => input.systemPrompt,
    appendSystemPromptOverride: () => [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const sessionManager = SessionManager.inMemory(cwd);
  for (const message of input.history) {
    sessionManager.appendMessage(toPiMessage(message, modelId));
  }

  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime: runtime,
    thinkingLevel: "off",
    noTools: "all",
    resourceLoader: loader,
    sessionManager,
  });

  try {
    await session.prompt(input.content);
    const text = session.getLastAssistantText()?.trim();
    if (!text) throw new Error("The agent returned an empty response.");
    return text;
  } finally {
    session.dispose();
  }
}
