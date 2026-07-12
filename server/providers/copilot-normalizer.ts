import type { AwvAgent, AwvEvent, AwvSession } from '../../shared/schema';
import { truncate } from '../normalizer';
import type { SessionNormalizer } from './types';

/**
 * Best-effort mapping of Copilot CLI `events.jsonl` lines. The format is
 * closed source and pre-1.0: unknown event types are skipped, missing fields
 * get defaults, and nothing here throws on malformed data.
 */
export class CopilotNormalizer implements SessionNormalizer {
  readonly sessionId: string;
  title = '';
  cwd?: string;
  startedAt = 0;
  private lastTs = 0;
  private hasTitle = false;

  private agents = new Map<string, AwvAgent>();
  private toolById = new Map<string, Extract<AwvEvent, { type: 'tool' }>>();
  private childCount = 0;
  private contextLimits: Record<string, number> = {};

  constructor(opts: { sessionId: string }) {
    this.sessionId = opts.sessionId;
    this.title = `copilot · ${opts.sessionId.slice(0, 8)}`;
  }

  get projectName(): string {
    if (this.cwd) return this.cwd.split('/').filter(Boolean).pop() || this.cwd;
    return 'copilot';
  }

  setContextLimits(limits: Record<string, number>): AwvAgent[] {
    this.contextLimits = limits ?? {};
    const changed: AwvAgent[] = [];
    for (const agent of this.agents.values()) {
      const next = agent.model ? this.contextLimits[agent.model] : undefined;
      if (agent.limit !== next) {
        agent.limit = next;
        changed.push(agent);
      }
    }
    return changed;
  }

  snapshot(events: AwvEvent[]): AwvSession {
    return {
      name: this.title,
      desc: `${this.projectName} · ${this.cwd || 'copilot'} · copilot · ${this.sessionId.slice(0, 8)}`,
      agents: [...this.agents.values()],
      events: events.slice(),
    };
  }

  peekLine(raw: string) {
    const rec = safeJson(raw);
    if (!rec || typeof rec !== 'object') return;
    const data = rec.data ?? {};
    const ts = Date.parse(rec.timestamp || '');
    if (!this.startedAt && Number.isFinite(ts)) this.startedAt = ts;
    if (!this.cwd) this.cwd = strOrUndef(data.cwd ?? data.workingDirectory ?? data.repository?.path);
    if (!this.hasTitle) {
      const text = messageText(rec);
      if (text && messageRole(rec) !== 'assistant') { this.title = truncate(text, 80); this.hasTitle = true; }
    }
  }

  normalizeLine(raw: unknown): { agents: AwvAgent[]; events: AwvEvent[] } {
    const rec = typeof raw === 'string' ? safeJson(raw) : raw;
    if (!rec || typeof rec !== 'object') return { agents: [], events: [] };
    const type = String((rec as any).type || '');
    const data = (rec as any).data ?? {};
    const { ts, t } = this.clock(rec);
    const agents: AwvAgent[] = [];
    const events: AwvEvent[] = [];
    const rootId = `session:${this.sessionId}`;
    const push = (e: AwvEvent) => { events.push(stamp(e, ts)); };
    this.ensureRoot(type === 'session.start' ? data : null, t, ts, agents, events);

    if (type === 'session.start') return { agents, events };

    if (type === 'tool.execution_start') {
      const tool = String(data.toolName ?? data.tool ?? data.name ?? 'tool');
      const useId = strOrUndef(data.toolCallId ?? data.callId ?? data.id);
      const ev: Extract<AwvEvent, { type: 'tool' }> = { t, type: 'tool', agent: rootId, tool, label: summarize(data.arguments ?? data.input), useId };
      if (useId) this.toolById.set(useId, ev);
      push(ev);
      return { agents, events };
    }

    if (type === 'tool.execution_complete') {
      const useId = strOrUndef(data.toolCallId ?? data.callId ?? data.id);
      const toolEv = useId ? this.toolById.get(useId) : undefined;
      if (data.success === false) {
        if (toolEv && toolEv.exitCode == null) toolEv.exitCode = 1;
        push({ t, type: 'error', agent: rootId, label: truncate(String(data.error ?? data.message ?? `${toolEv?.tool || 'tool'} failed`), 96) });
      }
      return { agents, events };
    }

    if (type === 'subagentStart' || type === 'subagent.start') {
      this.childCount++;
      const bare = strOrUndef(data.agentId ?? data.id) || `sub-${this.childCount}`;
      const name = strOrUndef(data.name ?? data.agentType) || 'subagent';
      const childId = `${rootId}:agent-${bare}`;
      if (!this.agents.has(childId)) {
        const child: AwvAgent = { id: childId, name: truncate(name, 60), color: pickColor(childId), role: 'subagent', task: strOrUndef(data.description ?? data.task), source: 'transcript' };
        this.agents.set(childId, child);
        agents.push(child);
        push({ t, type: 'spawn', agent: childId, parent: rootId, tokens: 0 });
      }
      return { agents, events };
    }

    if (type === 'session.shutdown') {
      const root = this.agents.get(rootId);
      if (root) root.finalStatus = 'completed';
      const tokens = metricsTokens(data.modelMetrics ?? data.metrics);
      if (tokens > 0) push({ t, type: 'message', from: rootId, to: rootId, label: 'session totals', tokens });
      push({ t, type: 'complete', agent: rootId, label: 'session ended' });
      return { agents, events };
    }

    const text = messageText(rec);
    if (text) {
      const role = messageRole(rec);
      if (role === 'assistant') {
        push({ t, type: 'message', from: rootId, to: rootId, label: truncate(text, 96) });
      } else {
        if (!this.hasTitle) { this.title = truncate(text, 80); this.hasTitle = true; }
        push({ t, type: 'message', to: rootId, label: truncate(text, 120) });
      }
    }
    return { agents, events };
  }

