# Multi-provider session ingestion — design

**Date:** 2026-07-08
**Status:** Approved

## Goal

Visualize agent sessions from OpenAI Codex CLI, opencode, and GitHub Copilot CLI alongside Claude Code sessions, live where each tool's storage format allows it. Everything downstream of normalization (store, WebSocket protocol, engine, renderer, replay) stays provider-agnostic.

## Non-goals

- opencode flat-JSON storage era (pre-v1.3). Only the current SQLite store is supported.
- Copilot CLI legacy `~/.copilot/history-session-state/` sessions.
- Empirical verification of Copilot live-write behavior (CLI not installed; adapter ships best-effort and degrades to historical-only if tailing assumptions are wrong).
- Context-limit gauges for non-Claude models. Foreign models get token counts; a limit line appears only if the user adds the model to the `contextLimits` settings map.

## Architecture

Data flow stays one-way; one new seam is introduced between discovery/parsing and the store:

```
providers/claude    (existing watch.ts + normalizer.ts behind the new interface)
providers/codex     ┐
providers/opencode  ├─→ SessionStore → WebSocket → engine → renderer   (untouched)
providers/copilot   ┘
```

### Provider interface (`server/providers/types.ts`)

```ts
interface SessionProvider {
  readonly source: SessionSource;      // 'claude' | 'codex' | 'opencode' | 'copilot'
  start(): void;
  stop(): void;
  scan(): Promise<void>;               // test hook, same contract as today's watcher.scan()
  setPollMs(ms: number): void;
  setLivenessMs(ms: number): void;
}
```

- The existing `ClaudeProjectWatcher` becomes the first implementation (moved/wrapped; behavior-neutral refactor).
- `SessionState.normalizer` narrows from `TranscriptNormalizer` to a minimal interface (`setContextLimits(limits): AwvAgent[]`); each provider supplies its own normalizer.
- Lazy loading (peek vs. full load) remains a provider concern, matching the current Claude watcher's `ensureLoaded` behavior. Providers for which peeking is cheap or meaningless may load eagerly, but must respect subscriber-driven loading for historical sessions.
- `server/index.ts` builds the provider list and starts each. A provider that throws during a tick logs the error and skips the tick; a provider that fails fatally (e.g., unreadable storage) disables itself without affecting the server or other providers.

### Identity and configuration

- Session ids are namespaced by provider: `codex:<threadId>`, `opencode:<sessionID>`, `copilot:<uuid>`. Claude ids keep their current shape for backward compatibility.
- A provider auto-starts only if its root exists on disk. Zero configuration by default.
- Roots are overridable by environment: `CODEX_HOME` (Codex respects this itself), `COPILOT_HOME`, and `OPENCODE_DATA_DIR` (falls back to `$XDG_DATA_HOME/opencode`, then `~/.local/share/opencode`). `CLAUDE_PROJECTS_DIR` keeps working as today.
- `Settings` gains `providers: Record<string, boolean>` enable toggles (default on). Toggling applies live via `applySettings` like other settings.

## Per-provider ingestion

### codex

- **Discovery:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, recursive walk. Append-only JSONL; byte-offset tailing with partial-line buffering and truncation reset, same pattern as the Claude watcher.
- **Line shape:** `{ timestamp, type, payload }` with types `session_meta`, `turn_context`, `response_item`, `event_msg`.
- **Subagents:** rollout files with `payload.thread_source === "subagent"` fold into the parent session located via `payload.parent_thread_id`. The child becomes an agent node with a `spawn` event; its name comes from `payload.source.subagent` when present.
- **Event mapping:**
  - `session_meta` → root agent (cwd, model provider, CLI version) + `spawn`.
  - `event_msg` `user_message` / `agent_message` → `message`.
  - `response_item` `function_call` / `custom_tool_call` / `web_search_call` → `tool`; the matching `*_call_output` closes it (call id ↔ `useId`), error-shaped output → `error`.
  - `event_msg` `token_count` → token keyframes.
  - `event_msg` `task_complete` → `complete`.
  - `response_item` `reasoning` / `message` contribute to labels and activity but produce no dedicated event type beyond the above.
- **Liveness:** full live parity (files are appended during the run).

### opencode

