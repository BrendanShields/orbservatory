# UI/UX Overhaul — Design Spec

Date: 2026-07-09
Status: approved (brainstorm 2026-07-09)
Approach: token-led redesign (option B) — no framework change, vanilla TS + Bun stays.

## Goal

Fix the known UX defects, slim the information architecture around ⌘K, stop
leaking filesystem paths, add a privacy mask for screen sharing, introduce
light/dark theming via a design-token layer, and rebuild the dashboard
sessions-first. Fix two canvas correctness bugs at the engine root cause.

Non-goals: React/Next port, watch-all-live redesign (feature is hidden this
round), mobile-specific work beyond keeping current breakpoints functional.

## 1. Canvas bugs (engine root cause)

Both fixes live in `parseSession` (`web/engine.ts`) and get synthetic-session
tests following the existing `bun:test` pattern.

**1a. Missing wires (dangling children).** `render.ts` skips an edge when the
parent node does not exist at time t; workflow parents can have
`spawnT` later than their children (subagent files appear before the workflow
parent's own first event). Invariant: a parent exists no later than its first
child. After the tree is built, one bottom-up pass clamps
`parent.spawnT = min(parent.spawnT, min(children.spawnT))`. Children walk
before parents (iterate agents in reverse topological order via depth, or loop
until fixed point — tree depth is small; a single pass ordered by depth
descending suffices).

**1b. Orchestrator re-animates into frame.** A `complete` event sets
`completeT` permanently. On live sessions the node is deleted after the
3s linger, then new activity re-creates it at a fresh spawn position and it
flies back in. Fix: after an agent's events are collected, if any own event
has `t > completeT`, reset `completeT = Infinity` — an agent that acts after
"complete" is not complete. (If a later `complete` follows the later activity,
it wins as usual because events are processed in order; the reset only applies
when activity is the *last* word.)

Acceptance: replaying/scrubbing a workflow session never shows a child node
without a wire to its parent; watching a live session through multiple user
turns never replays the orchestrator entrance.

## 2. Shell & navigation

**Session topbar** shrinks to:

```
← Home   ● agent-harness — Commit and push changes            ⚙
```

- Dot = live status of the current session (cyan pulse live, grey idle/done).
- Project name + session title replace the server `desc` string. Truncate
  title with ellipsis; full title in `title=` tooltip. No session id, no cwd.
  Imported replays show `awv.name — imported replay`; the merged live view
  (unreachable this round) keeps its existing name.
- Clicking the title area opens ⌘K — that is the session-switch affordance.
- Wordmark ("AGENT ORCHESTRA…") renders on the home view only.
- Removed from topbar: session `<select>`, source filter, layout select,
  palette select, Fit, Import, Export, LIVE (all relocated; see §3, §5, §6).

**⌘K palette** becomes the hub with three sections:

1. **Sessions** — existing behaviour (live first, metadata + full-text
   search). "All live sessions" row removed.
2. **This session** — only when a session is open: agents whose name/task
   matches the query. Enter selects the agent and focuses the camera on its
   node (`selectedId` + `focusId`).
3. **Commands** — `Import session…` (triggers file picker), `Export session`
   (active session only), `Toggle privacy mask`, `Theme: light/dark/system`
   (cycles), `Settings`.

Empty-query palette shows recent sessions + commands. Keyboard model
unchanged (↑↓ ↵ esc).

**Watch-all-live** entry points removed: home button, palette row, picker
(picker is deleted entirely). The `#/live` route and merge machinery stay in
code but are unreachable; delete in a later round if never missed.

## 3. Canvas view

**Toolbar** — floating vertical cluster, bottom-right of the stage, position
permanent (never shifts):

```
[+] [−] [⤢]  ─  [layout ▾] [⇣ export] [?]
```

- Layout button opens a small popover listing organic / radial / fixed
  (persists via `putSettings` as today).
- Export downloads the active session AWV JSON (same code path as before).
- `?` opens a shortcuts popover; the permanent bottom-left hint line is
  removed.
- The inspector gets `max-height: calc(100% - 84px)` so the toolbar always
  has clear ground; the `.stage.inspector-open .canvas-nav` shift and its
  comment block are deleted.

**Transport (footer)** — left-to-right:

```
▶ · ◀ · ▶ · [1×]      ————— scrubber —————      6:03 / 43:40 · [● LIVE]
```

- One speed chip replaces six buttons; click opens a popover with
  0.5/1/2/4/16/64. Current value always visible.
- LIVE pill moves here (it is a playback concern): glowing when pinned to the
  live edge, click re-pins and jumps to live. Hidden for non-live sessions.

**Agents rail** — header rebuilt on two rows:

```
AGENTS                      2 live · 35 done · 43
[filter input…]                            [done]
```

- Filter input filters rows by substring of name/task; `/` focuses it while
  in the graph view (home keeps `/` for its own search). Esc clears + blurs.
- `done` toggle keeps current semantics (`c` shortcut unchanged).
- No wrapping/overlap at any count text length.

**Inspector** —

- Header becomes a flex row: `● · KICKER TEXT · ✕` — close button is in-flow,
  overlap impossible by construction. Kicker dedupes repeated words (root
  agents read `ROOT · CLAUDE`, not `ROOT · ROOT · CLAUDE`).
- Event log: filter chips `all / tools / messages / errors` above the list
  (compact + spawn/complete count as messages for filtering purposes; chips
  filter the already-rendered window). Rows click-to-expand: expanded row
  wraps the full label text (no ellipsis) until clicked again.
- Delta column padding fixed so the scrollbar never clips it
  (`scrollbar-gutter` already present; add right padding).
- Root agent task line shows the project name, never the cwd (see §4).

## 4. Privacy

**Always on — no absolute paths rendered anywhere.**

- Root cause, server-side (`server/normalizer.ts`): tool labels render
  `file_path`/`path` values relative to the session cwd (fallback: basename);
  the root agent's `task` becomes the project name; `desc` becomes
  `projectName · shortId` (cwd segment dropped). Exports are therefore clean
  too.
- Client fallback (`web/privacy.ts`): a `cleanLabel(s)` regex collapses any
  remaining `/Users/...`-style absolute path (covers old imports) to its
  basename.

**Mask toggle — `Settings.maskProjects: boolean`, default false.**

- When on, project names render as stable aliases `project-one`,
  `project-two`, … assigned by first-seen order per page load (stable within
  a session of use; not persisted).
- Applied at render boundaries via `web/privacy.ts` (`maskProject(name)`):
  topbar title, home table + facets, ⌘K rows, rail rows and canvas labels for
  root agents, inspector kicker/title/task.
- Display-only: exports and the wire protocol carry real data.
- Toggle lives in Settings (Privacy section) and as a ⌘K command.

## 5. Theming

**Token layer.**

- `web/style.css` refactors all chrome colours onto ~20 CSS custom properties
  (`--bg --panel --panel-border --text --text-dim --text-faint --accent
  --accent-dim --ok --warn --err --shadow …`) defined per
  `:root[data-theme='dark']` / `[data-theme='light']`.
- `web/theme.ts` owns resolution: `Settings.theme: 'system'|'light'|'dark'`
  (default `system`), listens to `prefers-color-scheme`, stamps `data-theme`
  on `<html>`, and exposes a canvas theme object (background stops, grid,
  vignette, label ink, label shadow, timeline track/tick/playhead colours)
  consumed by `render.ts` instead of hardcoded rgba values.

**Canvas modes.** `Settings.canvasStyle: 'match'|'dark'` (default `match`).

- `dark`: canvas always renders the dark palette (video-editor stage) even in
  light theme.
- `match`: in light theme the canvas uses light palette variants — each
  `PALETTES` entry gains a light counterpart (light bg stops, darker grid,
  no vignette or a light one), node orbs keep their saturated colours, halos
  render as soft shadows (lower alpha, darker hue) so nodes stay legible on
  light ground; label ink flips dark.

**Settings modal** gains an Appearance section: Theme (system/light/dark),
Canvas (match/always dark), Palette (moved here from the topbar). Modal
content grouped under headings: Appearance · Privacy · Graph · Ingestion ·
Server.

**Fonts.** Outfit + JetBrains Mono woff2 files ship in `web/fonts/` with
`@font-face` in style.css; the Google Fonts `@import` is removed. Verify the
compiled binary embeds the font assets (Bun bundles css `url()` assets via
the HTML import — confirm in `build:bin` output before closing the phase).

## 6. Dashboard (sessions-first)

Top-to-bottom hierarchy:

1. **Header row**: wordmark (small) · big search input · `Import session`
   button · theme toggle · ⚙.
2. **Live now strip**: horizontal cards, one per live session (project —
   title, token count, source), click opens. Rendered only when live
   sessions exist. This replaces "Watch all live".
3. **Sessions table**: default columns `session (title + project · source) ·
   when · duration · tokens (split bar) · status`. A density toggle
   ("details") reveals tier / subagents / tools / $ / skills / model.
   Sort control unchanged. Row count + search behaviour unchanged.
4. **Stats line**: one slim row (`322 sessions · 6.5B tokens · 56k tool
   calls · $…`) with an **Insights ▾** disclosure that expands the existing
   tiles + top-skills/tools/models chips (restyled on tokens).
5. **Facets** live behind the existing Filters button at all widths; active
   facets render as removable chips next to it.

Colour discipline (whole app, enforced by tokens): accent = ink blue/cyan;
green exclusively means *live*; amber reserved for warnings/cost. Titles and
numbers in Outfit; mono only for data (ids, tokens, timestamps). Tier badges
become neutral letter chips (S/M/C) with the tooltip explanation kept.

## 7. Data / protocol changes

`shared/schema.ts` `Settings` gains:

```ts
theme: 'system' | 'light' | 'dark';      // default 'system'
canvasStyle: 'match' | 'dark';           // default 'match'
maskProjects: boolean;                   // default false
```

Server `settings.ts` sanitises + persists them like existing fields; the
`settings` WS broadcast already applies live. No other protocol changes.
`AwvSession.desc` composition changes server-side (no cwd) — clients only
display it, no migration needed.

## 8. Error handling

- Privacy transforms are pure string functions — no failure modes beyond
  "regex didn't match", which leaves text unchanged (fail open to *relative*
  server-side labels, never to absolute paths, since those are gone at the
  source).
- Theme resolution falls back to dark if `matchMedia` is unavailable.
- ⌘K node section only renders when an engine is active; commands that need
  an active session (Export) render disabled otherwise.
- Settings additions are optional on the wire; older persisted settings files
  load with defaults filled in (existing sanitise path).

## 9. Testing

- Engine: parent-spawn clamp (child before parent → wire never dangles:
  assert `spawnT` ordering), completeT reset (activity after complete →
  status active, node alive), both via synthetic `AwvSession` fixtures.
- Privacy: `cleanLabel` path stripping cases (absolute, relative, none,
  multiple paths in one label), alias stability (same input order → same
  aliases).
- Normalizer: tool labels emit cwd-relative paths; root task = project name;
  desc contains no cwd.
- Theme: resolution matrix (setting × system preference → data-theme).
- Existing 82 tests stay green; UI logic added as pure functions
  (event-log filter predicate, speed list, alias map) so it tests without a
  DOM.
- End of each phase: drive the real app in a browser (agent-browser) against
  live sessions.

## 10. Phasing

| Phase | Scope | Ships alone |
|---|---|---|
| P1 | §1 engine bugs + tests | yes |
| P2 | §2–3 IA: topbar, ⌘K hub, toolbar, transport, rail, inspector | yes |
| P3 | §4 privacy: server relative paths, privacy.ts, mask toggle | yes |
| P4 | §5 theming: tokens, theme.ts, light palettes, canvas modes, fonts, settings modal regroup | yes |
| P5 | §6 dashboard rebuild (on tokens) | yes |

Implementation loads `dd-motion-design`, `dd-interface-recipes`, and
`dataviz` (dashboard tiles) for the polish passes; `dd-interaction-principles`
already informed the IA (⌘K as the thin layer between intent and switching;
controls at the moment of need — shortcuts popover instead of a permanent
hint line; LIVE with the transport it belongs to).
