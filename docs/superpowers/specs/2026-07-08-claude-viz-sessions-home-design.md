# claude-viz Sessions Home — design spec

**Date:** 2026-07-08
**Status:** Approved, ready for implementation plan

## Problem

Session navigation today is a single flat `<select>` grouped by project (`web/main.ts:176`). It answers "which session" and nothing else. There's no way to review sessions for harness/workflow improvement, no way to navigate by complexity, cost, tool use, or skills invoked, and no aggregate stats.

We want claude-viz to become a tool for **reviewing** sessions — spotting where a harness or workflow can improve — with a filterable dashboard and fast navigation across the axes that matter: complexity, cost, tool use, skills invoked.

## Goals

- A browsable, filterable **Sessions Home** that is the default landing surface.
- Fast quick-switch (⌘K) from anywhere.
- Per-session metrics: complexity tier, cost (tokens + optional $), tool use, skills invoked, subagents, model, status, duration.
- A reactive aggregate dashboard plus activity trends.
- Metadata **and** full-text search.
- Keep the existing graph/timeline detail view intact.

## Non-goals

- No change to the graph engine, renderer, or replay/scrub model (`web/engine.ts`, `web/render.ts`).
- No remote/cloud sync — stays loopback-only, local-first.
- No auth, multi-user, or export changes beyond what already exists.

## Surfaces

1. **Home** — new default landing. Dashboard + browsable session list. The current "all-live merged graph" stops being the default and becomes a "Watch all live" action on Home.
2. **⌘K quick-switch** — overlay available anywhere. Type → search (metadata + full-text) → arrow/enter → open. No dashboard; just jump.
3. **Graph detail** — existing canvas / timeline / rail / inspector, unchanged. Adds a "← Home" affordance + breadcrumb.

## Home layout (top → bottom)

1. **Search + filter row.** Free-text box (shares the ⌘K query engine) plus facet chips: project, model, status, tier, skill, tool, live-only, date range; range sliders for tokens/$ and subagent count. A sort control.
2. **Aggregate strip — reactive to the active filter.** Tiles recompute for the filtered set: session count, total tokens (with cache split), estimated $, tool calls, subagents, average tier, top skills, top tools, model split.
3. **Trends (collapsible).** Calendar activity heatmap, per-day sparklines (tokens/$, session count), skill-usage trend.
4. **Session list.** Sortable table/cards with columns: title, project, when, duration, **tier badge**, subagents, tool calls, tokens/$, skill chips, model, status. Row click → graph detail. Fully keyboard-navigable.

## Pinned metric definitions

### Complexity tier

Bucketed from `subagentCount` + `toolCalls` (+ `compactions`). Starting thresholds (tunable in settings):

- **Simple** — 0 subagents and < 15 tool calls.
- **Complex** — ≥ 2 subagents, or ≥ 60 tool calls, or any compaction present.
- **Moderate** — everything in between.

The badge is a glance/sort handle only; the raw underlying numbers are always shown beside it, so the badge is never a black box. No composite 0–100 score.

### Cost

- **Tokens always.** Total with cache split: `input`, `output`, `cache_read`, `cache_creation`. This is the default cost axis.
- **Dollars when configured.** A new `Settings.pricing` map (per-model rates, JSON-editable in the existing settings modal exactly like `contextLimits`) turns tokens into $. Sessions with a model absent from the map show tokens only, no $. Mixed-model sessions sum $ per model.

## Data model

New shared type (sketch — final shape settled in the plan):

```ts
interface SessionStats {
  sessionId: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number; total: number };
  costUsd?: number;               // present only when every used model is in the pricing map
  toolCalls: number;
  toolBreakdown: Record<string, number>;   // by tool name
  distinctTools: number;
  skills: Record<string, number>;          // skill name → invocation count
  subagentCount: number;
  treeDepth: number;
  compactions: number;
  retries: number;
  errors: number;
  userTurns: number;
  durationMs: number;
  models: string[];
  firstActive: number;
  lastActive: number;
  tier: 'simple' | 'moderate' | 'complex';
  partial?: boolean;              // set when the transcript couldn't be fully parsed
}
```

`SessionSummary` stays as-is (cheap) so first paint is instant; stats arrive separately and progressively.

## Architecture

Computing tokens / tools / skills / tier / full-text per historical session requires a **full parse** — today's "peek" (bounded head+tail, `server/watch.ts:162`) is insufficient. To keep Home fast without re-parsing everything on every launch:

**Server (new/changed):**

