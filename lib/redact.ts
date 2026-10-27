const SECRET =
  /((?:api[_-]?key|secret|token|password|authorization)\s*[=:]\s*)(\S+)|sk-[a-z0-9_-]{8,}|bearer\s+[a-z0-9._~+/-]{8,}/gi;

export function redact(value: string): string {
  return value.replace(SECRET, (match, prefix: string | undefined) =>
    prefix ? `${prefix}[redacted]` : "[redacted]",
  );
}

export function clip(value: string, max = 240): string {
  const clean = redact(value).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
