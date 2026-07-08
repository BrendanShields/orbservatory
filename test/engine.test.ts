import { expect, test } from 'bun:test';
import { parseSession } from '../web/engine';
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
