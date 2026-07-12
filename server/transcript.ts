import type { TranscriptItem, TranscriptResponse } from '../shared/schema';

export interface TranscriptQuery {
  agent?: string;
  before?: number;
  after?: number;
  limit: number;
}

export const TEXT_CAP = 4000;
export const LIMIT_DEFAULT = 200;
export const LIMIT_MAX = 1000;

export function capText(s: string): { text: string; truncated?: boolean } {
  const t = s.trim();
  if (t.length <= TEXT_CAP) return { text: t };
  return { text: t.slice(0, TEXT_CAP), truncated: true };
}

export function parseTranscriptQuery(sp: URLSearchParams): TranscriptQuery {
  const num = (v: string | null) => {
    if (v == null || v === '') return undefined;
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? n : undefined;
  };
  const limit = Math.min(Math.max(num(sp.get('limit')) ?? LIMIT_DEFAULT, 1), LIMIT_MAX);
  return { agent: sp.get('agent') || undefined, before: num(sp.get('before')), after: num(sp.get('after')), limit };
}

/** First index with `i > target` (items are sorted ascending by `i`). */
function firstAbove(items: TranscriptItem[], target: number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (items[m].i <= target) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Windows a full session transcript per the paging contract: no cursor → the
 * newest `limit` items plus `total`; `before` → the items closest below it
 * (scroll-up); `after` → items past it (live tail). `nextCursor` is the oldest
 * `i` in the returned window while older items remain.
 */
export function pageItems(all: TranscriptItem[], q: TranscriptQuery): TranscriptResponse {
  const items = q.agent ? all.filter((it) => it.agent === q.agent) : all;
  const limit = Math.min(Math.max(Math.trunc(q.limit) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const newestPage = (): TranscriptResponse => {
    const start = Math.max(0, items.length - limit);
    const page = items.slice(start);
    return { items: page, nextCursor: start > 0 && page.length ? page[0].i : undefined, total: items.length };
  };
  if (q.after != null) {
    // A cursor past the newest item means the session was rewritten in place
    // beneath the client — answer with a fresh first page so it can resync.
    if (items.length && q.after > items[items.length - 1].i) return newestPage();
    const start = firstAbove(items, q.after);
    return { items: items.slice(start, start + limit) };
  }
  if (q.before != null) {
    const end = firstAbove(items, q.before - 1);
    const start = Math.max(0, end - limit);
    const page = items.slice(start, end);
    return { items: page, nextCursor: start > 0 && page.length ? page[0].i : undefined };
  }
  return newestPage();
}

/**
 * Session-relative clock for extractors, mirroring the normalizers': records
 * without a real timestamp inherit the last one seen, and only real timestamps
 * establish the start. `rebase` matches the Claude normalizer (an earlier
 * timestamp re-bases the whole session); the other providers pin the first.
 */
export function extractClock(opts?: { rebase?: boolean }) {
  let startedAt = 0;
  let lastTs = 0;
  return {
    at(real: number | null): { ts: number; t: number } {
      if (real) { lastTs = real; if (!startedAt || (opts?.rebase && real < startedAt)) startedAt = real; }
      const ts = real ?? (lastTs || Date.now());
      return { ts, t: startedAt ? Math.max(0, ts - startedAt) : 0 };
    },
  };
}
