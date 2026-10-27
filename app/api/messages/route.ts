import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerStore } from "@/lib/hub";
import { hashIp } from "@/lib/ip";

const bodySchema = z.object({
  content: z.string(),
  clientKey: z.uuid(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const result = await (await getServerStore()).submit({ ...parsed.data, ipHash: hashIp(request) });
  if (!result.ok) {
    const status = result.error === "rate_limit" || result.error === "queue_full" || result.error === "budget" ? 429 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
