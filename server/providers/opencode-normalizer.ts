import type { AwvAgent, AwvEvent, AwvSession } from '../../shared/schema';
import { truncate } from '../normalizer';
import type { SessionNormalizer } from './types';

/**
 * Maps opencode SQLite rows (session/message/part, each with a JSON `data`
 * column) onto AWV agents and events. The provider owns the SQL and cursors;
 * this class owns dedupe, so re-read rows (pending tool parts, incomplete
 * assistant messages) never emit twice.
 */
export class OpencodeNormalizer implements SessionNormalizer {
  readonly sessionId: string;
  title = '';
  cwd?: string;
  startedAt = 0;

  private agents = new Map<string, AwvAgent>();
  private childBySession = new Map<string, string>();
  private msgRole = new Map<string, string>();
  private emittedMsg = new Set<string>();
  private emittedPart = new Set<string>();
  private erroredPart = new Set<string>();
  private erroredMsg = new Set<string>();
  private tokenMark = new Set<string>();
  private lastTokens = new Map<string, number>();
  private lastAssistant = new Map<string, { t: number; ts: number }>();
  private msgCursors = new Map<string, string>();
  private partCursors = new Map<string, string>();
  private completedRoot = false;
  private hasTitle = false;
  private contextLimits: Record<string, number> = {};

  constructor(opts: { sessionId: string }) {
    this.sessionId = opts.sessionId;
    this.title = `opencode · ${opts.sessionId.slice(0, 8)}`;
  }

