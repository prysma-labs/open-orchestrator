const TONE: Record<string, string> = {
  queued: "bg-white/5 text-[#c8c3ba]",
  claimed: "bg-white/5 text-[#c8c3ba]",
  running: "bg-[#e4b15a]/15 text-[#f0cb86]",
  completed: "bg-emerald-400/10 text-emerald-200",
  complete: "bg-emerald-400/10 text-emerald-200",
  failed: "bg-red-400/10 text-red-200",
  interrupted: "bg-orange-400/10 text-orange-200",
  cancelled: "bg-white/5 text-[#8d887f] line-through",
  idle: "bg-white/5 text-[#8d887f]",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.14em] ${TONE[status] ?? TONE.idle}`}>
      {status}
    </span>
  );
}
