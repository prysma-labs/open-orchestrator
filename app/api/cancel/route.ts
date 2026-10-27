import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerStore } from "@/lib/hub";

const bodySchema = z.object({ requestId: z.number().int().positive() });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const result = await (await getServerStore()).cancel(parsed.data.requestId);
  return NextResponse.json(result);
}
