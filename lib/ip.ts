import { createHash } from "node:crypto";

export function hashIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "local";
  const salt = process.env.IP_HASH_SALT || "local-dev-salt";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}
