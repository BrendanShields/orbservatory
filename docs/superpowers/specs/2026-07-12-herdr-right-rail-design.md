# Herdr Right-Rail Panes — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending implementation plan
**Sub-project 1 of 4** in the herdr dev-environment ecosystem roadmap.

## Roadmap context

The broader goal is a dev environment that behaves as one interworking ecosystem,
with herdr (third-party agent multiplexer, brew-installed, AGPL) as the hub.
Herdr is evolved via its plugin/hook surface, not a fork. Agreed build order:

1. **Right-rail panes** (this spec) — auto-spawned observability panes per Claude session
2. **Attention routing** — "needs me" queue + blocked-agent escalation
3. **Fleet overview** — all workspaces, all agents, one tab
4. **Event bus** — extracted, not built upfront: orbservatory's runtime grows into
   the bus as consumers accumulate; when a third consumer appears, formalize the
   protocol. No speculative protocol design.

Each sub-project gets its own spec → plan → implementation cycle.

## What this builds

When a Claude Code session starts inside herdr, a right-hand rail of two panes
appears automatically in the current tab:

- **Stats pane** (`orb-stats`): agent state, model, tokens in/out, cost estimate,
  context % until compaction, tool-call counts, elapsed time.
- **Tasks pane** (`orb-tasks`): the session's live task list with status glyphs.

Both are thin terminal clients of orbservatory (this repo), which already
watches and normalizes agent transcripts. A quick action deep-links from the
current pane's session to the full orbservatory canvas graph in the browser.

## Architecture

```
Claude SessionStart hook (herdr-rail.sh)
  ├─ ensure orbservatory running (GET /api/health; if down, start detached
  │    with ORBSERVATORY_NO_OPEN=1)
  ├─ idempotency: rail panes already in this tab (labels rail:stats /
  │    rail:tasks)? → retarget to new session, exit
  └─ else:
       herdr pane split <claude-pane> --direction right --ratio 0.25 --no-focus
       herdr pane split <rail-pane> --direction down --ratio 0.5 --no-focus
       herdr pane rename …  (rail:stats / rail:tasks)
       herdr pane run <id> "orb-stats --session <session-id>"
       herdr pane run <id> "orb-tasks --session <session-id>"

orb-stats / orb-tasks ──ws /ws──▶ orbservatory runtime ──▶ transcript tailing
                                                            (existing)
```

- The hook receives `session_id` and `transcript_path` in the SessionStart
  hook input — no discovery needed.
- Data flows one way, matching orbservatory's existing architecture:
  transcript → provider → normalizer → store → WS → TUI renderer.

## Components

### 1. `herdr-rail.sh` — SessionStart hook

New script installed beside the existing `herdr-agent-state.sh` (which herdr
manages; custom hooks live beside it, per its header comment). ~80 lines of
POSIX shell.

- Guards, in order: `HERDR_ENV=1`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` set,
  `HERDR_RAIL` not `0`, `herdr` on PATH. Any guard fails → `exit 0`.
- Always exits 0. A broken rail must never break Claude startup.
- Idempotency: `herdr pane list` filtered to the current tab; panes labeled
  `rail:stats` / `rail:tasks` present → send retarget (re-run TUI command with
  new session id via `herdr pane run`) instead of splitting again.
- Server start: if `/api/health` unreachable, launch the production server
  detached from the claude-visualiser checkout (path from `ORB_HOME`, default
  `~/dev/1-Projects/claude-visualiser`), then poll health briefly (~3s cap).
  Still down → exit 0 silently, no rail this session.
- Port resolution (hook and TUIs alike): `PORT` env if set, else `port` from
  orbservatory's settings file, else the default `8787` — mirroring the
  server's own resolution order in `server/config.ts`.

### 2. `tui/` package (this repo)

Two Node CLI entry points, `orb-stats` and `orb-tasks`, sharing one small WS
client module. Plain ANSI escape rendering — full-repaint-on-update into the
alternate screen buffer. No ink/blessed dependency unless plain rendering
proves insufficient.

- Connect to `ws://127.0.0.1:<port>/ws`, subscribe to the given session id.
- Render loop is a pure function `(sessionState) → frame string`; the shell
  around it handles WS lifecycle and terminal setup/teardown.
- `--session <id>` required. Retargeting to a new session is a process
  restart: the hook's `pane run` re-invocation replaces the running TUI.
  No in-process session switching in v1 — processes are cheap.
- Stats shown: state (idle/working/blocked), model, tokens in/out (from
  existing `usageByModel`), estimated cost, context % to compaction (existing
  compaction tracking), tool-call counts, elapsed.
- Tasks shown: subject, status glyph (pending ○ / in-progress ◐ / done ●),
  ordered as created.

### 3. Orbservatory extension — task-list events

The claude normalizer does not currently extract task-list state. Add:

- Parse `TodoWrite` / `TaskCreate` / `TaskUpdate` tool calls in the claude
  provider's records into a per-session task-list snapshot.
- Expose the snapshot in the session stream consumed over WS (additive field;
  no breaking change to the AWV schema consumers).

This is the only new server-side surface.

### 4. Deep-link quick action

A herdr-plus quick action (or keybinding invoking a one-line script):
current pane → agent session id (`herdr pane current` / `herdr agent get`) →
`open http://127.0.0.1:<port>/?session=<id>`. Full canvas graph in browser;
the rail stays terse.

## Behavior decisions

| Situation | Behavior |
|---|---|
| Second Claude session starts in same tab | Rail retargets to newest session. `ponytail:` newest-wins; add follow-focus mode only if this annoys in practice. |
| Session ends | Rail panes persist; TUIs render a "session ended" state. No auto-teardown in v1. |
| Focus | Rail never steals focus (`--no-focus` on every split/run). |
| Opt-out | `HERDR_RAIL=0` in the environment. |
| Rail already exists | Reused, never duplicated (idempotent hook). |

## Error handling

- Orbservatory unreachable and unstartable → hook exits silently; session runs
  with no rail.
- Pane split fails (e.g. window too narrow) → skip silently, exit 0.
- WS drops mid-session → TUI reconnects with capped exponential backoff,
  renders a "reconnecting…" line meanwhile.
- Malformed/missing task tool records → task pane shows what parses; never
  crashes the stream.

## Testing

- **TUI render logic**: pure `(state) → frame` functions under `bun test`,
  matching the repo's existing test setup. Cover: empty session, active session
  with tasks, ended session, reconnecting state.
- **Normalizer task extraction**: fixture-based test beside existing provider
  tests (transcript JSONL in → expected task snapshot out).
- **Hook**: `shellcheck` clean; manual idempotency check — trigger twice in one
  tab, exactly one rail results.
- **End-to-end**: start a Claude session inside herdr; rail appears, stats
  tick, task list updates when the session creates tasks.

## Out of scope (v1)

- Auto-teardown of rail panes on session end.
- Follow-focus retargeting across multiple sessions in a tab.
- Non-Claude providers in the rail TUIs (orbservatory supports them; the rail
  hook is Claude's — codex/opencode hooks can come later).
- Attention routing, fleet overview, formal event bus (sub-projects 2–4).
