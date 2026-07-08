# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**claude-viz** — a local Bun web app that visualises Claude Code sessions as a live animated agent graph. It watches transcript JSONL files under `~/.claude/projects`, normalizes them into the AWV (Agentic Workflow Visualizer) schema, and streams sessions over WebSocket to a canvas frontend with timeline replay.

The runtime is **Bun**, not Node — `Bun.serve`, `Bun.file`, HTML imports, `bun test`. There are no runtime dependencies.

## Commands

```bash
bun start                  # server + open browser (CLAUDE_VIZ_NO_OPEN=1 to suppress)
bun run serve              # server only
bun run dev                # watch mode with HMR
bun test                   # all tests
bun test test/store.test.ts        # one test file
bun test -t "pattern"              # tests matching name
bun run typecheck          # tsc --noEmit (strict; no build step emits JS)
bun run build:bin [--all]  # self-contained binary(ies) → dist/
```

Environment variables: `PORT`, `HOST` (defaults to `127.0.0.1` — loopback-only is a deliberate privacy choice, don't widen it), `CLAUDE_PROJECTS_DIR` (alternate transcript root, used by tests), `CLAUDE_VIZ_CONFIG_DIR` (settings location).

## Architecture

Data flows one way: transcript files → watcher → normalizer → store → WebSocket → engine → renderer.

**Server** (`server/`):
- `watch.ts` — `ClaudeProjectWatcher` discovers sessions (each `<project>/<sessionId>.jsonl` plus its `<sessionId>/subagents/*.jsonl` and workflow files) via polling + `fs.watch` nudges. Tails files incrementally by byte offset, buffering partial trailing lines and resetting on truncation. Lazy loading: live sessions are fully parsed; historical sessions are only "peeked" (bounded head+tail slice for title/cwd) until a subscriber explicitly asks for them.
- `normalizer.ts` — `TranscriptNormalizer` turns raw transcript lines into AWV agents + events (`spawn`/`message`/`tool`/`compact`/`error`/`retry`/`complete`). Stateful and incremental; handles out-of-order arrivals (subagent files appearing mid-stream, meta.json arriving late, enrichment applied to agents seen only later).
- `store.ts` — `SessionStore` holds per-session state, merges normalized batches, and broadcasts diffs to `Subscriber`s.
- `index.ts` — `Bun.serve` with HTTP API (`/api/health`, `/api/sessions`, `/api/settings`, `/api/session/:id/export`) and `/ws`. The frontend is served via a Bun HTML import of `web/index.html` — there is no separate frontend build. `WsSubscriber` implements the resume protocol (`resume.ts` decides noop / incremental events / full snapshot based on the client's `lastEventIndex`).
- `settings.ts` / `config.ts` — persisted user settings (OS config dir) vs. resolved runtime config (env overrides). Settings changes apply live via `applySettings` and are broadcast to clients.

**Shared** (`shared/`):
- `schema.ts` — the AWV wire types and the `ClientMessage`/`ServerMessage` WebSocket protocol. Any protocol change touches both server and web.
- `order.ts` — canonical event ordering (`eventRank`) and string hash, deliberately shared so server-side sorting and client-side replay can never drift. Sort events by `(t, eventRank(type))` everywhere; never invent a local ordering.

**Web** (`web/`, vanilla TS, no framework):
- `main.ts` — builds the DOM shell, owns the WebSocket client, session picker, import/export, settings modal, playback controls.
- `engine.ts` — `parseSession` converts an `AwvSession` into a replayable `Engine`: per-agent token keyframes, parent/child tree, error windows. `tokensAt`/`statusAt` answer "state at time t" via binary search, which is what makes timeline scrubbing cheap.
- `render.ts` — `VisualRenderer`, the canvas graph (palettes, organic/radial/fixed layouts) and timeline scrubber.
- `panels.ts` — HTML for the agent rail and inspector.

**Time model**: every event carries `t`, milliseconds relative to session start. The whole replay/scrub system depends on this — never stamp clock-less transcript records with ingest wall-time (see commit 937b32b; it made agents vanish).

## Visual Design

For any visual work please use the suite of DD skills.

## Tests

Tests use `bun:test` and drive the pipeline directly: they write synthetic transcript JSONL into a temp root and call `watcher.scan()` manually with `{ watchFs: false, pollMs: <huge> }` — no timers, no real `~/.claude`. Follow `test/watch.test.ts` for the pattern when testing ingestion behaviour.

## Repo notes

- The compiled binary embeds the frontend, so anything the server needs at runtime must be reachable through imports from `scripts/cli.ts`, not loose files read from disk.
