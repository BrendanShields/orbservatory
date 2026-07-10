# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## What this is

**claude-viz** — a local Next.js App Router web app that visualises Claude Code, Codex, opencode, and GitHub Copilot sessions as a live animated agent graph. It watches transcript/session stores, normalizes them into the AWV (Agentic Workflow Visualizer) schema, and streams sessions over WebSocket to a canvas frontend with timeline replay.

The app runtime is **Next.js on Node** with a small custom server for `/ws`; the test suite still uses **Bun** (`bun test`).

## Commands

```bash
pnpm dev                    # Next dev + custom /ws server + open browser
pnpm build                  # production Next build
pnpm start                  # production custom server + open browser (run build first)
pnpm serve                  # production server only (no browser)
pnpm typecheck             # tsc --noEmit
pnpm lint                  # ESLint / Next lint rules
pnpm test                  # bun test
bun test test/store.test.ts # one test file
bun test -t "pattern"       # tests matching name
```

Environment variables: `PORT`, `HOST` (defaults to `127.0.0.1` — loopback-only is a deliberate privacy choice, don't widen it casually), `CLAUDE_PROJECTS_DIR` (alternate Claude transcript root, used by tests), `CLAUDE_VIZ_CONFIG_DIR` (settings location), `CLAUDE_VIZ_NO_OPEN=1` (suppress browser launch).

## Architecture

Data flows one way: transcript/session store → provider → normalizer → store → WebSocket/API → engine → renderer.

**Next app** (`app/`):
- `layout.tsx` — root metadata and global CSS import.
- `page.tsx` — renders `web/app.tsx`, a client component that mounts the existing canvas app.
- `api/**/route.ts` — App Router route handlers for `/api/health`, `/api/sessions`, `/api/settings`, `/api/search`, and `/api/session/:id/export` (implemented as catch-all `[...parts]` because session IDs can contain slashes).

**Runtime/server** (`server/`, `scripts/next-server.ts`):
- `scripts/next-server.ts` — Node HTTP server that delegates regular requests to Next and upgrades `/ws` to a `ws` WebSocket server. Do not use bare `next start` for the live app unless you also replace the WebSocket bridge.
- `runtime.ts` — process singleton that owns `SettingsStore`, `SessionStore`, provider startup, search, API helpers, and WebSocket subscribers. Route handlers and the custom WS server both use this singleton.
- `providers/*` — provider-specific discovery/tailing for Claude, Codex, opencode, and Copilot. File slicing uses `server/fileSlice.ts`; opencode SQLite access is isolated behind `providers/opencode-db.ts`.
- `normalizer.ts` and provider normalizers — convert raw provider records into AWV agents/events.
- `store.ts` — holds per-session state, merges normalized batches, computes/broadcasts stats, and snapshots sessions.
- `settings.ts` / `config.ts` — persisted user settings vs resolved runtime config.

**Shared** (`shared/`):
- `schema.ts` — AWV wire types and the `ClientMessage`/`ServerMessage` WebSocket protocol. Any protocol change touches both server and web.
- `order.ts` — canonical event ordering (`eventRank`) and string hash, deliberately shared so server-side sorting and client-side replay cannot drift. Sort events by `(t, eventRank(type))` everywhere; never invent a local ordering.

**Web** (`web/`):
- `app.tsx` — client component wrapper for the existing canvas UI.
- `main.ts` — `mountApp(container)`, builds the DOM shell, owns WebSocket client, session picker, import/export, settings modal, playback controls.
- `engine.ts` — `parseSession` converts an `AwvSession` into a replayable `Engine`: per-agent token keyframes, parent/child tree, error windows. `tokensAt`/`statusAt` answer "state at time t" via binary search for cheap scrubbing.
- `render.ts` — `VisualRenderer`, the canvas graph and timeline scrubber.
- `home.ts`, `homeModel.ts`, `panels.ts`, `palette.ts`, `settingsModal.ts` — home/search, inspector, command palette, and settings UI.

**Time model**: every event carries `t`, milliseconds relative to session start. The whole replay/scrub system depends on this — never stamp clock-less transcript records with ingest wall-time.

## Visual Design

For visual work, use the DD skills where appropriate.

## Tests

Tests use `bun:test` and drive the pipeline directly: they write synthetic transcript JSONL into a temp root and call `watcher.scan()` manually with `{ watchFs: false, pollMs: <huge> }` — no timers, no real `~/.claude`. Follow `test/watch.test.ts` for the pattern when testing ingestion behaviour.

Run the full validation set before handing off runtime changes:

```bash
pnpm typecheck
pnpm build
pnpm test
```
