# claude-viz

A local web app that visualises Claude Code, Codex, opencode, and GitHub Copilot coding sessions as a live animated agent graph. It watches local transcript/session stores, normalizes them into the AWV (Agentic Workflow Visualizer) schema, and streams sessions over WebSocket to a canvas frontend with timeline replay.

## Running

```bash
pnpm install
pnpm dev            # Next.js App Router dev server + local WebSocket bridge
pnpm build          # production Next.js build
pnpm start          # production server + open the UI in your browser
pnpm serve          # production server only (no browser)
```

The app serves the UI and API at `http://localhost:8787` by default. Change the port with `PORT=9876 pnpm dev` / `PORT=9876 pnpm start`, or in settings. The server binds to loopback (`127.0.0.1`) only, so transcript metadata is never exposed on your network. To bind more widely (for example on a remote/dev box), opt in with `HOST=0.0.0.0 pnpm start`.

While bound to loopback, the server rejects HTTP requests and WebSocket upgrades whose `Host` or `Origin` header is not a loopback address on the bound port. This stops a website you visit from reading your sessions over `ws://127.0.0.1:8787/ws` or via DNS rebinding. Binding with `HOST=0.0.0.0` disables the check, since remote clients legitimately send other hosts — put such a deployment behind your own auth.

`pnpm start` expects `pnpm build` to have been run first, like a standard Next.js production app. Use `CLAUDE_VIZ_NO_OPEN=1 pnpm start` to suppress the browser launch.

By default the server scans Claude Code transcripts from `~/.claude/projects`. For tests or alternate transcript roots, set:

```bash
CLAUDE_PROJECTS_DIR=/path/to/projects pnpm dev
```

## App structure

This project is now a Next.js App Router app:

- `app/layout.tsx` — root layout and metadata
- `app/page.tsx` — renders the client-side visualiser shell
- `app/globals.css` — imports the existing canvas UI stylesheet
- `app/api/**/route.ts` — route handlers for health, sessions, settings, search, and export
- `scripts/next-server.ts` — custom Node server that runs Next and upgrades `/ws` WebSocket connections
- `server/runtime.ts` — shared singleton runtime for settings, providers, store, search, and WebSocket subscribers

The visualisation UI itself is still the existing canvas app under `web/`, mounted through `web/app.tsx` as a client component. Shared wire types live in `shared/`.

## Settings

User settings persist to an OS-appropriate config dir (`~/Library/Application Support/claude-viz/settings.json` on macOS, `$XDG_CONFIG_HOME/claude-viz/` on Linux, `%APPDATA%\claude-viz\` on Windows; override with `CLAUDE_VIZ_CONFIG_DIR`): palette, layout, grid, liveness window, poll interval, per-model context limits, providers, pricing, and port.

All of these are editable from the in-app **⚙ Settings** panel. Palette and layout apply instantly; grid, liveness window, poll interval, provider toggles, and per-model context limits apply live; a changed port is saved but takes effect on the next restart.

Useful endpoints:

- `GET /api/health` — readiness probe
- `GET /api/sessions` — list discovered sessions
- `GET|PUT /api/settings` — read / update user settings
- `POST /api/search` — full-text search over indexed session docs
- `GET /api/session/<encoded-session-id>/export` — export a session as AWV JSON

## Checks

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test          # existing Bun test suite
```

Tests still use `bun:test` for the existing ingestion and UI model test suite.
