# Insights page — implementation plan

**Spec:** `docs/superpowers/specs/2026-07-12-insights-page-design.md`
**Branch:** `feat/insights-page` off `feat/pi-provider-hardening` (own worktree)
**Validation gate for every phase:** `pnpm typecheck && bun test` (plus `pnpm build` before handoff)

## Phase 1 — aggregation model (pure, test-first)

1. New `web/insightsModel.ts`:
   - `interface DayBucket { day: string; tokens: TokenTotals; costByModel: Record<string, number>; sessions: number; toolCalls: number; cacheRate: number | null; analysed: number }`
   - `bucketByDay(stats: SessionStats[], summaries: SessionSummary[], opts: { days: 7|30|90; project?: string }): DayBucket[]`
     - local-midnight day keys via `new Date(y, m, d)` iteration (DST-safe), continuous range ending today (leading zero-days included);
     - session attribution: day of `stats.lastActive`, clamped to today when in the future;
     - project filter matches home semantics (`projectName || project` from the summary; stats joined by `sessionId`);
     - sessions lacking stats counted in a returned `{ total, analysed }` header alongside buckets — return shape `{ buckets: DayBucket[]; total: number; analysed: number }`;
     - `cacheRate = cacheRead / (input + cacheRead)`, `null` when denominator 0;
     - `costByModel` from `tokensByModel` × nothing — cost only from `costUsd` when present; per-model split uses `tokensByModel` proportions only when `costUsd` exists, else session excluded from the cost chart (keep v1 simple: attribute whole `costUsd` to the session's last model — matches home's model column).
2. New `test/insightsModel.test.ts`: DST transition week, range edges (today included, day 0 empty), future clamp, project filter, cache-rate null, cost with partial pricing, analysed/total counts.
   - Done when: tests pass without touching any other file.

## Phase 2 — page + charts

3. New `web/insights.ts` — `InsightsView` with `mount(root, cb)` / `update(sessions, statsById, opts)` (mirror `HomeView`):
   - header: "← Home" ghost button, `ORBSERVATORY` brand, range chips (7/30/90 — `chip-toggle` styles), project `select.compact` (options from summaries), analysed/total statline;
   - chart stack (each a `<canvas>` + `<h3>` label):
     1. tokens/day stacked bars (`--viz-in`, `--viz-out`, `--viz-in-dim`, `--viz-out-dim`);
     2. cost/day by model stacked bars (agent-color hash per model) — hidden with "add pricing in ⚙ settings" hint row when no bucket has cost;
     3. activity/day: sessions bars + tool-calls line (right axis);
     4. cache hit-rate line with gaps on `null`;
   - shared `drawBars/drawLine` helper in the same file: dpr-aware sizing (`clientWidth`, cap ~220px tall), axes with 3–4 gridlines, colors via `getComputedStyle` token reads, hover → `.tl-tip`-styled tooltip div showing day, exact values, session count, "attributed to day of last activity";
   - empty state: `.home-empty` markup ("waiting for background analysis" when total>0 but analysed=0);
   - re-render guard: skip redraw when `(bucketsDigest, theme, size)` unchanged; redraw on `resize` (debounced) and theme change.
4. `web/style.css`: append `.insights` page styles (container mirrors `.home`, chart cards mirror `.tile` surfaces, range-chip row). Reduced-motion: no entrance animations on charts.

## Phase 3 — routing + entry

5. `web/main.ts`:
   - `Route` union + `parseRoute`: `#/insights` → `{ view: 'insights' }`;
   - third root container `#insightsRoot` in the shell markup; `applyRoute` shows/hides it (subscribe with empty ids like home — stats/sessions still stream);
   - `scheduleInsights` 200ms debounce calling `insightsView.update(...)` on `sessions`/`stats` messages while the route is active;
   - Esc on insights → `location.hash = ''`; `/` ignored.
6. `web/home.ts`: "Trends →" ghost button in the Insights zone header (`onOpenInsights` callback → `location.hash = '#/insights'`).
   - Done when: home → Trends → charts render from live stats; Esc returns; theme toggle re-renders correctly.

## Phase 4 — validation + ship

7. `pnpm typecheck && pnpm lint && pnpm build && bun test`.
8. Live smoke: `pnpm dev` with real data — 354 sessions should produce visible 7/30/90d shapes; check light + dark, hover tooltips, project filter, no-pricing hint (pricing map is empty by default), narrow window reflow.
9. Commit, push, PR with test-plan checklist.

## Risks / notes

- Do not import from `web/render.ts` (keeps worktree overlap near zero); token colors come from CSS custom properties directly.
- `statsById` only fills as background parses land — the analysed/total statline is the honest signal, no spinners.
- Keep every aggregation decision inside `insightsModel.ts`; `insights.ts` draws, never computes.
