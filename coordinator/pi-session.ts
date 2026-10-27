import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createLineBuffer, interpretPiRecord, type PiObservation, type PiRecord } from "@/lib/pi";

type Waiter = {
  resolve: (record: PiRecord) => void;
  reject: (error: Error) => void;
};

export class PiRpcSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Waiter>();
  private settled: Waiter | null = null;
  private listener: ((record: PiRecord) => void) | null = null;
  private seq = 0;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    const push = createLineBuffer((line) => {
      let record: PiRecord;
      try {
        record = JSON.parse(line) as PiRecord;
      } catch {
        return;
      }
      if (record.type === "response" && record.id && this.pending.has(record.id)) {
        this.pending.get(record.id)?.resolve(record);
        this.pending.delete(record.id);
        return;
      }
      this.listener?.(record);
      if (record.type === "agent_settled") this.settled?.resolve(record);
    });
    child.stdout.on("data", (chunk: Buffer) => push(chunk));
    child.stderr.on("data", () => undefined);
    child.on("exit", (code) => {
      const error = new Error(`pi exited (${code ?? "signal"})`);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      this.settled?.reject(error);
    });
  }

  static start(options: { cwd: string; systemPrompt: string; tools: string; model?: string }): PiRpcSession {
    const prefix = (process.env.PI_BIN ?? "pi").split(" ").filter(Boolean);
    const command = prefix[0] ?? "pi";
    const args = [
      ...prefix.slice(1),
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--thinking",
      "off",
      "--tools",
      options.tools,
      "--append-system-prompt",
      options.systemPrompt,
    ];
    if (options.model || process.env.PI_MODEL) args.push("--model", options.model || process.env.PI_MODEL || "");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new PiRpcSession(child);
  }

  async prompt(message: string, onObservation: (observation: PiObservation) => void, signal: AbortSignal): Promise<void> {
    const done = this.settleWhen(signal);
    const guarded = done.catch((error: Error) => error);
    this.listener = (record) => {
      const observation = interpretPiRecord(record);
      if (observation && observation.type !== "settled") onObservation(observation);
    };
    const response = await this.request({ type: "prompt", message }, signal);
    if (!response.success) throw new Error(response.error || "Pi rejected the prompt");
    if (response.data?.disposition === "handled") {
      this.settled?.resolve({ type: "agent_settled" });
      return;
    }
    const result = await guarded;
    if (result instanceof Error) throw result;
  }

  async cost(signal: AbortSignal): Promise<number> {
    const response = await this.request({ type: "get_session_stats" }, signal);
    return Number(response.data?.cost ?? 0) || 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private settleWhen(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.write({ type: "abort" });
        reject(new Error("aborted"));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      this.settled = {
        resolve: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
    });
  }

  private request(command: Record<string, unknown>, signal: AbortSignal): Promise<PiRecord> {
    const id = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi command timed out: ${String(command.type)}`));
      }, 20000);
      const finish = (record: PiRecord) => {
        clearTimeout(timer);
        resolve(record);
      };
      this.pending.set(id, {
        resolve: finish,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (signal.aborted) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("aborted"));
        return;
      }
      this.write({ ...command, id });
    });
  }

  private write(record: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }
}
