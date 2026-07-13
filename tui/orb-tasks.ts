#!/usr/bin/env bun
import { runClient, type TuiState } from './client';
import { renderTasks, tasksTitle } from './render';
import { makeScreen } from './screen';

const i = process.argv.indexOf('--session');
const sessionId = i >= 0 ? process.argv[i + 1] : '';
if (!sessionId) {
  console.error('usage: orb-tasks --session <claude-session-id>');
  process.exit(2);
}

let state: TuiState | null = null;
let tick = 0;
const screen = await makeScreen({ title: ' tasks ', onResize: () => redraw() });
const redraw = () => {
  if (!state) return screen.set('starting…');
  screen.setTitle(tasksTitle(state));
  screen.set(renderTasks(state, screen.textWidth(), screen.textHeight(), tick));
};
// Spinner tick for in-progress tasks.
setInterval(() => { tick++; redraw(); }, 120);
void runClient(sessionId, (s) => { state = s; redraw(); });
