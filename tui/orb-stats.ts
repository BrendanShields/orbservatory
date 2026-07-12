import { runClient, makeScreen, type TuiState } from './client';
import { renderStats } from './render';

const i = process.argv.indexOf('--session');
const sessionId = i >= 0 ? process.argv[i + 1] : '';
if (!sessionId) {
  console.error('usage: orb-stats --session <claude-session-id>');
  process.exit(2);
}

let state: TuiState | null = null;
const schedule = makeScreen(() => state ? renderStats(state, process.stdout.columns || 40, Date.now()) : 'starting…');
// Re-render every few seconds even without server traffic so the activity age ticks.
setInterval(schedule, 5000);
void runClient(sessionId, (s) => { state = s; schedule(); });