- `server/stats.ts` — pure `computeSessionStats(normalizerState) → SessionStats`. Live and historical both funnel through it; live is near-free because the normalizer state is already fully parsed.
- `server/statsCache.ts` — disk sidecar under `CLAUDE_VIZ_CONFIG_DIR`, keyed by source file `mtime + size` (plus the subagent/workflow file set). Valid → instant; stale/missing → recompute. Never serves stats for a changed file.
- `server/searchIndex.ts` — the same full-parse pass that computes stats also extracts searchable text (user prompts, assistant text, tool names/inputs, skill names) into a compact cached blob — one read, two outputs. `POST /api/search {q, filters}` returns matching session ids + snippet + matched field. Debounced client-side; server scan is concurrency-bounded with a timeout and a partial-results signal.
- `server/watch.ts` — gains a background full-parse mode for historical sessions (beyond peek), bounded concurrency, feeding stats + index cache. Peek stays for the instant cheap summary.
- `server/index.ts` — new `POST /api/search`; stats streamed over WS.
- `shared/schema.ts` — add `SessionStats`, a new WS `stats` message streamed per session as it becomes ready, and search request/response types. Any protocol change touches both server and web (per repo convention).

**Web (new):**

- `web/home.ts` — the Home view (dashboard + list + filters).
- `web/palette.ts` — the ⌘K quick-switch overlay.
- `web/stats-viz.ts` — stat tiles, sparkline, heatmap, mini-bars, tier badge.
- `web/homeModel.ts` — **pure** filter/sort/aggregate functions over the streamed stats set. No DOM. Unit-testable.
- `web/main.ts` — refactored into a router between Home and Graph detail; owns ⌘K; wires search. `engine.ts` / `render.ts` untouched.

**Filtering, sorting, and aggregation happen client-side** over the streamed stats (snappy, no round-trips). Only full-text search hits the server, because it needs file content the client doesn't hold.

## Data flow

```
transcript files
  → watcher            (peek → cheap summary; background full-parse → stats + search text, cached by mtime+size)
  → store
  → WS  ('sessions' cheap summaries first; 'stats' streamed per session; 'settings')
     + REST ('POST /api/search')
  → web Home           (client-side filter / sort / aggregate; server for full-text)
  → click a session
  → existing Graph engine / renderer  (unchanged)
```

First paint shows the session list from cheap summaries with skeleton stat cells; stats fill in progressively as cache hits return instantly and background parses complete.

## Visual execution

Tiles / KPI row / heatmap / sparklines follow the **dataviz** skill (built before writing chart code). Motion and interaction follow the **DD** (Devouring Details) skills. Everything must sit inside the existing dark theme and selected palette.

## Error handling

- **Partial/corrupt transcript** — stats are best-effort and flagged `partial`; the card shows a subtle "incomplete" marker rather than failing. Consistent with the normalizer's existing tolerance for out-of-order and partial input.
- **Cache staleness** — guarded by `mtime + size`; a changed file always recomputes. Never serves wrong stats.
- **Missing pricing** — a model absent from the pricing map shows tokens only, no $. No error.
- **Large search** — bounded concurrency + timeout; returns partial results with a "still scanning" state rather than hanging.
- **Empty states** — distinct copy for no sessions, no matches, and no pricing configured.

## Testing

Follow the existing pattern: write synthetic transcript JSONL into a temp root and call `watcher.scan()` with `{ watchFs: false, pollMs: <huge> }` — no timers, no real `~/.claude` (see `test/watch.test.ts`).

- `test/stats.test.ts` — token sums, tool breakdown, skill counts, subagent count, tree depth, compaction/retry/error counts, tier bucketing, cost with and without pricing, `partial` flagging.
- `test/statsCache.test.ts` — cache hit, miss, and invalidation when `mtime`/`size` changes.
- `test/searchIndex.test.ts` — index build, query match, snippet extraction, and intersection with metadata filters.
- Extend protocol/resume tests for the new WS `stats` message.
- `test/homeModel.test.ts` — the pure web filter/sort/aggregate functions, exercised without a DOM.

## Phasing (for the implementation plan)

The scope is large; ship it in shippable slices:

- **P1** — `SessionStats` compute + cache + WS streaming; minimal Home (list, tier, tokens, reactive aggregate tiles, metadata filters/sort, click-through to graph); ⌘K metadata quick-switch.
- **P2** — cost $ (pricing map + settings UI); skills/tools facets; model split tile.
- **P3** — trends (heatmap + sparklines + skill-usage trend); full-text search.

Each phase leaves Home fully usable.
