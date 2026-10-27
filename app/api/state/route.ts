import { NextResponse } from "next/server";
import { getLocalHub, getServerStore } from "@/lib/hub";
import { supabaseConfigured } from "@/coordinator/supabase-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const store = await getServerStore();
  const snapshot = await store.snapshot(0);
  if (!supabaseConfigured()) {
    const hub = await getLocalHub();
    return NextResponse.json({ mode: "local", viewers: hub.viewerCount(), ...snapshot });
  }
  return NextResponse.json({ mode: "supabase", viewers: null, ...snapshot });
}
