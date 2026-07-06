# claude-viz — Implementation Plan

Companion to `2026-07-06-claude-code-live-visualiser-design.md`.

## Layout

```
claude-viz/
  package.json  tsconfig.json
  shared/schema.ts        AWV event + agent types, WS protocol messages
  server/
    normalizer.ts         pure: transcript JSONL lines → AWV events (the core)
    watch.ts              project scanner + per-session tailer (fs.watch + poll fallback)
    store.ts              per-session accumulated agents/events, subscriber fan-out
    index.ts              Bun.serve: static UI (Bun.build at boot), /api, WebSocket
  web/
    index.html            shell + styles (ported from mockup)
    main.ts               boot, WS client, view state (live pinning, session picker)
    engine.ts             parse/keyframes/tokensAt/statusAt (ported, + idle status)
    render.ts             canvas orbs/edges/effects/timeline (ported ~verbatim)
    panels.ts             agent rail + inspector DOM (incremental updates)
  test/
    normalizer.test.ts    golden tests over fixtures
    fixtures/*.jsonl      synthetic lines matching the verified schema
```

## Phases

1. **Scaffold + schema** — package.json (bun), tsconfig, `shared/schema.ts`.
2. **Normalizer + tests** — per-line mapping (spawn/tool/message/compact/error/complete,
   usage-diff token deltas, Task/Workflow linking via toolUseId, ai-title naming).
   Golden fixtures: plain session, subagent lifecycle, workflow fan-out, compaction, tool error.
   Verify: `bun test`.
3. **Watcher + store + server** — scanner (live = mtime < 5 min), tailer (byte offsets,
   partial-line buffering, truncation reset, subagents/workflows dir discovery),
   WS protocol (sessions list / subscribe / snapshot / event batches, 250 ms flush),
   `/api/sessions`, `/api/session/:id/export`. Verify: boot, curl endpoints against real
   transcript dir.
4. **Web UI port** — canvas engine and panels from the mockup; session picker replaces
   scenario dropdown; LIVE pin + scrub-back detach; import/export; timeline handles
   hour-scale durations; idle dimming for quiet roots. Verify: load a replayed real session.
5. **End-to-end live** — run against this machine's active session; confirm spawn beams,
   ring growth from real usage, tool flashes, subagent orbit, completion, idle.
6. **Commit** after each phase.

## Deliberate v1 simplifications

- Polling (1.5 s) is the primary change detector with `fs.watch` as an accelerator —
  robust against editors/atomic writes; latency well under the 130 ms UI tick × a few.
- Client re-runs `parse()` on each event batch (cheap at ≤ tens of k events) instead of
  incremental keyframe surgery; node positions/camera live outside the engine and persist.
- Assistant text-only turns emit `message → self` ("reply") to carry token growth; no
  `retry` events are synthesized (engine clears errors on next activity anyway).
- Layout select (organic/radial/fixed) + palette select in header; no other prop surface.
