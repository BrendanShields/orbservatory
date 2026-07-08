# CODING AGENTS: READ THIS FIRST

This is a **handoff bundle** from Claude Design (claude.ai/design).

A user mocked up designs in HTML/CSS/JS using an AI design tool, then exported this bundle so a coding agent can implement the designs for real.

## What you should do — IMPORTANT

**Read `agentic-workflow-visualizer/project/Agentic Workflow Visualizer.dc.html` in full.** The user had this file open when they triggered the handoff, so it's almost certainly the primary design they want built. Read it top to bottom — don't skim. Then **follow its imports**: open every file it pulls in (shared components, CSS, scripts) so you understand how the pieces fit together before you start implementing.

**If anything is ambiguous, ask the user to confirm before you start implementing.** It's much cheaper to clarify scope up front than to build the wrong thing.

## About the design files

The design medium is **HTML/CSS/JS** — these are prototypes, not production code. Your job is to **recreate them pixel-perfectly** in whatever technology makes sense for the target codebase (React, Vue, native, whatever fits). Match the visual output; don't copy the prototype's internal structure unless it happens to fit.

**Don't render these files in a browser or take screenshots unless the user asks you to.** Everything you need — dimensions, colors, layout rules — is spelled out in the source. Read the HTML and CSS directly; a screenshot won't tell you anything they don't.

## Bundle contents

- `agentic-workflow-visualizer/README.md` — this file
- `agentic-workflow-visualizer/project/` — the `Agentic workflow visualizer` project files (HTML prototypes, assets, components)

## Running the implemented app

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
