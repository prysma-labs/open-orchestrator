import { NextResponse } from "next/server";
import { z } from "zod";
import { getLocalHub } from "@/lib/hub";
import { supabaseConfigured } from "@/coordinator/supabase-store";

const bodySchema = z.object({ viewerId: z.uuid() });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (supabaseConfigured()) return NextResponse.json({ viewers: null });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const hub = await getLocalHub();
  return NextResponse.json({ viewers: hub.touchViewer(parsed.data.viewerId) });
}