  get projectName(): string {
    if (this.cwd) return this.cwd.split('/').filter(Boolean).pop() || this.cwd;
    return 'opencode';
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
      desc: `${this.projectName} · ${this.cwd || 'opencode'} · opencode · ${this.sessionId.slice(0, 8)}`,
      agents: [...this.agents.values()],
      events: events.slice(),
    };
  }

  messageCursor(sessId: string): string {
    return this.msgCursors.get(sessId) ?? '';
  }

  partCursor(sessId: string): string {
    return this.partCursors.get(sessId) ?? '';
  }

  applySessionRow(data: any, isRoot: boolean, agents: AwvAgent[] = [], events: AwvEvent[] = []) {
    if (isRoot) {
      const created = Number(data?.time?.created);
      if (!this.startedAt && Number.isFinite(created) && created > 0) this.startedAt = created;
      if (data?.directory && !this.cwd) this.cwd = String(data.directory);
      if (data?.title) { this.title = truncate(String(data.title), 80); this.hasTitle = true; }
      this.ensureRoot(this.tOf(created), created || Date.now(), agents, events);
    } else if (data?.id) {
      const created = Number(data?.time?.created) || Date.now();
      this.ensureChild(String(data.id), this.tOf(created), created, agents, events, data?.title ? String(data.title) : undefined);
    }
  }

  applyMessage(sessId: string, rowId: string, data: any, agents: AwvAgent[], events: AwvEvent[]) {
    const agentId = this.agentFor(sessId, agents, events);
    const role = String(data?.role || '');
    const msgId = String(data?.id || rowId);
    this.msgRole.set(msgId, role);
    const created = Number(data?.time?.created) || 0;
    const completed = Number(data?.time?.completed) || 0;
    const terminal = role === 'user' || completed > 0 || data?.error != null;

    if (role === 'assistant') {
      if (data?.error != null && !this.erroredMsg.has(msgId)) {
        this.erroredMsg.add(msgId);
        const ts = completed || created || Date.now();
        events.push(this.stamp({ t: this.tOf(ts), type: 'error', agent: agentId, label: truncate(errorLabel(data.error), 96) }, ts));
      }
      if (completed > 0 && !this.emittedMsg.has(msgId)) {
        this.emittedMsg.add(msgId);
        this.lastAssistant.set(agentId, { t: this.tOf(completed), ts: completed });
        const total = totalOf(data?.tokens);
        if (total != null) this.pushTokenDelta(agentId, total, completed, events, data?.summary === true);
        const model = strOrUndef(data?.modelID ?? data?.model);
        if (model) this.setModel(agentId, model, agents);
      }
    }
    if (terminal) this.advance(this.msgCursors, sessId, rowId);
  }

  applyPart(sessId: string, rowId: string, data: any, agents: AwvAgent[], events: AwvEvent[]) {
    const agentId = this.agentFor(sessId, agents, events);
    const partId = String(data?.id || rowId);
    const type = String(data?.type || '');
    const msgId = String(data?.messageID || '');
    const role = this.msgRole.get(msgId) || '';

    if (type === 'text' && role === 'user') {
      if (!this.emittedPart.has(partId)) {
        this.emittedPart.add(partId);
        const text = String(data?.text ?? '');
        if (text.trim()) {
          if (!this.hasTitle) { this.title = truncate(text, 80); this.hasTitle = true; }
          const ts = Number(data?.time?.start) || Date.now();
          events.push(this.stamp({ t: this.tOf(ts), type: 'message', to: agentId, label: truncate(text, 120) }, ts));
        }
      }
      this.advance(this.partCursors, sessId, rowId);
      return;
    }

    if (type === 'tool') {
      const state = data?.state ?? {};
      const status = String(state.status || '');
      const started = Number(state.time?.start) || 0;
      if (started > 0 && !this.emittedPart.has(partId)) {
        this.emittedPart.add(partId);
        const tool = String(data?.tool || 'tool');
        const label = truncate(String(state.title || summarizeInput(state.input)), 90);
        events.push(this.stamp({ t: this.tOf(started), type: 'tool', agent: agentId, tool, label, useId: strOrUndef(data?.callID) }, started));
        if (tool === 'task') {
          const childSess = strOrUndef(state.metadata?.sessionID ?? state.metadata?.sessionId ?? state.metadata?.session_id);
          if (childSess) this.ensureChild(childSess, this.tOf(started), started, agents, events, strOrUndef(state.input?.description));
        }
      }
      const ended = Number(state.time?.end) || 0;
      if (status === 'error' && !this.erroredPart.has(partId)) {
        this.erroredPart.add(partId);
        const ts = ended || started || Date.now();
        events.push(this.stamp({ t: this.tOf(ts), type: 'error', agent: agentId, label: truncate(String(state.error ?? `${data?.tool || 'tool'} failed`), 96) }, ts));
      }
      if ((status === 'completed' || status === 'error') && ended > 0) {
        if (String(data?.tool || '') === 'task') {
          const childSess = strOrUndef(state.metadata?.sessionID ?? state.metadata?.sessionId ?? state.metadata?.session_id);
          const childAgent = childSess ? this.childBySession.get(childSess) : undefined;
          if (childAgent && !this.tokenMark.has(`complete:${childAgent}`)) {
            this.tokenMark.add(`complete:${childAgent}`);
            const a = this.agents.get(childAgent);
            if (a) a.finalStatus = status === 'error' ? 'error' : 'completed';
            events.push(this.stamp({ t: this.tOf(ended), type: 'complete', agent: childAgent, label: status }, ended));
          }
        }
        this.advance(this.partCursors, sessId, rowId);
      }
      return;
    }

    if (type === 'step-finish') {
      if (!this.emittedPart.has(partId)) {
        this.emittedPart.add(partId);
        const total = totalOf(data?.tokens);
        if (total != null) {
          const ts = Number(data?.time?.end ?? data?.time?.start) || Date.now();
          this.pushTokenDelta(agentId, total, ts, events, false);
        }
      }
      this.advance(this.partCursors, sessId, rowId);
      return;
    }

    this.advance(this.partCursors, sessId, rowId);
  }

  /** No explicit session-end marker exists; when the liveness window closes, mark the last assistant turn complete. */
  finalizeIfIdle(): { agents: AwvAgent[]; events: AwvEvent[] } | null {
    if (this.completedRoot) return null;
    const rootId = `session:${this.sessionId}`;
    const last = this.lastAssistant.get(rootId);
    if (!last) return null;
    this.completedRoot = true;
    const root = this.agents.get(rootId);
    if (root) root.finalStatus = 'completed';
    const ev = this.stamp({ t: last.t, type: 'complete', agent: rootId, label: 'completed' }, last.ts);
    return { agents: root ? [root] : [], events: [ev] };
  }

  private agentFor(sessId: string, agents: AwvAgent[], events: AwvEvent[]): string {
    if (sessId === this.sessionId) {
      this.ensureRoot(0, this.startedAt || Date.now(), agents, events);
      return `session:${this.sessionId}`;
    }
    return this.ensureChild(sessId, 0, this.startedAt || Date.now(), agents, events);
  }

  private ensureRoot(t: number, ts: number, agents: AwvAgent[], events: AwvEvent[]) {
    const id = `session:${this.sessionId}`;
    if (this.agents.has(id)) return;
    const agent: AwvAgent = { id, name: truncate(this.projectName, 54), color: 'cyan', task: this.cwd, role: 'root', source: 'transcript' };
    this.agents.set(id, agent);
    agents.push(agent);
    events.push(this.stamp({ t, type: 'spawn', agent: id, tokens: 0 }, ts));
  }

  private ensureChild(childSess: string, t: number, ts: number, agents: AwvAgent[], events: AwvEvent[], name?: string): string {
    const existing = this.childBySession.get(childSess);
    if (existing) {
      if (name) {
        const a = this.agents.get(existing);
        if (a && !a.task) { a.task = truncate(name, 120); if (!agents.some((x) => x.id === existing)) agents.push(a); }
      }
      return existing;
    }
    const rootId = `session:${this.sessionId}`;
    this.ensureRoot(t, ts, agents, events);
    const id = `${rootId}:agent-${childSess}`;
    const agent: AwvAgent = {
      id,
      name: truncate(name ? `task · ${name}` : `task · ${childSess.slice(0, 7)}`, 60),
      color: pickColor(id),
      task: name,
      role: 'subagent',
      source: 'transcript',
    };
    this.agents.set(id, agent);
    this.childBySession.set(childSess, id);
    agents.push(agent);
    events.push(this.stamp({ t, type: 'spawn', agent: id, parent: rootId, tokens: 0 }, ts));
    return id;
  }

  private pushTokenDelta(agentId: string, total: number, ts: number, events: AwvEvent[], summary: boolean) {
    const prev = this.lastTokens.get(agentId) ?? 0;
    const diff = total - prev;
    if (summary || diff < -1_000) {
      events.push(this.stamp({ t: this.tOf(ts), type: 'compact', agent: agentId, to: total, label: 'context compacted' }, ts));
    } else if (diff > 0) {
      events.push(this.stamp({ t: this.tOf(ts), type: 'message', from: agentId, to: agentId, label: 'assistant reply', tokens: diff }, ts));
    }
    this.lastTokens.set(agentId, total);
  }

  private setModel(agentId: string, model: string, agents: AwvAgent[]) {
    const a = this.agents.get(agentId);
    if (!a || a.model === model) return;
    a.model = model;
    const lim = this.contextLimits[model];
    if (lim != null) a.limit = lim;
    if (!agents.some((x) => x.id === agentId)) agents.push(a);
  }

  private advance(cursors: Map<string, string>, sessId: string, rowId: string) {
    const cur = cursors.get(sessId) ?? '';
    if (rowId > cur) cursors.set(sessId, rowId);
  }

  private tOf(ts: number): number {
    if (!Number.isFinite(ts) || ts <= 0) return 0;
    if (!this.startedAt) this.startedAt = ts;
    return Math.max(0, ts - this.startedAt);
  }

  private stamp<T extends AwvEvent>(event: T, ts: number): T {
    if (Number.isFinite(ts) && ts > 0) event.ts = new Date(ts).toISOString();
    return event;
  }
}

function totalOf(tokens: any): number | null {
  if (!tokens || typeof tokens !== 'object') return null;
  let sum = 0;
  let seen = false;
  for (const k of ['input', 'output', 'reasoning']) {
    const n = Number(tokens[k]);
    if (Number.isFinite(n)) { sum += n; seen = true; }
  }
  const cache = tokens.cache;
  if (cache && typeof cache === 'object') {
    for (const k of ['read', 'write']) {
      const n = Number(cache[k]);
      if (Number.isFinite(n)) { sum += n; seen = true; }
    }
  }
  return seen ? sum : null;
}

function errorLabel(error: any): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') return String(error.data?.message ?? error.message ?? error.name ?? 'error');
  return 'error';
}

function summarizeInput(input: any): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const preferred = ['description', 'command', 'filePath', 'file_path', 'path', 'pattern', 'query', 'url'];
  for (const key of preferred) {
    if (input[key] != null) return `${key}: ${String(input[key])}`;
  }
  const entries = Object.entries(input).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return entries.join(', ');
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
