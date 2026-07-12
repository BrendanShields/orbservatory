# Transcript pane — design

**Date:** 2026-07-12 · **Status:** approved · **Ships as:** its own worktree/PR, branched from `feat/pi-provider-hardening` (needs the pi provider)

## Purpose

The canvas shows event labels only (truncated to ~120 chars). Reviewing a session — "what did the agent actually say / run / return" — requires opening raw JSONL. Add a readable conversation view synced to the timeline scrubber, for all five providers (claude, codex, pi, copilot, opencode).

## Decisions (user-approved)

- Placement: **second tab in the right inspector** ("Inspect | Transcript"); pane widens to ~480px while the transcript tab is active.
- Provider scope: **all five** in the first ship.
- Data stays on disk; the client pages it on demand. No transcript text in WS snapshots (sessions can be 100MB+).

## Architecture

```
disk (JSONL / SQLite)
  → provider.transcript(state, opts)        [new optional SessionProvider method]
  → runtime.transcript(id, opts)            [server/runtime.ts]
  → GET /api/session/<id>/transcript        [app/api/session/[...parts], beside /export]
  → inspector Transcript tab                [web/panels.ts]
```

### Wire type (`shared/schema.ts`)

```ts
interface TranscriptItem {
  i: number;            // stable index within the session, cursor basis
  t: number;            // ms relative to session start — same clock as AwvEvent.t
  ts?: string;          // ISO wall clock when known
  role: 'user' | 'assistant' | 'tool' | 'tool-result' | 'error';
  agent: string;        // AWV agent id (session:<id> / …:agent-<id>)
  text: string;         // capped at 4000 chars
  truncated?: boolean;
  tool?: string;        // tool name for tool/tool-result rows
  tokens?: number;      // usage delta when the record carries one
}
interface TranscriptResponse { items: TranscriptItem[]; nextCursor?: number; total?: number }
```

### Endpoint

`GET /api/session/<encoded-id>/transcript?agent=<awvId>&before=<i>&after=<i>&limit=<n>`

- `limit` default 200, hard max 1000. Omitted `agent` = all agents.
- No `before`/`after` → the **newest** `limit` items plus `total` (initial open).
- `before=<i>` → the `limit` items with `i < before` closest below it (scroll-up, older history).
- `after=<i>` → items with `i > after` (live tail-follow).
- Reuses the `[...parts]` catch-all parsing (session ids contain slashes).
- Errors: unknown session → 404; source file vanished mid-read → 410 (client toasts); provider without extractor → 404 with `{unsupported: true}` (client hides the tab).

### Per-provider extractors

Shared plumbing in `server/transcript.ts`; each extractor reuses the parsing rules its normalizer already encodes:

- **claude** — root + subagent + workflow files (same discovery as the watcher): user text blocks, assistant text blocks, `tool_use` (name + summarized input), `tool_result` (text, `is_error` → role `error`), `isApiErrorMessage` → error. Meta/housekeeping records skipped (same rules as `TranscriptNormalizer`).
- **codex** — `event_msg` user/agent messages, `response_item` function/custom/web-search calls + outputs (plain-text exit-code parsing shared with the normalizer), errors, subagent rollout files mapped to their child agent ids.
- **pi** — `message` entries: user, assistant (text + toolCall blocks), toolResult, bashExecution; `session_info`/housekeeping skipped.
- **copilot** — events.jsonl message/tool records per its normalizer.
- **opencode** — SQL over `message` + `part` rows for the session tree (text parts, tool parts with state title/input, errors), ordered by id.

Extractors are read-only and stateless per request; they do not touch tail cursors or normalizer state.

## Web UI (`web/panels.ts` + `web/main.ts`)

- Inspector header gains tabs; state per session view. Transcript tab:
  - fetches the newest page on open, older pages on scroll-up (prepend, scroll-anchored);
  - **click row → seek** (`onSeek(item.t)`);
  - **playing → follow**: highlight last row with `t ≤ simT`, auto-scroll unless the user scrolled away (re-engage via a "follow" chip, same pattern as the LIVE button);
  - live sessions tail-fetch when new events arrive for the session (debounced);
  - default filter = selected agent; "all agents" toggle shows agent dot + name per row.
- Rows: role-tinted left border (user=accent, assistant=text, tool=warn, error=err), monospace time, wrapped text, expand/collapse for truncated items (fetches nothing extra — shows `…truncated`).
- `.inspector.transcript-open{width:480px}`; the camera gutter constant in `render.ts` (`px1 = w - (selectedId ? 374 : 22)`) becomes width-aware (reads the actual inspector width class).
- Keyboard: tabs reachable, rows are buttons (Enter = seek). Reduced-motion: no smooth scrolling.

## Edge cases

- Binary/image content blocks → `[image]` placeholder text.
- Session rewritten in place between pages (cursor now beyond file) → server returns fresh first page with `nextCursor` reset; client detects `i` regression and replaces the list.
- `all-live` merged view: transcript tab hidden (no single session id).
- Imported replays (`__imported`): tab hidden (no server session).

## Testing

- Per-provider extractor tests against synthetic fixtures (same style as `test/pi.test.ts` / `test/watch.test.ts`), asserting roles, `t` alignment with events, truncation flags, agent attribution for subagents.
- Endpoint tests through the runtime: paging, agent filter, limit clamp, 404/410 paths.
- Pure-function tests for follow/windowing logic (style of `test/ui-pure.test.ts`).
- `pnpm typecheck && pnpm build && bun test` before handoff.

## Out of scope

- Rendering markdown/code-highlighting in messages (plain text v1).
- Search-within-transcript UI (global ⌘K search already lands on the session; tab scrolls to nearest item by `t`).
- Editing/annotating transcripts.
