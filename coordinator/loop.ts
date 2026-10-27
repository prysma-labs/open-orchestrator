import { createRpcDriver, createSimulatedDriver, type AgentDriver } from "@/coordinator/driver";
import { executeClaim } from "@/coordinator/execute";
import type { Store } from "@/lib/store";

export type CoordinatorHandle = {
  crash: () => void;
  stop: () => Promise<void>;
};

export function startCoordinator(options: {
  store: Store;
  owner: string;
  workRoot: string;
  driver?: AgentDriver;
  pollMs?: number;
  allowFailureInjection?: boolean;
}): CoordinatorHandle {
  const driver = options.driver ?? (process.env.PI_DRIVER === "rpc" ? createRpcDriver() : createSimulatedDriver(Number(process.env.SIM_STEP_MS ?? 700)));
  let stopped = false;
  let controller = new AbortController();
  let running: Promise<void> | null = null;

  const loop = async () => {
    while (!stopped) {
      controller = new AbortController();
      const claim = await options.store.claim(options.owner).catch(() => null);
      if (!claim || !claim.claimed) {
        await sleep(options.pollMs ?? 500);
        continue;
      }
      const abort = (next: "lost" | "cancel") => {
        if (!controller.signal.aborted) controller.abort(next);
      };
      running = executeClaim({
        store: options.store,
        driver,
        claim,
        owner: options.owner,
        signal: controller.signal,
        workRoot: options.workRoot,
        allowFailureInjection: options.allowFailureInjection ?? process.env.NODE_ENV !== "production",
        abort,
      }).then(() => undefined).catch(async (error: unknown) => {
        const why = controller.signal.reason;
        if (why === "crash" || why === "lost") return;
        const message = error instanceof Error ? error.message : "The coordinator failed.";
        await options.store.finishRun({
          owner: options.owner,
          runId: claim.runId,
          status: "failed",
          content: message.slice(0, 2000),
          costUsd: 0,
        }).catch(() => undefined);
      }).finally(() => {
        running = null;
      });
      await running;
    }
  };

  void loop();

  return {
    crash() {
      controller.abort("crash");
    },
    async stop() {
      stopped = true;
      controller.abort("crash");
      await running;
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
