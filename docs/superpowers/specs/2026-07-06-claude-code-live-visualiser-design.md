# claude-viz — Real-time Claude Code Agent Visualiser

**Date:** 2026-07-06
**Status:** Approved design

## Purpose

Visualise Claude Code's agents live: every active session on the machine appears as a
glowing root orb; subagents and workflow agents orbit it as children; context-window
rings, tool-call flashes, message beams, compaction pulses, and error rings show what
each agent is doing in real time. Past sessions can be replayed and scrubbed.

The visual design is fixed: recreate the Claude Design mockup
(`project/Agentic Workflow Visualizer.dc.html`) pixel-faithfully — orbs, physics,
glow sprites, agent rail, inspector panel, timeline scrubber, palettes.

## Decisions (settled with user)

| Question | Decision |
|---|---|
| Data source | Tail transcript JSONL files under `~/.claude/projects/` (read-only, zero Claude Code config) |
| Scope | All live sessions at once ("mission control"), with a picker to focus one |
| Timeline | Live follows "now"; full history kept, so pause/scrub-back/replay works; past sessions replayable |
| Stack | Bun server + vanilla TypeScript/canvas frontend (port mockup engine ~1:1) |
| Simulator features | Demo scenarios dropped; JSON import/export of sessions kept |
| Architecture | Event-sourced core: server normalizes transcripts into the mockup's event schema, streams over WebSocket; UI reuses the replay engine for live and replay alike |

## On-disk source of truth (verified 2026-07-06 on this machine)

- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — main session transcript, appended live.
  Lines carry `type` (`user` / `assistant` / `summary` / housekeeping types), `uuid`,
  `parentUuid`, `timestamp`, `isSidechain`, `sessionId`, `cwd`, `version`.
- Assistant lines: `message.content[]` includes `tool_use` blocks (`name`, `input`);
  `message.usage` gives `input_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `output_tokens` — their sum is the absolute context size.
- `<sessionId>/subagents/agent-<agentId>.jsonl` — one transcript per subagent, with
  `agentId`, `slug`, `isSidechain: true`.
- `<sessionId>/subagents/agent-<agentId>.meta.json` — `{ agentType, description, toolUseId }`;
  `toolUseId` links the subagent to the parent's `Task`/`Agent` `tool_use` block.
- `<sessionId>/subagents/workflows/wf_<runId>/agent-*.jsonl` (+ `.meta.json`) — workflow
  fan-out agents, one level deeper.
- Housekeeping line types (`ai-title`, `attachment`, `file-history-snapshot`, `mode`, etc.)
  are ignored.

## Architecture

One Bun package, three parts:

```
claude-viz/
  shared/   event schema + protocol types (imported by both sides)
  server/   scanner, tailer, normalizer, WebSocket + static HTTP server
  web/      canvas UI ported from the mockup (vanilla TS, bundled by Bun)
```

`bun start` boots everything on localhost; open one URL.

### Server

**Scanner.** Polls `~/.claude/projects/*/` (configurable root). A session whose transcript
mtime is within the liveness window (default 5 min) is "live"; all sessions are listed as
replayable history with project name, slug/title, and last-active time.

**Tailer.** Per file: byte offset + incremental reads of appended data, line-buffered JSONL
parse (`fs.watch` with polling fallback, debounced). Watches each live session's
`subagents/` and `subagents/workflows/wf_*/` directories so newly created agent files
hot-join the stream. Truncation (size < offset) resets the offset and re-parses.

**Normalizer.** Pure function: JSONL lines in → AWV events out. Mapping:

| Transcript observation | AWV event |
|---|---|
| Session file first line | `spawn` root agent (name = project dir + session title/slug) |
| New `agent-*.jsonl` + meta.json | `spawn` child (parent = session root; for `wf_*` agents the parent is a synthetic workflow-run agent node spawned when the `wf_` directory first appears), name = `agentType` + `description` |
| `tool_use` block in assistant message | `tool` (tool = block name, label = short input summary) |
| Consecutive `usage` totals diff > 0 | token delta split across that assistant message's emitted events (attached to its `tool` events; if it emitted none, to a `message` event) so the engine's keyframe sum matches the real total |
| Consecutive `usage` totals diff strongly negative | `compact` (to = new absolute total) |
| User prompt line (non-tool-result) | `message` external → root (label = truncated prompt) |
| Subagent's final result / parent's matching `tool_result` | `message` child → parent, then `complete` child |
| `tool_result` with `is_error: true` | `error` (label = truncated error); next successful event clears it (existing engine behaviour) |

Notes:
- Agent context ring = absolute usage sum vs the model's context limit (default 200k,
  configurable per model).
- Root sessions never emit `complete`; the UI derives an **idle** dim state from
  time-since-last-event.
- Event `t` is ms since session start (keeps the mockup engine unmodified); each event
  also carries wall-clock `ts`.
- Only names, labels, tool names, and token counts leave the server. Message content
  never does (labels are short truncations of prompts/errors only).

**Protocol.** WebSocket:
- on connect → `{type:'sessions', sessions:[...]}`, kept updated
- `subscribe {sessionIds | 'all-live'}` → `{type:'snapshot', sessionId, agents, events}` per
  session (streamed in chunks for large transcripts), then `{type:'events', sessionId, events}` batches
- client resync after reconnect: sends last event index per session, server replays the gap

HTTP: static UI; `GET /api/sessions`; `GET /api/session/:id/export` → standalone AWV JSON
(same shape the mockup's editor consumed: `{name, desc, agents, events}`).

### Frontend

Port of the mockup's engine, kept intact: canvas orbs + glow sprites, force-directed /
radial / fixed layouts, agent rail, inspector (context ring, skills/tools used, sub-agents,
event log), timeline canvas, palettes, keyboard shortcuts.

Changes from the mockup:
- **Session picker** replaces the scenario dropdown: "All live sessions" (default) pins
  every live session as a root orb; below it, recent past sessions open as replays.
- **LIVE mode:** playhead pinned to now as events stream in. Scrubbing/stepping back
  detaches; a `● LIVE` button re-snaps. Speed buttons apply to replay only.
- **Import / Export** replace the "define workflow" editor: export any session as AWV
  JSON; import such a file (or drag-drop) to replay it. Demo scenarios removed.
- Timeline spans the session's real duration (minutes–hours), rendered as relative time.
- Idle root sessions dim (derived, not an event).

## Error handling

- Malformed/unknown JSONL lines: skip; count per type; log once per type.
- Watcher misses (editor-style atomic writes, rotation): offset/truncation logic re-reads.
- WS disconnect: client auto-reconnects and resyncs from last event index.
- Large transcripts (multi-MB): initial parse is incremental; snapshot streamed in chunks.
- Missing meta.json (race with file creation): retry read on next tick; agent appears with
  slug-derived name until meta arrives.

## Testing

- **Normalizer golden tests:** fixture JSONL files captured from real transcripts
  (main session, subagents, workflow run, compaction, tool error) → expected AWV event
  lists checked in. Run with `bun test`.
- **Tailer integration test:** temp dir, simulated appends/truncation/new-file creation,
  assert emitted event order.
- **Manual verification:** run against a real Claude Code session that spawns subagents;
  confirm spawn beams, tool flashes, ring growth, compaction pulse, completion, idle dimming.

## Out of scope (v1)

- Writing anything to Claude Code config; hooks; OpenTelemetry.
- Cost/pricing display, multi-machine aggregation, auth (localhost only).
- Historical search/analytics across sessions.
