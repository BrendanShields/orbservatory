import { expect, test } from 'bun:test';
import { buildWarp, parseSession, tokensAt } from '../web/engine';
import type { AwvSession } from '../shared/schema';

test('spawnT clamps to first observed activity for future-stamped or missing spawns', () => {
  const sc = {
    name: 't', desc: '',
    agents: [
      { id: 'root', name: 'Root', role: 'root' },
      { id: 'kid', name: 'Kid' },
      { id: 'ghost', name: 'Ghost' },
    ],
    events: [
      { t: 100, type: 'tool', agent: 'root', tool: 'Bash' },
      { t: 200, type: 'spawn', agent: 'kid', parent: 'root' },
      { t: 300, type: 'tool', agent: 'ghost', tool: 'Read' },
      { t: 500_000_000, type: 'spawn', agent: 'root' },
    ],
  } as unknown as AwvSession;
  const eng = parseSession(sc);
  expect(eng.agents.get('root')!.spawnT).toBe(100);
  expect(eng.agents.get('kid')!.spawnT).toBe(200);
  expect(eng.agents.get('ghost')!.spawnT).toBe(300);
});

test('spawn without token data reports zero tokens, not a fabricated floor', () => {
  const sc = {
    name: 't', desc: '',
    agents: [{ id: 'root', name: 'Root', role: 'root' }, { id: 'kid', name: 'Kid' }],
    events: [
      { t: 0, type: 'spawn', agent: 'root', tokens: 0 },
      { t: 100, type: 'spawn', agent: 'kid', parent: 'root', tokens: 0 },
      { t: 2000, type: 'tool', agent: 'root', tool: 'Bash', tokens: 500 },
    ],
  } as unknown as AwvSession;
  const eng = parseSession(sc);
  expect(tokensAt(eng.agents.get('kid')!, 5000)).toBe(0);
  expect(tokensAt(eng.agents.get('root')!, 5000)).toBe(500);
});

test('warp is identity when no gap exceeds the threshold', () => {
  const evs = [{ t: 0 }, { t: 1000 }, { t: 2000 }, { t: 3000 }];
  const warp = buildWarp(evs, 5000);
  expect(warp.gaps).toEqual([]);
  for (const t of [0, 500, 1000, 2400, 5000]) {
    expect(warp.x(t)).toBeCloseTo(t / 5000, 6);
    expect(warp.t(t / 5000)).toBeCloseTo(t, 4);
  }
});

test('warp compresses long idle gaps and stays invertible', () => {
  // 10s of activity, a 1h dead gap, 10s of activity.
  const evs: Array<{ t: number }> = [];
  for (let t = 0; t <= 10_000; t += 500) evs.push({ t });
  for (let t = 3_610_000; t <= 3_620_000; t += 500) evs.push({ t });
  const dur = 3_622_500;
  const warp = buildWarp(evs, dur);
  expect(warp.gaps).toEqual([{ t0: 10_000, t1: 3_610_000 }]);
  // Activity dominates the visual width instead of the idle hour.
  const activityShare = warp.x(10_000) + (warp.x(3_620_000) - warp.x(3_610_000));
  expect(activityShare).toBeGreaterThan(0.5);
  expect(warp.x(10_000)).toBeGreaterThan(10_000 / dur * 10);
  // Monotonic and invertible across the whole range.
  let prev = -1;
  for (let t = 0; t <= dur; t += 25_000) {
    const x = warp.x(t);
    expect(x).toBeGreaterThan(prev);
    expect(warp.t(x)).toBeCloseTo(t, 3);
    prev = x;
  }
  expect(warp.x(0)).toBe(0);
  expect(warp.x(dur)).toBeCloseTo(1, 9);
});

test('parseSession attaches a warp covering the session', () => {
  const sc = {
    name: 't', desc: '', agents: [{ id: 'root', name: 'Root' }],
    events: [
      { t: 0, type: 'tool', agent: 'root', tool: 'Bash' },
      { t: 900_000, type: 'tool', agent: 'root', tool: 'Read' },
    ],
  } as unknown as AwvSession;
  const eng = parseSession(sc);
  expect(eng.warp.gaps.length).toBe(1);
  expect(eng.warp.t(eng.warp.x(450_000))).toBeCloseTo(450_000, 3);
});
