# Insights page — design

**Date:** 2026-07-12 · **Status:** approved · **Ships as:** its own worktree/PR, branched from `feat/pi-provider-hardening`; can merge independently of the transcript pane

## Purpose

Home's Insights zone shows totals for the current filter set only. There is no view of usage **over time** — cost per day, token burn by model, cache efficiency trends. Add a dedicated trends page.

## Decisions (user-approved)

- Placement: **dedicated `#/insights` route** (not inside the home zone). Entry point: "Trends →" button in the home Insights zone header. Esc returns home.
- Pure client feature: aggregates the `SessionStats[]` the WS `stats` stream already delivers. **Zero new server work.**
- Day attribution: a session's whole totals attribute to the local-midnight day of `stats.lastActive`. Known approximation for multi-day sessions; acceptable for v1 and documented in the UI tooltip.

## Architecture

```
WS 'stats' stream (existing)
  → statsById map in web/main.ts (existing)
  → bucketByDay(stats, summaries, opts)  [web/insightsModel.ts — pure]
  → InsightsView renders canvas charts   [web/insights.ts]
```

### Routing (`web/main.ts`)

- `parseRoute`: `#/insights` → `{ view: 'insights' }`, third top-level view. Home and graph roots hidden; new `#insightsRoot` container shown.
- View subscribes to nothing extra — reuses the `sessions`/`stats` maps main.ts already maintains; re-renders via a sibling `scheduleInsights` debounce (same 200ms pattern as `scheduleHome`).
- Esc → `location.hash = ''`.

### Aggregation (`web/insightsModel.ts`, pure functions)

```ts
interface DayBucket {
  day: string;                 // YYYY-MM-DD local
  tokens: TokenTotals;
  costByModel: Record<string, number>;  // only sessions with costUsd
  sessions: number;
  toolCalls: number;
  cacheRate: number | null;    // cacheRead / (input + cacheRead), null when denominator 0
  analysed: number;            // sessions with statsBase present
}
bucketByDay(stats: SessionStats[], summaries: SessionSummary[], opts: { days: 7|30|90; project?: string }): DayBucket[]
```

- Local-midnight bucketing (DST-safe: iterate calendar days via `Date(y,m,d)`, not epoch÷86400).
- Future-clamped: `lastActive` beyond now clamps to today.
- Sessions without stats yet (background parse pending) are excluded from sums; page header shows "n analysed / m total".
- Project filter matches home's project facet values (`projectName || project`).

### Page (`web/insights.ts`)

Same mount/update shape as `HomeView`. Layout: header (back link, range picker 7/30/90, project select) + chart stack:

1. **Tokens per day** — stacked bars: input / output / cacheRead / cacheCreation, colors from the existing split-bar tokens (`--viz-in`, `--viz-out`, dims).
2. **Cost per day by model** — stacked bars per model (palette hashed like agent colors); rendered only when pricing is configured, otherwise a hint row: "add pricing in ⚙ settings".
3. **Activity per day** — sessions bars + tool-calls line overlay (right axis).
4. **Cache hit-rate** — line chart of `cacheRate`, gaps for null days.

Chart rendering: hand-drawn canvas-2d (no dependency), one shared `drawChart` helper handling dpr, axes, hover. Theme-aware via existing CSS tokens read from `getComputedStyle`. Hover → tooltip (`.tl-tip` styling) with exact values + "day of last activity" note. Empty range → `.home-empty`-style message.

## Edge cases

- No sessions / all stats pending → empty state with "waiting for background analysis".
- One giant session dominating a day: expected with lastActive attribution; tooltip shows session count so it reads sanely.
- Range longer than data: leading empty days render as zero bars (keeps bar widths stable).
- Reduced motion: no chart entrance animations.

## Testing

- `insightsModel` unit tests: bucketing across a DST transition, range edges (day 0 / today), project filter, cache-rate math (null denominator), cost aggregation when only some sessions priced, future-timestamp clamping.
- Chart drawing untested (canvas, same policy as `render.ts`).
- `pnpm typecheck && pnpm build && bun test` before handoff.

## Worktree overlap with the transcript pane

This branch: new `web/insights.ts`, `web/insightsModel.ts`, `test/insightsModel.test.ts`; edits to `web/main.ts` (routing), `web/home.ts` (one button), `web/style.css` (appends). Transcript branch edits `main.ts` in the inspector-wiring region and appends to `style.css` — merges are trivial.

## Out of scope

- Per-message cost attribution (would need transcript-level usage timestamps).
- Server-side aggregation endpoints or persistence.
- Export/share of charts.