- **Discovery:** SQLite database `<data>/opencode.db` (also match channel builds `opencode-<channel>.db` if the default is absent), opened read-only via `bun:sqlite`. WAL mode makes concurrent reads safe.
- **Polling:** cursor on `time_updated` across sessions; changed sessions get their messages/parts re-queried incrementally (message/part ids are monotonic, so an id cursor per session bounds re-reads).
- **Subagents:** session rows with `parent_id` fold into the parent session as child agents. The parent's `task` tool part carries the child session id in its metadata; spawn time = tool part `time.start`, completion = `time.end`.
- **Event mapping:**
  - session row → root agent (directory, title) + `spawn`.
  - message rows: user → `message`; assistant `time.created`/`time.completed` → `message` / activity; assistant `error` → `error`; compaction summaries (`summary` flag) → `compact` where a resulting token level is derivable.
  - `tool` parts → `tool` (state `error` → `error`); `state.time.start/end` give timing.
  - assistant `tokens` (input/output/reasoning/cache) and `step-finish` parts → token keyframes.
  - session end has no explicit marker; `complete` is emitted for the final assistant message with `time.completed` when the session is not live by liveness window.
- **Liveness:** polling picks up row upserts; effectively live at `pollMs` granularity.
- **Failure modes:** DB open failure or `SQLITE_BUSY` → retry next poll. Unexpected schema (future opencode migration) → log once, disable provider.

### copilot

- **Discovery:** `~/.copilot/session-state/<uuid>/events.jsonl`, one directory per session. Byte-offset tailing.
- **Line shape:** `{ type, timestamp, data }`, ISO-8601 timestamps.
- **Event mapping:**
  - `session.start` → root agent (repository/branch metadata where present) + `spawn`.
  - user/assistant message events (schema partially undocumented) → `message`, defensively parsed.
  - `tool.execution_start` → `tool`; `tool.execution_complete` with `success: false` → `error`.
  - `subagentStart` → `spawn` of a child agent.
  - `session.shutdown` → `complete` + a single terminal token keyframe from `modelMetrics` (per-turn token data is not known to exist).
- **Defensiveness:** unknown event types are skipped silently; missing fields get best-effort defaults; a file that fails to parse entirely skips that session without affecting others. The adapter is explicitly best-effort while the format churns (closed source, pre-1.0 cadence).

### Time model (all providers)

Absolute timestamps are converted to `t` = milliseconds relative to session start. Clock-less records are never stamped with ingest wall-time (see commit 937b32b).

## Schema and UI changes

- `SessionSummary` gains `source: 'claude' | 'codex' | 'opencode' | 'copilot'`. This is a wire-protocol change; server and web are updated in the same change per repo convention.
- `AwvSession` / `AwvAgent` / `AwvEvent` are unchanged. Engine and renderer are untouched.
- Session picker: a small source badge per row and a source filter consistent with existing picker styling. Inspector shows the source.
- Settings modal: per-provider enable toggles.
- Export/import: AWV JSON is provider-neutral and continues to work unchanged.

## Error handling summary

- Malformed JSONL lines skipped (existing Claude pattern reused everywhere).
- Provider exceptions caught at tick boundaries; one provider down never affects the rest or the server.
- opencode SQLite: retry on busy; disable with a single logged error on schema mismatch.
- copilot: tolerate unknown events, partial schemas, and whole-file failures per session.

## Testing

Same pattern as `test/watch.test.ts`: synthetic fixtures in a temp root, manual `scan()`, `{ watchFs: false, pollMs: <huge> }`, no timers, no real home directories.

- `test/codex.test.ts` — synthetic rollout JSONL modeled on real local files: session_meta, tool call/output pairing, token_count keyframes, subagent fold-in via parent_thread_id, incremental tail append, truncation reset.
- `test/opencode.test.ts` — temp SQLite database built in-test via `bun:sqlite`; insert session/message/part rows; assert normalization, parent/child folding, and cursor incrementality across scans.
- `test/copilot.test.ts` — synthetic events.jsonl from documented shapes; unknown-event tolerance; shutdown token keyframe.
- Existing Claude tests pass unchanged; the provider refactor is behavior-neutral.

## Dependencies

None added. `bun:sqlite` is built into Bun. The zero-runtime-dependency rule holds.
