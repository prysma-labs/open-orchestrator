import { NextResponse } from "next/server";
import { getLocalHub } from "@/lib/hub";
import { supabaseConfigured } from "@/coordinator/supabase-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (process.env.NODE_ENV === "production" || supabaseConfigured()) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  await (await getLocalHub()).crash();
  return NextResponse.json({ ok: true });
}