  private ensureRoot(startData: any, t: number, ts: number, agents: AwvAgent[], events: AwvEvent[]) {
    const id = `session:${this.sessionId}`;
    let root = this.agents.get(id);
    if (!root) {
      root = { id, name: truncate(this.projectName, 54), color: 'cyan', task: this.cwd, role: 'root', source: 'transcript' };
      this.agents.set(id, root);
      agents.push(root);
      events.push(stamp({ t, type: 'spawn', agent: id, tokens: 0 }, ts));
    }
    if (startData && typeof startData === 'object') {
      const cwd = strOrUndef(startData.cwd ?? startData.workingDirectory ?? startData.repository?.path);
      if (cwd && !this.cwd) { this.cwd = cwd; root.name = truncate(this.projectName, 54); root.task = cwd; }
      const repo = strOrUndef(startData.repository?.name ?? startData.repository);
      const branch = strOrUndef(startData.branch ?? startData.repository?.branch);
      if (repo) root.task = `${repo}${branch ? ` @ ${branch}` : ''}${this.cwd ? ` · ${this.cwd}` : ''}`;
      if (!agents.some((a) => a.id === id)) agents.push(root);
    }
  }

  private clock(rec: any): { ts: number; t: number } {
    const n = Date.parse(rec.timestamp || '');
    const real = Number.isFinite(n) ? n : null;
    if (real) { this.lastTs = real; if (!this.startedAt) this.startedAt = real; }
    const ts = real ?? (this.lastTs || Date.now());
    return { ts, t: this.startedAt ? Math.max(0, ts - this.startedAt) : 0 };
  }
}

export function messageText(rec: any): string {
  const type = String(rec.type || '');
  if (!/message/i.test(type)) return '';
  const data = rec.data ?? {};
  const v = data.content ?? data.text ?? data.message ?? rec.content ?? rec.text;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join(' ');
  if (v && typeof v === 'object') return String(v.text ?? '');
  return '';
}

export function messageRole(rec: any): string {
  const type = String(rec.type || '').toLowerCase();
  const role = String(rec.data?.role ?? rec.role ?? '').toLowerCase();
  if (role) return role;
  if (type.includes('assistant') || type.includes('agent')) return 'assistant';
  return 'user';
}

function metricsTokens(metrics: any): number {
  let sum = 0;
  const walk = (obj: any, depth: number) => {
    if (!obj || typeof obj !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v) && /token/i.test(k)) sum += v;
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(metrics, 0);
  return sum;
}

export function summarize(args: any): string {
  if (args == null) return '';
  if (typeof args === 'string') {
    const parsed = safeJson(args);
    if (parsed && typeof parsed === 'object') return summarize(parsed);
    return truncate(args, 90);
  }
  if (typeof args !== 'object') return truncate(String(args), 90);
  const preferred = ['command', 'query', 'path', 'file_path', 'pattern', 'url'];
  for (const key of preferred) {
    if (args[key] != null) return truncate(`${key}: ${String(args[key])}`, 90);
  }
  const entries = Object.entries(args).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return truncate(entries.join(', '), 90);
}

function strOrUndef(v: any): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

const COLORS = ['gold', 'purple', 'pink', 'green', 'slate'];
function pickColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

function stamp<T extends AwvEvent>(event: T, ts: number): T {
  event.ts = new Date(ts).toISOString();
  return event;
}

function safeJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}
