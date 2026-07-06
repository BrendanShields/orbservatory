// AWV demo workflow library — deterministic, no external deps.
// Schema:
//   { name, desc, agents:[{id,name,color,limit,task,role}], events:[...] }
// Event types:
//   {t,type:'spawn', agent, parent?, tokens}          — agent appears; tokens = initial context (system+task)
//   {t,type:'message', from?, to, label, tokens}      — tokens added to `to`; from omitted = external/user
//   {t,type:'tool', agent, tool, label?, tokens}      — skill/tool invocation, tokens added to agent
//   {t,type:'compact', agent, to, label?}             — context compaction; `to` = absolute token count after
//   {t,type:'error', agent, label}                    — agent enters error state
//   {t,type:'retry', agent, label?}                   — clears error
//   {t,type:'complete', agent, label?}                — agent finishes
(function () {
  const S = [];
  const A = (id, name, color, limit, task, role) => ({ id, name, color, limit, task, role });
  let _seed = 7;
  const rnd = () => { _seed = (_seed * 1103515245 + 12345) % 2147483648; return _seed / 2147483648; };
  const ri = (a, b) => Math.floor(a + rnd() * (b - a));

  // ── 1. Parallel Research Swarm ─────────────────────────────
  (function () {
    const topics = ['supply chain', 'patent landscape', 'competitor moves', 'manufacturing cost', 'regulation'];
    const ag = [
      A('orch', 'Orchestrator', 'gold', 200000, 'Coordinate a market analysis of solid-state batteries. Fan out research, synthesize a report.', 'lead'),
      ...topics.map((tp, i) => A('r' + (i + 1), 'Researcher ' + (i + 1), 'cyan', 100000, 'Research: ' + tp, 'research')),
      A('synth', 'Synthesizer', 'purple', 200000, 'Merge all findings into a single structured report.', 'writer')
    ];
    const E = [];
    E.push({ t: 0, type: 'spawn', agent: 'orch', tokens: 2600 });
    E.push({ t: 900, type: 'message', to: 'orch', label: 'User brief: solid-state battery market analysis', tokens: 1400 });
    E.push({ t: 2100, type: 'tool', agent: 'orch', tool: 'planner', tokens: 2200 });
    E.push({ t: 3400, type: 'tool', agent: 'orch', tool: 'todo_write', tokens: 700 });
    for (let i = 1; i <= 5; i++) {
      const t0 = 4200 + (i - 1) * 750;
      E.push({ t: t0, type: 'tool', agent: 'orch', tool: 'dispatch_agent', label: 'spawn researcher ' + i, tokens: 800 });
      E.push({ t: t0 + 250, type: 'spawn', agent: 'r' + i, parent: 'orch', tokens: 3200 });
      let tt = t0 + 1600;
      const n = 3 + ((i * 7) % 3);
      for (let k = 0; k < n; k++) {
        E.push({ t: tt, type: 'tool', agent: 'r' + i, tool: k % 2 ? 'web_fetch' : 'web_search', tokens: 2400 + ((i * (k + 1) * 997) % 3200) });
        tt += 2300 + ((i * (k + 1) * 613) % 1500);
      }
      if (i === 3) {
        E.push({ t: 14200, type: 'error', agent: 'r3', label: 'rate_limited (429)' });
        E.push({ t: 16600, type: 'retry', agent: 'r3', label: 'backoff → retry' });
        E.push({ t: 17600, type: 'tool', agent: 'r3', tool: 'web_search', tokens: 2900 });
      }
      const tc = 21000 + i * 1400;
      E.push({ t: tc, type: 'message', from: 'r' + i, to: 'orch', label: 'Findings: ' + topics[i - 1], tokens: 8000 + i * 1200 });
      E.push({ t: tc + 300, type: 'complete', agent: 'r' + i });
    }
    E.push({ t: 30500, type: 'compact', agent: 'orch', to: 26000, label: 'compact: findings summarized' });
    E.push({ t: 31500, type: 'spawn', agent: 'synth', parent: 'orch', tokens: 3000 });
    E.push({ t: 32200, type: 'message', from: 'orch', to: 'synth', label: 'Aggregated findings package', tokens: 14000 });
    E.push({ t: 34000, type: 'tool', agent: 'synth', tool: 'outline', tokens: 3000 });
    E.push({ t: 37500, type: 'tool', agent: 'synth', tool: 'draft_report', tokens: 9000 });
    E.push({ t: 42500, type: 'tool', agent: 'synth', tool: 'cite_check', tokens: 4200 });
    E.push({ t: 45500, type: 'message', from: 'synth', to: 'orch', label: 'Final report (12 pages)', tokens: 6000 });
    E.push({ t: 45900, type: 'complete', agent: 'synth' });
    E.push({ t: 47000, type: 'tool', agent: 'orch', tool: 'final_review', tokens: 1500 });
    E.push({ t: 48500, type: 'complete', agent: 'orch', label: 'Report delivered' });
    S.push({ name: 'Parallel Research Swarm', desc: 'Orchestrator fans out 5 researchers, then a synthesizer merges findings.', agents: ag, events: E });
  })();

  // ── 2. Recursive Code Refactor ─────────────────────────────
  (function () {
    const mods = [['m1', 'Core API', 2], ['m2', 'Web Client', 3], ['m3', 'Worker Jobs', 2]];
    const ag = [A('lead', 'Refactor Lead', 'gold', 200000, 'Refactor the auth module across all services. Delegate per-module, verify integration.', 'lead')];
    mods.forEach(([id, nm]) => ag.push(A(id, nm, 'purple', 150000, 'Refactor auth usage in ' + nm, 'module')));
    mods.forEach(([id, nm, nf]) => { for (let j = 1; j <= nf; j++) ag.push(A(id + 'f' + j, nm.split(' ')[0].toLowerCase() + '/file-' + j, 'cyan', 80000, 'Apply auth refactor to file ' + j + ' of ' + nm, 'file')); });
    const E = [];
    E.push({ t: 0, type: 'spawn', agent: 'lead', tokens: 2800 });
    E.push({ t: 800, type: 'message', to: 'lead', label: 'Task: migrate to token-based auth', tokens: 1600 });
    E.push({ t: 2000, type: 'tool', agent: 'lead', tool: 'repo_map', tokens: 3400 });
    E.push({ t: 3600, type: 'tool', agent: 'lead', tool: 'planner', tokens: 2100 });
    mods.forEach(([id, nm, nf], i) => {
      const t0 = 5200 + i * 950;
      E.push({ t: t0, type: 'tool', agent: 'lead', tool: 'dispatch_agent', label: 'spawn ' + nm, tokens: 700 });
      E.push({ t: t0 + 250, type: 'spawn', agent: id, parent: 'lead', tokens: 3600 });
      E.push({ t: t0 + 1400, type: 'tool', agent: id, tool: 'grep', tokens: 1600 });
      for (let j = 1; j <= nf; j++) {
        const ts = t0 + 2600 + (j - 1) * 850;
        const fid = id + 'f' + j;
        E.push({ t: ts, type: 'spawn', agent: fid, parent: id, tokens: 2800 });
        E.push({ t: ts + 1300, type: 'tool', agent: fid, tool: 'read_file', tokens: 1800 });
        E.push({ t: ts + 3100, type: 'tool', agent: fid, tool: 'edit_file', tokens: 2600 });
        E.push({ t: ts + 5200 + ri(0, 1400), type: 'tool', agent: fid, tool: 'run_tests', tokens: 2200 });
        const tc = ts + 8200 + ri(0, 2400);
        if (fid !== 'm2f2') {
          E.push({ t: tc, type: 'message', from: fid, to: id, label: 'Patch applied, tests green', tokens: 3500 });
          E.push({ t: tc + 250, type: 'complete', agent: fid });
        }
      }
    });
    E.push({ t: 19000, type: 'error', agent: 'm2f2', label: 'merge_conflict' });
    E.push({ t: 21500, type: 'retry', agent: 'm2f2', label: 'rebase → retry' });
    E.push({ t: 22600, type: 'tool', agent: 'm2f2', tool: 'edit_file', tokens: 2400 });
    E.push({ t: 24400, type: 'tool', agent: 'm2f2', tool: 'run_tests', tokens: 2000 });
    E.push({ t: 26200, type: 'message', from: 'm2f2', to: 'm2', label: 'Conflict resolved, patch applied', tokens: 3800 });
    E.push({ t: 26450, type: 'complete', agent: 'm2f2' });
    mods.forEach(([id, nm], i) => {
      const tv = 28500 + i * 2100;
      E.push({ t: tv, type: 'tool', agent: id, tool: 'run_tests', label: 'module suite', tokens: 3000 });
      if (id === 'm2') E.push({ t: 33000, type: 'compact', agent: 'm2', to: 22000, label: 'compact: diffs folded' });
      E.push({ t: tv + 4200, type: 'message', from: id, to: 'lead', label: nm + ' refactor done', tokens: 5200 + i * 800 });
      E.push({ t: tv + 4450, type: 'complete', agent: id });
    });
    E.push({ t: 39000, type: 'tool', agent: 'lead', tool: 'integration_tests', tokens: 4200 });
    E.push({ t: 41500, type: 'error', agent: 'lead', label: 'integration test failure (2)' });
    E.push({ t: 43000, type: 'retry', agent: 'lead', label: 'isolate failing cases' });
    E.push({ t: 44500, type: 'tool', agent: 'lead', tool: 'edit_file', label: 'hotfix', tokens: 2600 });
    E.push({ t: 46500, type: 'tool', agent: 'lead', tool: 'integration_tests', tokens: 3800 });
    E.push({ t: 49500, type: 'complete', agent: 'lead', label: 'All suites green' });
    S.push({ name: 'Recursive Code Refactor', desc: 'Lead → module agents → file agents. Three levels of delegation.', agents: ag, events: E });
  })();

  // ── 3. Map-Reduce Fan-out ──────────────────────────────────
  (function () {
    const ag = [
      A('coord', 'Coordinator', 'gold', 200000, 'Extract entities from a 12-chunk document corpus via map-reduce.', 'lead'),
      A('red', 'Reducer', 'pink', 200000, 'Merge, dedupe and rank mapper outputs.', 'reduce')
    ];
    for (let i = 1; i <= 12; i++) ag.push(A('w' + i, 'Mapper ' + String(i).padStart(2, '0'), 'green', 60000, 'Parse chunk ' + i + ', extract entities', 'map'));
    const E = [];
    E.push({ t: 0, type: 'spawn', agent: 'coord', tokens: 2400 });
    E.push({ t: 700, type: 'message', to: 'coord', label: 'Corpus received (12 chunks)', tokens: 1100 });
    E.push({ t: 1800, type: 'tool', agent: 'coord', tool: 'chunk_dataset', tokens: 2600 });
    E.push({ t: 3200, type: 'spawn', agent: 'red', parent: 'coord', tokens: 2600 });
    for (let i = 1; i <= 12; i++) {
      const t0 = 4000 + (i - 1) * 380;
      E.push({ t: t0, type: 'spawn', agent: 'w' + i, parent: 'coord', tokens: 2200 });
      E.push({ t: t0 + 1200, type: 'tool', agent: 'w' + i, tool: 'parse_chunk', tokens: 1900 });
      E.push({ t: t0 + 3400, type: 'tool', agent: 'w' + i, tool: 'extract_entities', tokens: 2800 });
      if (i % 3 === 0) E.push({ t: t0 + 5300, type: 'tool', agent: 'w' + i, tool: 'normalize', tokens: 1500 });
      const tc = 12000 + i * 900;
      E.push({ t: tc, type: 'message', from: 'w' + i, to: 'red', label: 'Partial: chunk ' + i, tokens: 6500 + ((i * 731) % 2400) });
      E.push({ t: tc + 250, type: 'complete', agent: 'w' + i });
    }
    E.push({ t: 26000, type: 'compact', agent: 'red', to: 40000, label: 'compact: partials folded' });
    E.push({ t: 27500, type: 'tool', agent: 'red', tool: 'merge_partials', tokens: 5200 });
    E.push({ t: 30500, type: 'tool', agent: 'red', tool: 'dedupe', tokens: 3800 });
    E.push({ t: 33500, type: 'tool', agent: 'red', tool: 'score_rank', tokens: 2900 });
    E.push({ t: 36000, type: 'message', from: 'red', to: 'coord', label: 'Entity graph: 1,204 nodes', tokens: 7200 });
    E.push({ t: 36400, type: 'complete', agent: 'red' });
    E.push({ t: 37500, type: 'tool', agent: 'coord', tool: 'final_check', tokens: 1600 });
    E.push({ t: 39000, type: 'complete', agent: 'coord', label: 'Corpus processed' });
    S.push({ name: 'Map-Reduce Fan-out', desc: '12 mappers stream partials into a reducer that compacts and merges.', agents: ag, events: E });
  })();

  // ── 4. Marathon Session (compaction showcase) ──────────────
  (function () {
    const ag = [
      A('main', 'Migration Agent', 'gold', 200000, 'Migrate the billing system to the new ledger schema. Long-running session with periodic compaction.', 'lead'),
      A('docs', 'Docs Helper', 'cyan', 80000, 'Summarize legacy billing docs', 'helper'),
      A('rev', 'Reviewer', 'purple', 120000, 'Review migration diffs', 'review')
    ];
    const E = [];
    E.push({ t: 0, type: 'spawn', agent: 'main', tokens: 3000 });
    E.push({ t: 800, type: 'message', to: 'main', label: 'Task: billing → ledger migration', tokens: 1800 });
    const tools = ['read_file', 'edit_file', 'run_tests', 'grep', 'web_search'];
    let t = 2200, k = 0;
    const compactAt = [22500, 45500, 66000];
    const stopAt = [21500, 44500, 65000, 72500];
    let phase = 0;
    while (t < 72500) {
      if (phase < 3 && t > stopAt[phase]) {
        E.push({ t: compactAt[phase], type: 'compact', agent: 'main', to: 28000 + phase * 3000, label: 'compact #' + (phase + 1) });
        t = compactAt[phase] + 1200; phase++;
      }
      E.push({ t: t, type: 'tool', agent: 'main', tool: tools[k % tools.length], tokens: 2500 + ri(0, 3500) });
      k++; t += 1900 + ri(0, 900);
    }
    E.push({ t: 20000, type: 'spawn', agent: 'docs', parent: 'main', tokens: 2600 });
    E.push({ t: 21800, type: 'tool', agent: 'docs', tool: 'read_file', tokens: 3200 });
    E.push({ t: 24500, type: 'tool', agent: 'docs', tool: 'summarize', tokens: 4100 });
    E.push({ t: 29500, type: 'message', from: 'docs', to: 'main', label: 'Legacy docs digest', tokens: 4200 });
    E.push({ t: 29800, type: 'complete', agent: 'docs' });
    E.push({ t: 38000, type: 'error', agent: 'main', label: 'test_failure: ledger rounding' });
    E.push({ t: 40000, type: 'retry', agent: 'main', label: 'fix rounding mode' });
    E.push({ t: 45000, type: 'spawn', agent: 'rev', parent: 'main', tokens: 2800 });
    E.push({ t: 47500, type: 'tool', agent: 'rev', tool: 'read_diff', tokens: 5200 });
    E.push({ t: 51000, type: 'tool', agent: 'rev', tool: 'lint_check', tokens: 2400 });
    E.push({ t: 55000, type: 'message', from: 'rev', to: 'main', label: 'Review: 3 nits, approved', tokens: 5200 });
    E.push({ t: 55400, type: 'complete', agent: 'rev' });
    E.push({ t: 74000, type: 'complete', agent: 'main', label: 'Migration shipped' });
    S.push({ name: 'Marathon + Compaction', desc: 'One long-running agent hitting its context limit — three compactions, two helpers.', agents: ag, events: E });
  })();

  // ── 5. Stress Swarm — 100 agents ───────────────────────────
  (function () {
    const leadColors = ['purple', 'pink', 'cyan'];
    const ag = [A('orch', 'Swarm Orchestrator', 'gold', 400000, 'Crawl and index 90 sources across 9 domains in parallel.', 'lead')];
    const E = [];
    E.push({ t: 0, type: 'spawn', agent: 'orch', tokens: 3000 });
    E.push({ t: 800, type: 'message', to: 'orch', label: 'Index 9 domains × 10 sources', tokens: 1500 });
    E.push({ t: 2000, type: 'tool', agent: 'orch', tool: 'planner', tokens: 2400 });
    for (let i = 1; i <= 9; i++) {
      const lid = 'L' + i;
      ag.push(A(lid, 'Domain Lead ' + i, leadColors[(i - 1) % 3], 150000, 'Coordinate 10 source workers for domain ' + i, 'lead'));
      const tl = 2500 + i * 620;
      E.push({ t: tl, type: 'spawn', agent: lid, parent: 'orch', tokens: 3000 });
      for (let j = 1; j <= 10; j++) {
        const wid = lid + 'w' + j;
        ag.push(A(wid, 'D' + i + ' · src ' + String(j).padStart(2, '0'), 'green', 40000, 'Fetch + extract source ' + j + ' in domain ' + i, 'worker'));
        const tw = tl + 1800 + j * 430 + ri(0, 300);
        E.push({ t: tw, type: 'spawn', agent: wid, parent: lid, tokens: 1500 });
        E.push({ t: tw + 1100 + ri(0, 600), type: 'tool', agent: wid, tool: 'web_fetch', tokens: 1300 + ri(0, 900) });
        E.push({ t: tw + 3300 + ri(0, 1200), type: 'tool', agent: wid, tool: 'extract', tokens: 1700 + ri(0, 800) });
        if (i === 4 && j === 7) {
          E.push({ t: tw + 4600, type: 'error', agent: wid, label: 'fetch timeout' });
          E.push({ t: tw + 6400, type: 'retry', agent: wid });
          E.push({ t: tw + 7200, type: 'tool', agent: wid, tool: 'web_fetch', tokens: 1400 });
        }
        const tc = tw + 7600 + ri(0, 3000);
        E.push({ t: tc, type: 'message', from: wid, to: lid, label: 'Source ' + j + ' indexed', tokens: 2600 + ri(0, 900) });
        E.push({ t: tc + 200, type: 'complete', agent: wid });
      }
      if (i % 3 === 0) E.push({ t: 30000 + i * 700, type: 'compact', agent: lid, to: 14000, label: 'compact: sources folded' });
      const tld = 38000 + i * 950;
      E.push({ t: tld, type: 'message', from: lid, to: 'orch', label: 'Domain ' + i + ' index ready', tokens: 5000 + ri(0, 1500) });
      E.push({ t: tld + 250, type: 'complete', agent: lid });
    }
    E.push({ t: 48500, type: 'compact', agent: 'orch', to: 22000, label: 'compact: domain indexes folded' });
    E.push({ t: 50500, type: 'tool', agent: 'orch', tool: 'build_index', tokens: 6000 });
    E.push({ t: 54500, type: 'complete', agent: 'orch', label: '90 sources indexed' });
    S.push({ name: 'Stress Swarm · 100 agents', desc: 'Orchestrator → 9 domain leads → 90 workers. Scale test.', agents: ag, events: E });
  })();

  // ═══════════════════════════════════════════════════════════
  //  Claude Code — dynamic workflows: flagship + pattern library
  // ═══════════════════════════════════════════════════════════
  const NEW = [];

  // ── ★ Flagship: Feature Delivery (research → plan → build → review) ──
  (function () {
    const ag = [
      A('main', 'Claude (main)', 'gold', 200000, 'Add OAuth2 login (Google + GitHub) to the web app: research the codebase, plan the change, implement it, and review before shipping.', 'orchestrator'),
      A('ex1', 'Explore · auth flow', 'cyan', 100000, 'Map how authentication currently works across the codebase.', 'explore'),
      A('ex2', 'Explore · session store', 'cyan', 100000, 'Investigate the session/cookie storage layer and Redis usage.', 'explore'),
      A('ex3', 'Explore · OAuth practice', 'cyan', 100000, 'Research current OAuth2 / PKCE best practices for SPAs.', 'explore'),
      A('plan', 'Plan agent', 'purple', 120000, 'Turn the research digest into a concrete, ordered implementation plan.', 'plan'),
      A('b1', 'Build · auth module', 'green', 120000, 'Implement the OAuth2 provider module and token exchange.', 'build'),
      A('b2', 'Build · login UI', 'green', 120000, 'Build the login screen and provider buttons.', 'build'),
      A('b3', 'Build · session mw', 'green', 120000, 'Wire session middleware + refresh-token rotation.', 'build'),
      A('rv1', 'Review · security', 'pink', 100000, 'Audit the diff for security issues (token storage, CSRF, scopes).', 'review'),
      A('rv2', 'Review · tests', 'pink', 100000, 'Check test coverage and run the suite against the diff.', 'review'),
      A('rv3', 'Review · style & arch', 'pink', 100000, 'Review code style, naming and architectural fit.', 'review')
    ];
    const E = []; const ev = (t, o) => E.push(Object.assign({ t }, o));
    // ── PHASE 1 · RESEARCH ──
    ev(0, { type: 'spawn', agent: 'main', tokens: 3200 });
    ev(700, { type: 'message', to: 'main', label: 'User: add OAuth2 login (Google + GitHub)', tokens: 1400 });
    ev(1900, { type: 'tool', agent: 'main', tool: 'Read', label: 'CLAUDE.md', tokens: 1900 });
    ev(3100, { type: 'tool', agent: 'main', tool: 'Glob', label: '**/*auth*', tokens: 900 });
    ev(4300, { type: 'tool', agent: 'main', tool: 'Grep', label: 'session|cookie|passport', tokens: 1500 });
    ev(5400, { type: 'tool', agent: 'main', tool: 'TodoWrite', label: 'research checklist', tokens: 600 });
    [['ex1', 6200], ['ex2', 6900], ['ex3', 7600]].forEach(([id, t]) => { ev(t, { type: 'tool', agent: 'main', tool: 'Task', label: 'spawn ' + id, tokens: 500 }); ev(t + 250, { type: 'spawn', agent: id, parent: 'main', tokens: 2800 }); });
    ev(8200, { type: 'tool', agent: 'ex1', tool: 'Grep', label: 'authenticate(', tokens: 1600 });
    ev(10200, { type: 'tool', agent: 'ex1', tool: 'Read', label: 'middleware/auth.ts', tokens: 2600 });
    ev(12600, { type: 'message', from: 'ex1', to: 'main', label: 'Auth flow: custom JWT in cookie, no refresh', tokens: 7200 });
    ev(12850, { type: 'complete', agent: 'ex1' });
    ev(8900, { type: 'tool', agent: 'ex2', tool: 'Read', label: 'lib/session.ts', tokens: 2400 });
    ev(11200, { type: 'tool', agent: 'ex2', tool: 'Bash', label: 'grep redis config', tokens: 1300 });
    ev(13400, { type: 'message', from: 'ex2', to: 'main', label: 'Sessions in Redis, 7d TTL, keyed by uid', tokens: 6400 });
    ev(13650, { type: 'complete', agent: 'ex2' });
    ev(9600, { type: 'tool', agent: 'ex3', tool: 'WebSearch', label: 'OAuth2 PKCE SPA 2026', tokens: 2600 });
    ev(11800, { type: 'error', agent: 'ex3', label: 'WebFetch 429 rate limited' });
    ev(13600, { type: 'retry', agent: 'ex3', label: 'backoff 2s → retry' });
    ev(14500, { type: 'tool', agent: 'ex3', tool: 'WebFetch', label: 'oauth.net/2/pkce', tokens: 3100 });
    ev(16400, { type: 'message', from: 'ex3', to: 'main', label: 'Recommend PKCE + rotating refresh tokens', tokens: 6800 });
    ev(16650, { type: 'complete', agent: 'ex3' });
    ev(17600, { type: 'compact', agent: 'main', to: 22000, label: 'compact: research digested' });
    // ── PHASE 2 · PLAN ──
    ev(18600, { type: 'tool', agent: 'main', tool: 'Skill', label: 'Skill: plan-mode', tokens: 700 });
    ev(19400, { type: 'tool', agent: 'main', tool: 'Task', label: 'spawn Plan agent', tokens: 500 });
    ev(19700, { type: 'spawn', agent: 'plan', parent: 'main', tokens: 2800 });
    ev(20400, { type: 'message', from: 'main', to: 'plan', label: 'Research digest + repo constraints', tokens: 11000 });
    ev(22000, { type: 'tool', agent: 'plan', tool: 'Read', label: 'package.json + routes', tokens: 2600 });
    ev(24500, { type: 'tool', agent: 'plan', tool: 'TodoWrite', label: 'draft 8-step plan', tokens: 1800 });
    ev(27000, { type: 'message', from: 'plan', to: 'main', label: 'Plan: 8 steps across 3 modules', tokens: 6800 });
    ev(27250, { type: 'complete', agent: 'plan' });
    ev(28200, { type: 'tool', agent: 'main', tool: 'TodoWrite', label: 'accept plan · 8 tasks', tokens: 1200 });
    // ── PHASE 3 · BUILD ──
    [['b1', 29200], ['b2', 29900], ['b3', 30600]].forEach(([id, t]) => { ev(t, { type: 'tool', agent: 'main', tool: 'Task', label: 'spawn ' + id, tokens: 500 }); ev(t + 250, { type: 'spawn', agent: id, parent: 'main', tokens: 3000 }); });
    ev(31200, { type: 'tool', agent: 'b1', tool: 'Write', label: 'auth/oauth.ts', tokens: 3400 });
    ev(34000, { type: 'tool', agent: 'b1', tool: 'Bash', label: 'npm test auth', tokens: 2600 });
    ev(37000, { type: 'message', from: 'b1', to: 'main', label: 'oauth module done · 12 tests green', tokens: 5200 });
    ev(37250, { type: 'complete', agent: 'b1' });
    ev(31900, { type: 'tool', agent: 'b2', tool: 'Write', label: 'LoginScreen.tsx', tokens: 3200 });
    ev(35000, { type: 'tool', agent: 'b2', tool: 'Edit', label: 'routes.tsx', tokens: 1800 });
    ev(38000, { type: 'message', from: 'b2', to: 'main', label: 'login UI + provider buttons done', tokens: 4800 });
    ev(38250, { type: 'complete', agent: 'b2' });
    ev(32600, { type: 'tool', agent: 'b3', tool: 'Edit', label: 'middleware/session.ts', tokens: 2800 });
    ev(35600, { type: 'tool', agent: 'b3', tool: 'Bash', label: 'npm test session', tokens: 2400 });
    ev(37200, { type: 'error', agent: 'b3', label: 'test fail: refresh rotation' });
    ev(39200, { type: 'retry', agent: 'b3', label: 'fix token reuse guard' });
    ev(40200, { type: 'tool', agent: 'b3', tool: 'Edit', label: 'middleware/session.ts', tokens: 2200 });
    ev(42000, { type: 'tool', agent: 'b3', tool: 'Bash', label: 'npm test session', tokens: 2200 });
    ev(44000, { type: 'message', from: 'b3', to: 'main', label: 'session mw done · rotation fixed', tokens: 5000 });
    ev(44250, { type: 'complete', agent: 'b3' });
    ev(45200, { type: 'compact', agent: 'main', to: 30000, label: 'compact: build diffs folded' });
    // ── PHASE 4 · REVIEW (parallel, multi-perspective) ──
    [['rv1', 46200], ['rv2', 46700], ['rv3', 47200]].forEach(([id, t]) => { ev(t, { type: 'tool', agent: 'main', tool: 'Task', label: 'spawn ' + id, tokens: 500 }); ev(t + 250, { type: 'spawn', agent: id, parent: 'main', tokens: 2600 }); });
    ev(48000, { type: 'tool', agent: 'rv1', tool: 'Grep', label: 'localStorage token', tokens: 1600 });
    ev(50500, { type: 'message', from: 'rv1', to: 'main', label: '2 findings: token in localStorage, add CSRF', tokens: 5200 });
    ev(50750, { type: 'complete', agent: 'rv1' });
    ev(48500, { type: 'tool', agent: 'rv2', tool: 'Bash', label: 'npm run coverage', tokens: 2800 });
    ev(51500, { type: 'message', from: 'rv2', to: 'main', label: 'coverage 88% · 1 flaky test', tokens: 4600 });
    ev(51750, { type: 'complete', agent: 'rv2' });
    ev(49000, { type: 'tool', agent: 'rv3', tool: 'Read', label: 'diff review', tokens: 3000 });
    ev(52000, { type: 'message', from: 'rv3', to: 'main', label: 'approved · 3 nits', tokens: 4200 });
    ev(52250, { type: 'complete', agent: 'rv3' });
    ev(53200, { type: 'tool', agent: 'main', tool: 'Edit', label: 'store token in httpOnly cookie', tokens: 2600 });
    ev(55200, { type: 'tool', agent: 'main', tool: 'Edit', label: 'add CSRF token', tokens: 1800 });
    ev(57000, { type: 'tool', agent: 'main', tool: 'Bash', label: 'npm test (full suite)', tokens: 3400 });
    ev(59500, { type: 'complete', agent: 'main', label: 'OAuth2 login shipped · PR #482' });
    NEW.push({ name: '★ Claude Code · Feature Delivery', desc: 'Full research → plan → build → review lifecycle: Task subagents, plan mode, compaction and a parallel multi-perspective review.', agents: ag, events: E });
  })();

  // ── Pattern · Sequential Pipeline ──
  (function () {
    const stages = [['s1', '1 · Ingest', 'cyan'], ['s2', '2 · Clean', 'cyan'], ['s3', '3 · Transform', 'purple'], ['s4', '4 · Validate', 'green'], ['s5', '5 · Report', 'pink']];
    const ag = [A('drv', 'Pipeline driver', 'gold', 200000, 'Run a 5-stage sequential ETL pipeline; each stage starts only when the previous finishes and hands its output forward.', 'orchestrator')];
    stages.forEach(([id, nm, c]) => ag.push(A(id, nm, c, 100000, 'Stage: ' + nm, 'stage')));
    const E = []; const ev = (t, o) => E.push(Object.assign({ t }, o));
    ev(0, { type: 'spawn', agent: 'drv', tokens: 2400 });
    ev(700, { type: 'message', to: 'drv', label: 'Run nightly ETL on sales_2026 dataset', tokens: 1200 });
    let t = 1800;
    stages.forEach(([id, nm], i) => {
      ev(t, { type: 'tool', agent: 'drv', tool: 'Task', label: 'start ' + nm, tokens: 500 });
      ev(t + 250, { type: 'spawn', agent: id, parent: 'drv', tokens: 2400 });
      if (i > 0) ev(t + 350, { type: 'message', from: stages[i - 1][0], to: id, label: 'handoff: ' + stages[i - 1][1] + ' output', tokens: 5200 });
      ev(t + 1700, { type: 'tool', agent: id, tool: i < 2 ? 'Read' : i < 4 ? 'Bash' : 'Write', label: nm + ' work', tokens: 2600 });
      ev(t + 3700, { type: 'message', from: id, to: 'drv', label: nm + ' complete', tokens: 3400 });
      ev(t + 3950, { type: 'complete', agent: id });
      t += 4700;
    });
    ev(t + 400, { type: 'complete', agent: 'drv', label: 'Pipeline finished · 5/5 stages' });
    NEW.push({ name: 'Pattern · Sequential Pipeline', desc: 'Strictly ordered stages — each subagent starts only after the prior one hands off its output.', agents: ag, events: E });
  })();

  // ── Pattern · Orchestrator (Operator) ──
  (function () {
    const tasks = ['search papers', 'pull metrics', 'check pricing', 'scan news', 'vendor docs', 'expert take'];
    const cols = ['cyan', 'cyan', 'purple', 'cyan', 'purple', 'pink'];
    const ag = [A('op', 'Operator', 'gold', 200000, 'Answer a research question by adaptively dispatching tool-worker subagents and synthesizing their results — the brain stays separate from the doing.', 'orchestrator')];
    tasks.forEach((tk, i) => ag.push(A('w' + (i + 1), 'Worker · ' + tk, cols[i], 80000, 'Tool worker: ' + tk, 'worker')));
    const E = []; const ev = (t, o) => E.push(Object.assign({ t }, o));
    ev(0, { type: 'spawn', agent: 'op', tokens: 2600 });
    ev(700, { type: 'message', to: 'op', label: 'Q: is solid-state battery viable by 2028?', tokens: 1300 });
    ev(1900, { type: 'tool', agent: 'op', tool: 'TodoWrite', label: 'decompose question', tokens: 900 });
    const disp = [2600, 3300, 4000, 7200, 7900, 14500];
    tasks.forEach((tk, i) => {
      const id = 'w' + (i + 1), t = disp[i];
      ev(t, { type: 'tool', agent: 'op', tool: 'Task', label: 'dispatch: ' + tk, tokens: 500 });
      ev(t + 250, { type: 'spawn', agent: id, parent: 'op', tokens: 2000 });
      ev(t + 1400, { type: 'tool', agent: id, tool: i % 2 ? 'WebFetch' : 'WebSearch', label: tk, tokens: 2400 });
      ev(t + 3600, { type: 'message', from: id, to: 'op', label: tk + ' → result', tokens: 5200 + i * 400 });
      ev(t + 3850, { type: 'complete', agent: id });
    });
    ev(18500, { type: 'compact', agent: 'op', to: 16000, label: 'compact: worker results folded' });
    ev(19500, { type: 'tool', agent: 'op', tool: 'Skill', label: 'Skill: synthesize', tokens: 4200 });
    ev(23000, { type: 'complete', agent: 'op', label: 'Synthesized answer delivered' });
    NEW.push({ name: 'Pattern · Orchestrator (Operator)', desc: 'One brain plans, dispatches tool-worker subagents (adapting as results arrive), then synthesizes.', agents: ag, events: E });
  })();

  // ── Pattern · Split & Merge ──
  (function () {
    const ag = [
      A('root', 'Splitter', 'gold', 200000, 'Split a large refactor into 4 independent branches, run them in parallel, then merge results into one changeset.', 'orchestrator'),
      A('merge', 'Merger', 'pink', 150000, 'Merge the 4 branch outputs, resolve conflicts, produce one PR.', 'reduce')
    ];
    const br = [['br1', 'Branch · api', 'green'], ['br2', 'Branch · web', 'green'], ['br3', 'Branch · db', 'purple'], ['br4', 'Branch · docs', 'cyan']];
    br.forEach(([id, nm, c]) => ag.push(A(id, nm, c, 100000, nm + ' — rename User→Account', 'branch')));
    const E = []; const ev = (t, o) => E.push(Object.assign({ t }, o));
    ev(0, { type: 'spawn', agent: 'root', tokens: 2600 });
    ev(700, { type: 'message', to: 'root', label: 'Rename User→Account across 4 areas', tokens: 1200 });
    ev(1900, { type: 'tool', agent: 'root', tool: 'TodoWrite', label: 'split into 4 branches', tokens: 900 });
    ev(2600, { type: 'spawn', agent: 'merge', parent: 'root', tokens: 2600 });
    br.forEach(([id, nm], i) => {
      const t = 3400 + i * 550;
      ev(t, { type: 'tool', agent: 'root', tool: 'Task', label: 'fork ' + nm, tokens: 500 });
      ev(t + 250, { type: 'spawn', agent: id, parent: 'root', tokens: 2400 });
      ev(t + 1500, { type: 'tool', agent: id, tool: 'Edit', label: nm + ' edits', tokens: 2600 + i * 300 });
      ev(t + 3600, { type: 'tool', agent: id, tool: 'Bash', label: 'tests', tokens: 2000 });
      const tc = 9000 + i * 900;
      ev(tc, { type: 'message', from: id, to: 'merge', label: nm + ' branch ready', tokens: 5200 });
      ev(tc + 250, { type: 'complete', agent: id });
    });
    ev(14000, { type: 'error', agent: 'merge', label: 'merge conflict: api ↔ web' });
    ev(16000, { type: 'retry', agent: 'merge', label: 'resolve conflict' });
    ev(17000, { type: 'tool', agent: 'merge', tool: 'Edit', label: 'resolve + dedupe', tokens: 3400 });
    ev(20000, { type: 'tool', agent: 'merge', tool: 'Bash', label: 'full test suite', tokens: 3000 });
    ev(23000, { type: 'message', from: 'merge', to: 'root', label: 'merged changeset · 1 PR', tokens: 6000 });
    ev(23250, { type: 'complete', agent: 'merge' });
    ev(24200, { type: 'complete', agent: 'root', label: 'Refactor merged · PR #77' });
    NEW.push({ name: 'Pattern · Split & Merge', desc: 'Fan out into independent parallel branches, then fan back in to a single merge agent.', agents: ag, events: E });
  })();

  // ── Pattern · Agent Teams (peers messaging laterally) ──
  (function () {
    const ag = [
      A('pm', 'PM · lead', 'gold', 200000, 'Coordinate a peer team of specialist agents to ship a guest-checkout feature. Agents message each other directly, not only through the lead.', 'orchestrator'),
      A('fe', 'Frontend', 'cyan', 150000, 'Build checkout UI; agree the API contract with Backend.', 'peer'),
      A('be', 'Backend', 'purple', 150000, 'Build checkout API; define the contract with Frontend.', 'peer'),
      A('qa', 'QA', 'green', 120000, 'Write and run acceptance tests; report bugs to peers.', 'peer'),
      A('des', 'Design', 'pink', 120000, 'Provide specs and review the UI against design.', 'peer')
    ];
    const E = []; const ev = (t, o) => E.push(Object.assign({ t }, o));
    ev(0, { type: 'spawn', agent: 'pm', tokens: 2800 });
    ev(700, { type: 'message', to: 'pm', label: 'Ship guest checkout by Friday', tokens: 1300 });
    ['fe', 'be', 'qa', 'des'].forEach((id, i) => { const t = 1800 + i * 600; ev(t, { type: 'tool', agent: 'pm', tool: 'Task', label: 'brief ' + id, tokens: 500 }); ev(t + 250, { type: 'spawn', agent: id, parent: 'pm', tokens: 2600 }); });
    ev(5200, { type: 'message', from: 'des', to: 'fe', label: 'checkout specs + design tokens', tokens: 3600 });
    ev(6400, { type: 'message', from: 'fe', to: 'be', label: 'need /cart + /checkout contract', tokens: 2800 });
    ev(7600, { type: 'tool', agent: 'be', tool: 'Write', label: 'openapi.yaml', tokens: 3000 });
    ev(9000, { type: 'message', from: 'be', to: 'fe', label: 'API contract v1', tokens: 3200 });
    ev(9200, { type: 'message', from: 'be', to: 'qa', label: 'endpoints ready for tests', tokens: 2400 });
    ev(10500, { type: 'tool', agent: 'fe', tool: 'Write', label: 'Checkout.tsx', tokens: 3400 });
    ev(12000, { type: 'tool', agent: 'qa', tool: 'Bash', label: 'e2e checkout', tokens: 2800 });
    ev(13500, { type: 'error', agent: 'qa', label: 'e2e fail: tax calc' });
    ev(14000, { type: 'message', from: 'qa', to: 'be', label: 'bug: tax rounding on $x.99', tokens: 2600 });
    ev(15200, { type: 'retry', agent: 'qa', label: 'await fix' });
    ev(15600, { type: 'tool', agent: 'be', tool: 'Edit', label: 'fix tax rounding', tokens: 2200 });
    ev(17000, { type: 'message', from: 'be', to: 'qa', label: 'fixed, redeploy', tokens: 1800 });
    ev(18000, { type: 'tool', agent: 'qa', tool: 'Bash', label: 'e2e checkout', tokens: 2600 });
    ev(20000, { type: 'message', from: 'des', to: 'fe', label: 'UI review: 2 spacing nits', tokens: 1600 });
    ev(21200, { type: 'tool', agent: 'fe', tool: 'Edit', label: 'spacing fixes', tokens: 1400 });
    ev(22500, { type: 'message', from: 'qa', to: 'pm', label: 'all acceptance tests green', tokens: 3600 });
    ev(22750, { type: 'complete', agent: 'qa' });
    ev(23000, { type: 'message', from: 'fe', to: 'pm', label: 'UI done + reviewed', tokens: 3000 });
    ev(23250, { type: 'complete', agent: 'fe' });
    ev(23400, { type: 'message', from: 'be', to: 'pm', label: 'API done', tokens: 3000 });
    ev(23650, { type: 'complete', agent: 'be' });
    ev(23600, { type: 'message', from: 'des', to: 'pm', label: 'design signed off', tokens: 2000 });
    ev(23850, { type: 'complete', agent: 'des' });
    ev(25000, { type: 'complete', agent: 'pm', label: 'Checkout shipped' });
    NEW.push({ name: 'Pattern · Agent Teams', desc: 'Peer agents with defined roles that message each other laterally, then report up to the lead.', agents: ag, events: E });
  })();

  // ── Pattern · Headless Batch ──
  (function () {
    const ag = [A('run', 'Headless runner', 'gold', 300000, 'Non-interactive CI run: lint + test 10 repos in a batch, each in its own subagent, then aggregate one report. No human in the loop.', 'orchestrator')];
    for (let i = 1; i <= 10; i++) ag.push(A('j' + i, 'Job ' + String(i).padStart(2, '0'), 'green', 50000, 'Lint + test + report on repo ' + i, 'job'));
    const E = []; const ev = (t, o) => E.push(Object.assign({ t }, o));
    ev(0, { type: 'spawn', agent: 'run', tokens: 2200 });
    ev(600, { type: 'message', to: 'run', label: 'CI: nightly batch over 10 repos', tokens: 900 });
    ev(1600, { type: 'tool', agent: 'run', tool: 'TodoWrite', label: 'enqueue 10 jobs', tokens: 700 });
    for (let i = 1; i <= 10; i++) {
      const id = 'j' + i, t = 2200 + (i - 1) * 420;
      ev(t, { type: 'tool', agent: 'run', tool: 'Task', label: '--headless job ' + i, tokens: 400 });
      ev(t + 200, { type: 'spawn', agent: id, parent: 'run', tokens: 1500 });
      ev(t + 1100, { type: 'tool', agent: id, tool: 'Bash', label: 'lint', tokens: 1400 + ri(0, 600) });
      ev(t + 3000, { type: 'tool', agent: id, tool: 'Bash', label: 'test', tokens: 1600 + ri(0, 800) });
      if (i === 6) { ev(t + 4200, { type: 'error', agent: id, label: 'exit 1: 2 tests failed' }); ev(t + 6000, { type: 'retry', agent: id }); ev(t + 6800, { type: 'tool', agent: id, tool: 'Bash', label: 'test (retry)', tokens: 1500 }); }
      const tc = 9000 + i * 700;
      ev(tc, { type: 'message', from: id, to: 'run', label: 'repo ' + i + ': pass', tokens: 2400 + ri(0, 600) });
      ev(tc + 200, { type: 'complete', agent: id });
    }
    ev(18000, { type: 'compact', agent: 'run', to: 12000, label: 'compact: job logs folded' });
    ev(19000, { type: 'tool', agent: 'run', tool: 'Write', label: 'ci-report.json', tokens: 2600 });
    ev(21000, { type: 'complete', agent: 'run', label: 'Batch done · 10/10 green' });
    NEW.push({ name: 'Pattern · Headless Batch', desc: 'Non-interactive CI runner fans out identical jobs across a batch and aggregates one report.', agents: ag, events: E });
  })();

  S.unshift.apply(S, NEW);
  S.forEach(sc => sc.events.sort((a, b) => a.t - b.t));
  window.AWV_WORKFLOWS = S;
})();
