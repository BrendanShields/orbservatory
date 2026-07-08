/**
 * Decide how to bring a reconnecting subscriber back in sync, given the array
 * index it last saw (`since`) and the server's current event count (`total`).
 *
 * This is a pure function so the reconnect protocol can be tested without a live
 * WebSocket. Correctness depends on the stored event log being append-only
 * (see SessionStore.merge): only then does `slice(since)` equal exactly the gap
 * the client is missing.
 */
export type ResumeAction =
  | { kind: 'noop' }
  | { kind: 'events'; from: number }
  | { kind: 'snapshot' };

export function resumeAction(since: number, total: number, sameBoot = true): ResumeAction {
  // Index cursors are only meaningful within one server process: the stored log
  // is append-ordered by ingest, and a restarted server re-reads the same files
  // in a different interleave (root fully, then subagents) than the original
  // live tailing produced. A cursor minted by another boot therefore points at
  // different events — even when counts happen to match — so it must never be
  // trusted for an incremental resume.
  if (!sameBoot) return { kind: 'snapshot' };
  // Client is already current.
  if (since > 0 && since === total) return { kind: 'noop' };
  // Client is behind by a known gap: stream just the tail it hasn't seen.
  if (since > 0 && since < total) return { kind: 'events', from: since };
  // Fresh subscription (since === 0) or client ahead of server
  // (since > total, e.g. transcript truncated/restarted): re-snapshot.
  return { kind: 'snapshot' };
}
