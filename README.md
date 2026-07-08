# claude-viz

A local web app that visualises Claude Code sessions as a live animated agent
graph. It watches transcript JSONL files under `~/.claude/projects`, normalizes
them into the AWV (Agentic Workflow Visualizer) schema, and streams sessions
over WebSocket to a canvas frontend with timeline replay.

## Running

```bash
bun start          # launch server + open the UI in your browser
bun run serve      # launch server only (no browser)
bun run dev        # watch mode with HMR
```

The app serves the canvas UI and WebSocket API at `http://localhost:8787` by default.
The frontend is bundled from `web/index.html` at boot (no separate build step); a slow or
occupied port can be changed with `PORT=9876 bun start` or in settings.

The server binds to loopback (`127.0.0.1`) only, so transcript metadata is never
exposed on your network. To bind more widely (e.g. a remote/dev box), opt in with
`HOST=0.0.0.0 bun start`.

By default the server scans Claude Code transcripts from `~/.claude/projects`.
For tests or alternate transcript roots, set:

```bash
CLAUDE_PROJECTS_DIR=/path/to/projects bun start
```

### Distributing

```bash
bun run build:bin          # single self-contained binary for this platform → dist/
bun run build:bin --all    # darwin-arm64, darwin-x64, linux-x64, windows-x64
```

The compiled binary embeds the frontend, so it runs anywhere without the source tree.
It is also publishable as an npm `bin` (`bunx claude-viz`).

### Settings

User settings persist to an OS-appropriate config dir
(`~/Library/Application Support/claude-viz/settings.json` on macOS,
`$XDG_CONFIG_HOME/claude-viz/` on Linux, `%APPDATA%\claude-viz\` on Windows; override with
`CLAUDE_VIZ_CONFIG_DIR`): palette, layout, grid (off by default), liveness window, poll
interval, per-model context limits, and port.

All of these are editable from the in-app **⚙ Settings** panel. Palette and layout
apply instantly; grid, liveness window, poll interval, and per-model context limits
apply live; a changed port is saved but takes effect on the next restart. Settings
can also be changed directly via `PUT /api/settings` (see below) or by editing
`settings.json`.

Useful endpoints:

- `GET /api/health` — readiness probe
- `GET /api/sessions` — list discovered Claude sessions
- `GET|PUT /api/settings` — read / update user settings
- `GET /api/session/<encoded-session-id>/export` — export a session as AWV JSON
