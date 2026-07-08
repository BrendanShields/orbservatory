import type { SearchField, SearchMatch, SearchPart } from '../shared/schema';

const SNIPPET_CONTEXT = 44;
/** Fields in match-priority order: a prompt hit beats a tool-input hit. */
const FIELD_RANK: Record<SearchField, number> = { title: 0, prompt: 1, skill: 2, assistant: 3, tool: 4 };

/** Best (highest-priority) match of `q` inside one session's search doc, or null. */
export function matchDoc(sessionId: string, parts: SearchPart[], q: string): SearchMatch | null {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  let best: { rank: number; part: SearchPart; at: number } | null = null;
  for (const part of parts) {
    const at = part.s.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const rank = FIELD_RANK[part.f] ?? 9;
    if (!best || rank < best.rank) best = { rank, part, at };
    if (best.rank === 0) break;
  }
  if (!best) return null;
  return { sessionId, field: best.part.f, snippet: snippetAround(best.part.s, best.at, q.trim().length) };
}

export function snippetAround(text: string, at: number, matchLen: number): string {
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(text.length, at + matchLen + SNIPPET_CONTEXT);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * Search many session docs. `allow` (when given) is the metadata-filter
 * intersection: only those session ids are considered.
 */
export function searchDocs(
  docs: Iterable<[string, SearchPart[]]>,
  q: string,
  allow?: Set<string>,
  limit = 100,
): SearchMatch[] {
  const out: SearchMatch[] = [];
  for (const [sessionId, parts] of docs) {
    if (allow && !allow.has(sessionId)) continue;
    const m = matchDoc(sessionId, parts, q);
    if (m) {
      out.push(m);
      if (out.length >= limit) break;
    }
  }
  return out;
}
