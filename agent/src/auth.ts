import { timingSafeEqual } from "node:crypto";

export function authorized(header: string | undefined, secret: string) {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length || provided.length === 0) return false;
  return timingSafeEqual(provided, expected);
}
