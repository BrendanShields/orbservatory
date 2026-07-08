// Canonical event ordering + string hashing, shared by server and client so the
// two sides can never drift. Both were previously duplicated across
// server/{store,normalizer} and web/{engine,render}.

const EVENT_RANK: Record<string, number> = {
  spawn: 0,
  message: 1,
  tool: 2,
  compact: 3,
  error: 4,
  retry: 5,
  complete: 6,
};

/** Stable tie-breaker for events sharing a timestamp. Unknown types sort last. */
export function eventRank(type: string): number {
  return EVENT_RANK[type] ?? 9;
}

/** Deterministic 32-bit string hash (used for colours, jitter, curve bend). */
export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
