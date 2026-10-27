import { getLocalHub } from "@/lib/hub";
import { supabaseConfigured } from "@/coordinator/supabase-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (supabaseConfigured()) return new Response("local stream only", { status: 404 });
  const hub = await getLocalHub();
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (message: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      };
      send({ type: "invalidate" });
      unsubscribe = hub.subscribe(send);
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
