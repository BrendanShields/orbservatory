import { runClient, makeScreen, type TuiState } from './client';
import { renderTasks } from './render';

const i = process.argv.indexOf('--session');
const sessionId = i >= 0 ? process.argv[i + 1] : '';
if (!sessionId) {
  console.error('usage: orb-tasks --session <claude-session-id>');
  process.exit(2);
}

let state: TuiState | null = null;
const schedule = makeScreen(() => state ? renderTasks(state, process.stdout.columns || 40, process.stdout.rows || 20) : 'starting…');
void runClient(sessionId, (s) => { state = s; schedule(); });
