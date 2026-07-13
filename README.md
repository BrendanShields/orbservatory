# orbservatory

A local web app that visualises Claude Code sessions as a live animated agent graph. It watches your local transcripts, normalizes them into the AWV (Agentic Workflow Visualizer) schema, and streams sessions over WebSocket to a canvas frontend with timeline replay.

## Install

```bash
npx orbservatory          # run it without installing
npm install -g orbservatory && orbservatory
```

### From a clone (web app + terminal UIs)

```bash
git clone https://github.com/BrendanShields/orbservatory
cd orbservatory
node scripts/install.mjs
```

Checks your Node version (>= 20.9), installs dependencies with pnpm (or npm if pnpm is missing), and tells you if Bun is missing. The web app needs only Node; the terminal UIs below also need [Bun](https://bun.com).

## Terminal UIs

Live panes for a single Claude Code session, rendered with OpenTUI (works in ghostty, iTerm2, Windows Terminal). The server must be running (`pnpm start` or `npx orbservatory`):

```bash
bun tui/orb-stats.ts --session <claude-session-id>   # state, context bar, tokens, cost, tools
bun tui/orb-tasks.ts --session <claude-session-id>   # live task list
```

## Running from source

```bash
pnpm install
pnpm dev            # Next.js App Router dev server + local WebSocket bridge
pnpm build          # production Next.js build
pnpm start          # production server + open the UI in your browser
pnpm serve          # production server only (no browser)
```

The app serves the UI and API at `http://localhost:8787` by default. Change the port with `PORT=9876 pnpm dev` / `PORT=9876 pnpm start`, or in settings. The server binds to loopback (`127.0.0.1`) only, so transcript metadata is never exposed on your network. To bind more widely (for example on a remote/dev box), opt in with `HOST=0.0.0.0 pnpm start`.

While bound to loopback, the server rejects HTTP requests and WebSocket upgrades whose `Host` or `Origin` header is not a loopback address on the bound port. This stops a website you visit from reading your sessions over `ws://127.0.0.1:8787/ws` or via DNS rebinding. Binding with `HOST=0.0.0.0` disables the check, since remote clients legitimately send other hosts — put such a deployment behind your own auth.

`pnpm start` expects `pnpm build` to have been run first, like a standard Next.js production app. Use `ORBSERVATORY_NO_OPEN=1 pnpm start` to suppress the browser launch.

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
- `server/runtime.ts` — shared singleton runtime for settings, the transcript watcher, store, search, and WebSocket subscribers

The visualisation UI itself is still the existing canvas app under `web/`, mounted through `web/app.tsx` as a client component. Shared wire types live in `shared/`.

## Settings

User settings persist to an OS-appropriate config dir (`~/Library/Application Support/orbservatory/settings.json` on macOS, `$XDG_CONFIG_HOME/orbservatory/` on Linux, `%APPDATA%\orbservatory\` on Windows; override with `ORBSERVATORY_CONFIG_DIR`): palette, layout, grid, liveness window, poll interval, per-model context limits, pricing, and port.

All of these are editable from the in-app **⚙ Settings** panel. Palette and layout apply instantly; grid, liveness window, poll interval, and per-model context limits apply live; a changed port is saved but takes effect on the next restart.

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
