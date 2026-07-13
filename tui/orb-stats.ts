#!/usr/bin/env bun
import { runClient, type TuiState } from './client';
import { renderStats } from './render';
import { makeScreen } from './screen';

const i = process.argv.indexOf('--session');
const sessionId = i >= 0 ? process.argv[i + 1] : '';
if (!sessionId) {
  console.error('usage: orb-stats --session <claude-session-id>');
  process.exit(2);
}

let state: TuiState | null = null;
let tick = 0;
const burn: number[] = [];
const screen = await makeScreen({ orb: true, onResize: () => redraw() });
const redraw = () => {
  if (!state) return screen.set('starting…');
  screen.setTitle(` orb · ${state.summary?.title || state.sessionId.slice(0, 8)} `);
  screen.set(renderStats(state, screen.textWidth(), Date.now(), tick, burn));
};
// Spinner + activity age tick.
setInterval(() => { tick++; redraw(); }, 100);
// Sample context size for the burn sparkline.
setInterval(() => {
  if (!state) return;
  burn.push(state.ctxTokens);
  if (burn.length > 60) burn.shift();
}, 5000);
void runClient(sessionId, (s) => { state = s; redraw(); });
