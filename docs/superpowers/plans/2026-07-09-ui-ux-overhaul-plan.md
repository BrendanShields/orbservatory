# UI/UX Overhaul — Implementation Plan

Spec: `docs/superpowers/specs/2026-07-09-ui-ux-overhaul-design.md` (commit 2627230).
Read the spec section referenced by each phase before starting it.

## Ground rules

- Each phase ends: `bun run typecheck` clean, `bun test` green (82 existing
  tests must stay green), verified live in the browser (agent-browser against
  `http://127.0.0.1:7899`, real sessions), then one commit.
- `bun run dev` for HMR while working; server-side edits (normalizer,
  settings) restart the process automatically under `--watch`.
- No explanatory code comments; comments only for constraints code can't show.
- New UI logic ships as pure functions where possible so it tests without a
  DOM (existing pattern: `test/ui-hidden.test.ts`, `test/html.test.ts`).
- Skill loads at the marked points: P2 → `dd-motion-design` +
  `dd-interface-recipes`; P5 → `dataviz` (+ recipes still in context).
- Baseline before P1: commit or verify the currently-dirty working tree
  (prior session's module split — typecheck + tests already pass) so each
  phase diff is clean.

## P1 — Engine bugs (spec §1)

**1.1 Parent-exists-before-children clamp** — `web/engine.ts`
- In `parseSession`, after the per-agent finalisation loop (depth/kf/evs
  sorted, first-event clamp applied), add one pass ordered by depth
  descending: for each agent with a parent,
  `parent.spawnT = Math.min(parent.spawnT, agent.spawnT)`.
- Test (`test/engine.test.ts`, new file, synthetic `AwvSession` fixtures):
  child spawn at t=1000, parent's own first event at t=5000 →
  `parent.spawnT <= 1000`; grandchild case propagates to root.

**1.2 completeT reset on post-complete activity** — `web/engine.ts`
- In the same finalisation loop: find the last own `complete` event; if any
  own event (tool / spawn / message-from / error / retry) has
  `t > completeT`, set `completeT = Infinity`.
- Tests: complete at t=2000 then tool at t=3000 → `statusAt(a, 4000)` is
  `active`, `completeT === Infinity`; complete as final event → stays
  complete; complete → tool → complete keeps the last completeT.

**Verify**: open the 43-agent agent-harness session
(`#/s/-Users-b-dev-1-Projects-agent-harness/65d8d973-…`), scrub through the
workflow burst — every visible child has a wire; watch a live session across
two prompts — no orchestrator re-entrance. Commit.

## P2 — IA: shell, ⌘K, canvas chrome (spec §2–3)

Load `dd-motion-design` + `dd-interface-recipes` first (popovers, transitions,
hit areas).

**2.1 Topbar slim-down** — `web/main.ts`, `web/style.css`
- New topbar DOM: `← Home` · `<button id="sessionTitle" class="session-title">
  ● <b>project</b> — <span>title</span></button>` · spacer · `⚙`.
- Delete: `#sessionPicker`, `#sourceFilter`, `#sessionDesc`, `#layout`,
  `#palette`, `#fit`, `#live`, `#import`, `#export` elements + their wiring
  (`renderPicker`, `sourceFilter` state, their `onchange` handlers).
  `#file` input stays (⌘K import uses it).
- `updateChrome` composes the title from `summaryOf(active.id)`
  (`projectName`, `title`, live dot class); imported replay →
  `awv.name — imported replay`; no active → connection state text.
- `#sessionTitle` click → `palette.toggle()`. Tooltip = full title.
- Wordmark markup moves into the home view header (see 5.1; until P5 it may
  simply be hidden on the graph view — acceptable interim).

**2.2 ⌘K hub** — `web/palette.ts`, `web/main.ts`
- Generalise rows to
  `{ kind: 'session'|'node'|'command', … }` with section headers.
- Node section: palette receives a provider callback from main
  (`getActive(): { eng, selectedId } | null`); query matches agent
  name/task (case-insensitive substring); row shows dot (agent colour),
  name, status; Enter → `onNode(id)` → main sets
  `selectedId/renderer.selectedId/renderer.focusId` + `renderPanels()`.
- Commands (constant list, filtered by query, always below sessions):
  Import session… (`fileInput.click()`), Export session (disabled when no
  active), Toggle privacy mask (P3 wires the actual setting; hidden until
  then), Theme (P4; hidden until then), Settings (`settingsModal.toggle()`).
- Remove the `all-live` row. Empty query: sessions (recent) + commands.
- Tests: extract pure `paletteCandidates(query, sessions, nodes, commands)`
  ranking/filter helper; cover session+node+command mixing and the
  no-active-session case.

**2.3 Canvas toolbar** — `web/main.ts`, `web/style.css`
- Extend `.canvas-nav`: `+ − ⤢` · divider · layout button · export · `?`.
- Layout button popover (3 options, current checked) → sets
  `renderer.layout` + `putSettings({ layout })`. Reuse a tiny popover helper
  (one function, positioned above the button, closes on outside click/Esc).
- Export button → existing `exportSession(active.awv)`.
- `?` popover lists shortcuts (space, ←/→, f, c, /, ⌘K, drag/scroll/dbl-click,
  drop-to-import). Delete `.hint` element + CSS.
- Inspector clearance: `.inspector{max-height:calc(100% - 84px)}`; delete
  `.stage.inspector-open .canvas-nav` rule + the `inspector-open` class
  toggle in `renderPanels` + its comment block.

**2.4 Transport collapse + LIVE relocation** — `web/main.ts`, `web/style.css`
- Replace six `[data-speed]` buttons with one chip showing current speed;
  click → popover (0.5/1/2/4/16/64) using the same popover helper.
- Footer right side: `time` readout then `#live` pill (moved from topbar,
  same behaviour/classes; `hidden` when `!active?.live`).
- `updateChrome` keeps pill state in sync (already does).

**2.5 Rail header + filter** — `web/panels.ts`, `web/style.css`, `web/main.ts`
- `railShell` header → row 1: `AGENTS` + counts (right-aligned, one line);
  row 2: filter `<input>` + `done` toggle.
- Filter state lives in `RailState`; `renderRail` filters `vis` by
  name/task substring before diffing rows. Empty result → existing empty
  message ("No agents match").
- `/` in graph view (main keydown, before other single-key handlers) focuses
  the rail filter; Esc inside it clears + blurs (and does not bubble to the
  home-navigation Esc).
- Test: extract `filterAgents(vis, q)` pure helper.

**2.6 Inspector header + event log** — `web/panels.ts`, `web/style.css`
- Header flex row: dot span · kicker text (flex:1, ellipsis) · close button
  (in-flow, 28px hit area kept via ::after). Kicker builder dedupes
  consecutive identical words (`root · root · claude` → `root · claude`).
- Event log: chip row above (`all / tools / messages / errors`; messages
  bucket = message+spawn+complete+compact); filter applies inside the
  existing 70-row window walk. Row click toggles `.expanded`
  (white-space:normal, full label). Add right padding for the delta column.
- Root task line: display `projectName` when `task` equals the session cwd
  (interim until P3 moves this server-side).
- Test: extract `logFilter(kind, e)` predicate.

**Verify** (browser): topbar shows `● agent-harness — <title>`; ⌘K finds and
focuses a node; layout switch via toolbar persists after reload; speed
popover works; LIVE pins from footer; rail filter narrows; inspector close
button clean, log expands + filters; toolbar fixed with inspector open/closed;
narrow window (≤900px) still usable. Commit.

## P3 — Privacy (spec §4)

**3.1 Server: relative paths at the source** — `server/normalizer.ts`
- Tool label builder: values for `file_path`/`path` keys render relative to
  session cwd (`rel = path.startsWith(cwd+'/') ? path.slice(cwd.length+1) :
  basename(path)`); other keys untouched.
- Root agent `task` = `projectName` (not cwd). `desc` =
  `` `${projectName} · ${sessionId.slice(0,8)}` ``.
- Update affected normalizer/store tests; add cases: label with cwd path →
  relative; foreign path → basename; desc/task contain no `/Users`.

**3.2 Client privacy module** — new `web/privacy.ts`
- `cleanLabel(s)`: collapse any remaining absolute path
  (`/(?:\/[\w.@-]+){2,}/` style, plus `~/…`) to its basename. Applied in
  `panels.ts` log rows + canvas event labels (`render.ts` drawLabels tool
  text) for old imports.
- `maskProject(name)`: when mask on, alias from first-seen-order map
  (`project-one`, `project-two`, …). `setMask(on)` from settings.
- Apply at render boundaries: topbar title, home rows/facets (P5 keeps it),
  ⌘K rows, rail root rows, inspector kicker/title/task, canvas root labels.
- Tests: cleanLabel matrix (absolute, relative, none, multiple, ~ paths);
  alias stability + no-collision; mask off = identity.

**3.3 Setting + command** — `shared/schema.ts`, `server/settings.ts`,
`web/settingsModal.ts`, `web/main.ts`
- `Settings.maskProjects: boolean` default false; sanitise + persist server
  side; checkbox under a Privacy heading in the modal; ⌘K command toggles via
  `putSettings`; `applyServerSettings` feeds `privacy.setMask`.

**Verify**: with mask on, screen contains no real project name in nav, rail,
canvas, ⌘K, inspector; no absolute path anywhere with mask off; export JSON
unchanged (real names, relative paths). Commit.

## P4 — Theming (spec §5)

**4.1 Token layer** — `web/style.css`
- Define tokens on `:root[data-theme='dark']` and `[data-theme='light']`
  (`--bg --panel --panel-border --text --text-dim --text-faint --accent
  --accent-dim --ok --warn --err --shadow --input-bg` — extend only if a
  real need appears during the sweep).
- Sweep every hardcoded chrome colour in style.css onto tokens. Canvas
  colours excluded (4.3). Dark theme must render pixel-equivalent to today.

**4.2 Theme resolution** — new `web/theme.ts`, `shared/schema.ts`,
`server/settings.ts`, `web/settingsModal.ts`
- `Settings.theme: 'system'|'light'|'dark'` (default system),
  `Settings.canvasStyle: 'match'|'dark'` (default match).
- `theme.ts`: resolves setting × `prefers-color-scheme` → stamps
  `data-theme` on `<html>`, keeps `color-scheme` in sync, notifies
  subscribers (renderer). Fallback dark when `matchMedia` missing.
- Settings modal regroups under headings: Appearance (theme, canvas style,
  palette — moved from topbar; the palette `<select>` was already removed in
  P2, its setting now surfaces here) · Privacy · Graph · Ingestion · Server.
- ⌘K Theme command cycles system → light → dark.
- Test: resolution matrix (3 settings × 2 system prefs).

**4.3 Canvas themes** — `web/render.ts`
- Each `PALETTES` entry gains a light variant (bg stops, grid, vignette).
  Extract hardcoded label ink / label shadow / timeline track / tick /
  playhead / gap-hatch colours into a `CanvasTheme` object with dark + light
  values; renderer picks by resolved theme + `canvasStyle` ('dark' forces
  the dark set).
- Light canvas: halos at reduced alpha with darker hue (soft-shadow look);
  orb sprites keyed by theme where their rim/backing colour changes.
- Node colour map `COL` unchanged.

**4.4 Local fonts** — `web/fonts/`, `web/style.css`
- Vendor Outfit (300–700) + JetBrains Mono (400/500/700) woff2; `@font-face`
  replaces the Google `@import`.
- `bun run build:bin` then run the binary from an offline-simulated shell:
  fonts render, no network fetch (check devtools network panel).

**Verify**: toggle system appearance → app follows in `system`; light theme
readable everywhere (nav, rail, inspector, modal, ⌘K, footer); canvas
always-dark mode holds in light theme; match mode shows light canvas; dark
mode diff vs pre-P4 screenshots ≈ none. Commit.

## P5 — Dashboard (spec §6)

Load `dataviz` before styling tiles/stats.

**5.1 Structure** — `web/home.ts`, `web/homeModel.ts`, `web/style.css`
- Header row: wordmark (moved from graph topbar markup) · search ·
  `Import session` · theme toggle button · ⚙ (opens settings modal from
  home too).
- Live-now strip: cards from `sessions.filter(live)` (project — title,
  tokens from stats, source badge); hidden when none. Replaces `#homeWatch`
  (delete `onWatchLive` callback + button).
- Sessions table: default columns session/when/duration/tokens/status;
  `details` toggle (persisted in localStorage) reveals tier/sub/tools/$/
  skills/model. Column defs become data-driven so the toggle is one flag.
- Stats: slim line above Insights ▾ disclosure wrapping the existing
  tiles+chips (aggregate code in `homeModel.ts` unchanged).
- Facets: behind the Filters button at all widths; active facets render as
  removable chips beside it.

**5.2 Colour + type sweep** — `web/style.css`
- Home accents onto tokens: blue accent; green only `.st.live` + live dots;
  amber only cost/warnings; tier badges neutral letter chips (tooltip kept).
- Titles/numbers Outfit; mono for ids/tokens/timestamps only.

**Verify**: home reads top-down search → live now → sessions → insights;
mask toggle masks home too; light + dark both clean; density toggle
persists; no green except live markers. Commit.

## Done criteria

All spec acceptance points hold; typecheck + full test suite green; every
phase verified against real sessions in the browser; five commits (one per
phase) on main.
