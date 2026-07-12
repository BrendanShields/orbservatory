# Transcript pane — implementation plan

**Spec:** `docs/superpowers/specs/2026-07-12-transcript-pane-design.md`
**Branch:** `feat/transcript-pane` off `feat/pi-provider-hardening` (own worktree)
**Validation gate for every phase:** `pnpm typecheck && bun test` (plus `pnpm build` before handoff)

## Phase 1 — wire types

1. `shared/schema.ts`: add `TranscriptItem` and `TranscriptResponse` exactly as specced (`i`, `t`, `ts?`, `role`, `agent`, `text`, `truncated?`, `tool?`, `tokens?`; response `{ items, nextCursor?, total? }`).
   - Done when: typecheck passes; no other file changes needed yet.

## Phase 2 — server plumbing

2. `server/providers/types.ts`: add optional method to `SessionProvider`:
   `transcript?(state: SessionState, opts: TranscriptQuery): Promise<TranscriptResponse | null>`
   with `TranscriptQuery = { agent?: string; before?: number; after?: number; limit: number }` (export from `server/transcript.ts`).
3. New `server/transcript.ts`:
   - `TranscriptQuery` type, `TEXT_CAP = 4000`, `LIMIT_DEFAULT = 200`, `LIMIT_MAX = 1000`;
   - `capText(s)` → `{ text, truncated }`;
   - `pageItems(all: TranscriptItem[], q: TranscriptQuery): TranscriptResponse` — applies agent filter, then before/after/newest-page windowing per spec, sets `nextCursor` (oldest `i` in the returned window when older items remain) and `total` on initial page.
   - Done when: unit tests for `pageItems` cover: no-params newest page + total, `before` older page, `after` tail, agent filter, limit clamp.
4. `server/runtime.ts`: `async transcript(id, q)` — resolve state, `ensureLoaded` NOT required (extractors read disk directly), call provider method; `null`/missing method → `{ unsupported: true }` sentinel for the route.
5. `app/api/session/[...parts]/route.ts`: handle trailing `/transcript` beside `/export`; parse query params, clamp limit; 404 unknown session, 404 + `{unsupported:true}` when provider lacks the method, 410 when the extractor throws ENOENT.
   - Done when: runtime-level test hits the route handler function with a synthetic session and gets paged JSON.

## Phase 3 — extractors (one task per provider; each = extractor + fixture test)

Shared shape: build the full `TranscriptItem[]` for the session in append order, assign `i` sequentially, reuse the provider's existing time base so `t` matches event `t` (same startedAt rules), then `return pageItems(all, q)`. Read-only: never touch tail cursors or live normalizer state. Roles per spec; tool inputs summarized with the same helpers the normalizers use (export where private).

6. **claude** (`server/providers/claude.ts`): discovery = root file + `subagents/*.jsonl` + `subagents/workflows/wf_*/**.jsonl` (reuse `discoverSources`); map user text / assistant text / `tool_use` / `tool_result` / `isApiErrorMessage`; skip housekeeping + meta + compact summaries (same predicates as the normalizer — extract shared helpers rather than duplicating).
   - Test: fixture with root + one subagent; asserts roles, subagent `agent` id, `t` alignment with a normalizer pass, image block → `[image]`.
7. **codex** (`server/providers/codex.ts`): iterate `sessionFiles`; `event_msg` user/agent messages, `response_item` calls/outputs (reuse `outputFailure` for exit codes → role `error` rows), `turn_aborted`.
   - Test: fixture incl. plain-text failed shell output.
8. **pi** (`server/providers/pi.ts`): message entries (user / assistant text+toolCall / toolResult / bashExecution), skip housekeeping; v1 files (no ids) still produce sequential `i`.
   - Test: v3 + v1 fixtures.
9. **copilot** (`server/providers/copilot.ts`): map per `copilot-normalizer` record handling.
   - Test: synthetic events.jsonl fixture.
10. **opencode** (`server/providers/opencode.ts` + `opencode-db.ts`): add read-only queries `messagesForSession(sessId)` / `partsForSession(sessId)` (full rows, ordered by id) over the session tree; map text parts (role from message), tool parts (state title/input, error status), assistant errors.
    - Test: in-memory/synthetic SQLite fixture (follow `test/opencode-db.test.ts` pattern).

## Phase 4 — web UI

11. `web/panels.ts`: inspector tab strip (`Inspect | Transcript`), per-inspector state (`tab`, `items`, `total`, `loading`, `follow`, `allAgents`). Transcript renderer:
    - initial fetch on tab open (newest page), prepend-on-scroll-top with scroll anchoring, tail fetch (`after=lastI`) when the session's event count grows (hook from `renderInspector` args);
    - row = `<button>`: role tint class, `fmtT(t)` time, wrapped text, agent dot+name when `allAgents`;
    - click → `onSeek(item.t)` (new callback threaded from `main.ts`);
    - follow mode: highlight last row `t ≤ simT`, auto-scroll while playing unless user scrolled (re-engage chip);
    - hide tab for `all-live` and imported views, or when the endpoint returned `unsupported`.
12. `web/main.ts`: pass `onSeek` + a session-id/live handle into `renderInspector`; no routing changes.
13. `web/render.ts`: replace the `374` gutter constant with a measured inspector width (cache per frame; fall back to 374).
14. `web/style.css`: `.inspector.transcript-open{width:480px}`, tab strip styles (reuse `.log-chips` look), role tints via existing tokens, row focus states. Reduced-motion: rely on the global override (no new animation).
15. Pure-function tests (`test/ui-pure.test.ts` style): follow/highlight index for a given `simT`, prepend-anchor math, `unsupported` tab-hiding predicate.

## Phase 5 — validation + ship

16. `pnpm typecheck && pnpm lint && pnpm build && bun test`.
17. Live smoke: `pnpm dev`, open a real claude session → transcript renders, click-seek moves playhead, live session tails; check light + dark, keyboard tab/enter on rows, 480px widening, canvas gutter shift.
18. Commit, push, PR against `feat/pi-provider-hardening` (or main if #2 already merged) with test-plan checklist.

## Risks / notes

- Claude summarize/skip predicates live inside `TranscriptNormalizer` as private logic — extract to module-level functions once, in place (no duplication).
- Large sessions: initial newest-page keeps first paint fast; never read whole file into items eagerly beyond what paging needs (fine to parse the file once per request for v1 — bounded by request, no cache; note follow-up: LRU per (id, mtime) if latency shows).
- Do not touch `store.ts` event flow anywhere.
