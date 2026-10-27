import { runRemoteCoordinator } from "@/coordinator/supabase-store";

runRemoteCoordinator().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "coordinator failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
