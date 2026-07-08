import type { AwvAgent, AwvEvent, AwvSession } from '../shared/schema';
import { hashStr } from '../shared/order';

export interface TranscriptSource {
  sessionId: string;
  project: string;
  cwd?: string;
  filePath: string;
  kind: 'root' | 'subagent' | 'workflow-agent' | 'workflow-journal';
  agentId?: string;
  workflowId?: string;
  meta?: SubagentMeta | null;
}

interface Enrichment {
  agentType?: string;
  subagentType?: string;
  model?: string;
  durationMs?: number;
  finalStatus?: AwvAgent['finalStatus'];
  totalTokens?: number;
  toolCount?: number;
  toolStats?: AwvAgent['toolStats'];
  result?: string;
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  slug?: string;
}

export interface NormalizedBatch {
  agents: AwvAgent[];
  events: AwvEvent[];
  titleChanged?: boolean;
}

const HOUSEKEEPING_TYPES = new Set(['attachment', 'file-history-snapshot', 'mode', 'permission-mode', 'queue-operation', 'system', 'progress', 'cost']);
// Most current Claude models have a 1M-token context window; Haiku 4.5 and the Claude 3.x
// generation are 200k. Unknown models get the 1M default.
export const DEFAULT_CONTEXT_LIMIT = 1_000_000;
const SMALL_CONTEXT = /claude-(haiku-4-5|3-)/;

export function contextLimitFor(model: string | undefined): number {
  if (model && SMALL_CONTEXT.test(model)) return 200_000;
  return DEFAULT_CONTEXT_LIMIT;
}
const COLORS = ['cyan', 'gold', 'purple', 'pink', 'green', 'slate'];
const META_CONTENT = /<command-name>|<command-message>|<local-command-caveat>|<local-command-stdout>|<system-reminder>/;

export class TranscriptNormalizer {
  readonly sessionId: string;
  readonly project: string;
  readonly contextLimit: number;
  title: string;
  cwd?: string;
  startedAt = 0;

  private agents = new Map<string, AwvAgent>();
  private spawned = new Set<string>();
  private completed = new Set<string>();
  private lastTokens = new Map<string, number>();
  private byToolUseId = new Map<string, string>();
  private byAgentId = new Map<string, string>();
  private sourceAgents = new Map<string, string>();
  private pendingEnrichment = new Map<string, Enrichment>();
  private pendingComplete = new Map<string, { status: string; t: number; ts: string }>();
  private pendingSpawn = new Map<string, { subagentType?: string; description?: string }>();
  private wfMeta = new Map<string, { workflowName: string; summary?: string }>();
  private toolByUseId = new Map<string, Extract<AwvEvent, { type: 'tool' }>>();
  private nameRank = new Map<string, number>();
  private dirty = new Set<string>();
  private titleRank = 0;

  private contextLimits: Record<string, number>;

  constructor(opts: { sessionId: string; project: string; cwd?: string; contextLimit?: number; contextLimits?: Record<string, number> }) {
    this.sessionId = opts.sessionId;
    this.project = opts.project;
    this.cwd = opts.cwd;
    this.title = decodeProjectName(opts.project);
    this.contextLimit = opts.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    this.contextLimits = opts.contextLimits ?? {};
  }

  setContextLimits(limits: Record<string, number>): AwvAgent[] {
    this.contextLimits = limits ?? {};
    const changed: AwvAgent[] = [];
    for (const agent of this.agents.values()) {
      if (!agent.model) continue;
      const next = this.limitFor(agent.model);
      if (agent.limit !== next) {
        agent.limit = next;
        changed.push(agent);
      }
    }
    return changed;
  }

  private limitFor(model: string): number {
    return this.contextLimits[model] ?? contextLimitFor(model);
  }

  get projectName(): string {
    if (this.cwd) return this.cwd.split('/').filter(Boolean).pop() || this.cwd;
    return decodeProjectName(this.project);
  }

  snapshot(events: AwvEvent[]): AwvSession {
    return {
      name: this.title,
      desc: `${this.projectName} · ${this.cwd || decodeProjectName(this.project)} · ${this.sessionId.slice(0, 8)}`,
      agents: [...this.agents.values()],
      // Events arrive pre-sorted from the store; keep them as-is so indexes stay stable.
      events: events.slice(),
    };
  }

  /** Cheap metadata extraction for unloaded historical sessions: updates cwd/title/startedAt without emitting events. */
  peekLine(raw: string) {
    const rec = safeJson(raw);
    if (!rec || typeof rec !== 'object') return;
    if (rec.cwd && !this.cwd) this.cwd = rec.cwd;
    const type = String(rec.type || '');
    if (!this.startedAt && rec.timestamp && (type === 'user' || type === 'assistant')) {
      const ts = Date.parse(rec.timestamp);
      if (Number.isFinite(ts)) this.startedAt = ts;
    }
    if (type === 'ai-title') this.setTitle(String(rec.aiTitle ?? rec.title ?? ''), 3);
    else if (type === 'summary') this.setTitle(String(rec.summary ?? ''), 2);
    else if (type === 'user' && !rec.isMeta) {
      const blocks = contentBlocks(rec.message?.content ?? rec.content);
      if (!blocks.some((b) => b && typeof b === 'object' && b.type === 'tool_result')) {
        const text = textFromContent(rec.message?.content ?? rec.content);
        if (text && !META_CONTENT.test(text)) this.setTitle(text, 1);
      }
    }
  }

  private setTitle(text: string, rank: number): boolean {
    const t = truncate(text, 80);
    if (!t) return false;
    // Higher-rank sources win; equal rank only re-applies for summary/ai-title (latest wins), not prompts.
    if (rank < this.titleRank || (rank === this.titleRank && rank <= 1)) return false;
    const changed = this.title !== t;
    this.title = t;
    this.titleRank = rank;
    return changed;
  }

  getAgents(): AwvAgent[] {
    return [...this.agents.values()];
  }

  normalizeLine(raw: unknown, source: TranscriptSource): NormalizedBatch {
    const line = typeof raw === 'string' ? safeJson(raw) : raw;
    if (!line || typeof line !== 'object') return { agents: [], events: [] };
    const rec = line as any;
    const type = String(rec.type || '');
    if (type === 'summary') return { agents: [], events: [], titleChanged: this.setTitle(String(rec.summary ?? ''), 2) };
    if (type === 'ai-title') return { agents: [], events: [], titleChanged: this.setTitle(String(rec.aiTitle ?? rec.title ?? ''), 3) };
    if (HOUSEKEEPING_TYPES.has(type)) return { agents: [], events: [] };

    if (rec.cwd && !this.cwd) {
      this.cwd = rec.cwd;
      const root = this.agents.get(rootAgentId(this.sessionId));
      if (root) { root.name = truncate(this.projectName, 54); root.task = this.cwd; }
    }
    this.dirty.clear();
    const ts = timestampOf(rec);
    if (!this.startedAt) this.startedAt = ts;
    const t = Math.max(0, ts - this.startedAt);
    const agentId = this.ensureSourceAgent(source, rec, t, new Date(ts).toISOString());
    const agents: AwvAgent[] = [];
    const events: AwvEvent[] = [];
    this.flushSpawns(agents, events);
    const maybePush = (e: AwvEvent | null | undefined) => { if (e) events.push(stamp(e, ts)); };

    if (rec.type === 'user') {
      const rawText = textFromContent(rec.message?.content ?? rec.content);
      if (rawText.includes('<task-notification>')) {
        this.completeFromNotifications(rawText, t, ts, events);
        return this.finish(agents, events);
      }
      if (rec.isMeta) return this.finish(agents, events);
      const blocks = contentBlocks(rec.message?.content ?? rec.content);
      const toolResults = blocks.filter((b) => b && typeof b === 'object' && b.type === 'tool_result');
      if (toolResults.length) {
        const tur = rec.toolUseResult;
        this.captureWorkflowMeta(tur);
        const asyncLaunched = tur && typeof tur === 'object' && tur.status === 'async_launched';
        for (const block of toolResults) {
          const toolUseId = String(block.tool_use_id || block.toolUseId || '');
          const failed = block.is_error || failedResult(tur);
          const child = this.resolveChild(toolUseId, tur);
          const label = truncate(textFromContent(block.content) || (failed ? 'tool error' : 'result'), 96);
          const toolEv = toolUseId ? this.toolByUseId.get(toolUseId) : undefined;
          if (toolEv) applyToolOutcome(toolEv, tur, failed);
          const agentEnrich = enrichmentFromAgentResult(tur);
          if (agentEnrich) {
            if (child) this.enrichAgent(child, agentEnrich);
            else if (tur?.agentId) this.pendingEnrichment.set(bareIdOf(tur.agentId), agentEnrich);
          }
          if (failed) maybePush({ t, type: 'error', agent: agentId, label });
          if (child && !this.completed.has(child) && !failed && !asyncLaunched) {
            maybePush({ t, type: 'message', from: child, to: agentId, label: label || 'result' });
            maybePush({ t: t + 40, type: 'complete', agent: child, label: statusLabel(tur) });
            this.completed.add(child);
          }
        }
      } else {
        const text = textFromContent(rec.message?.content ?? rec.content);
        if (text && META_CONTENT.test(text)) return this.finish(agents, events);
        const label = truncate(text, 120);
        if (label) {
          this.setTitle(text, 1);
          this.nameWorkflowAgentFromPrompt(source, agentId, text);
          maybePush({ t, type: 'message', to: agentId, label });
        }
      }
      return this.finish(agents, events);
    }

    if (rec.type === 'assistant') {
      const model = rec.message?.model;
      if (typeof model === 'string' && model && !model.startsWith('<')) {
        const agent = this.agents.get(agentId);
        const lim = this.limitFor(model);
        if (agent && (agent.limit !== lim || agent.model !== model)) { agent.limit = lim; agent.model = model; this.markDirty(agentId); }
      }
      const usageTotal = usageTokens(rec.message?.usage ?? rec.usage);
      const toolEvents: Array<Extract<AwvEvent, { type: 'tool' }>> = [];
      const blocks = contentBlocks(rec.message?.content ?? rec.content);
      for (const block of blocks) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
        const tool = String(block.name || 'tool');
        const useId = block.id ? String(block.id) : undefined;
        const label = summarizeInput(block.input, tool);
        const ev: Extract<AwvEvent, { type: 'tool' }> = { t: t + toolEvents.length * 30, type: 'tool', agent: agentId, tool, label, useId };
        toolEvents.push(ev);
        if (useId) {
          this.toolByUseId.set(useId, ev);
          if ((tool === 'Agent' || tool === 'Task') && block.input && typeof block.input === 'object') {
            this.pendingSpawn.set(useId, { subagentType: block.input.subagent_type, description: block.input.description });
          }
        }
      }

      if (usageTotal != null) {
        const prev = this.lastTokens.get(agentId) ?? 0;
        const diff = usageTotal - prev;
        if (diff < -1_000) {
          maybePush({ t, type: 'compact', agent: agentId, to: usageTotal, label: 'context compacted' });
        } else if (diff > 0) {
          if (toolEvents.length) {
            const parts = splitDelta(diff, toolEvents.length);
            toolEvents.forEach((ev, i) => { ev.tokens = parts[i]; });
          } else {
            maybePush({ t, type: 'message', from: agentId, to: agentId, label: 'assistant reply', tokens: diff });
          }
        }
        this.lastTokens.set(agentId, usageTotal);
      }
      for (const ev of toolEvents) maybePush(ev);
      return this.finish(agents, events);
    }

    return this.finish(agents, events);
  }

  ingestJournal(raw: unknown, source: TranscriptSource): NormalizedBatch {
    const rec = typeof raw === 'string' ? safeJson(raw) : raw;
    if (!rec || typeof rec !== 'object' || !source.workflowId) return { agents: [], events: [] };
    const bareId = bareIdOf((rec as any).agentId);
    if (!bareId) return { agents: [], events: [] };
    this.dirty.clear();
    const ts = timestampOf(rec);
    if (!this.startedAt) this.startedAt = ts;
    const t = Math.max(0, ts - this.startedAt);
    const iso = new Date(ts).toISOString();
    const wf = this.ensureWorkflowAgent(source.workflowId, this.ensureRootPlaceholder(source, t, iso).id, t, iso);
    const awvId = this.upsertSubagent(bareId, { parent: wf.id, role: 'workflow agent', t, ts: iso, wfName: this.wfMeta.get(source.workflowId)?.workflowName });
    const agents: AwvAgent[] = [];
    const events: AwvEvent[] = [];
    this.flushSpawns(agents, events);
    if ((rec as any).type === 'result' && !this.completed.has(awvId)) {
      const a = this.agents.get(awvId);
      if (a) { a.finalStatus = 'completed'; this.markDirty(awvId); }
      events.push(stamp({ t, type: 'complete', agent: awvId, label: 'completed' }, ts));
      this.completed.add(awvId);
    }
    return this.finish(agents, events);
  }

  private ensureSourceAgent(source: TranscriptSource, rec: any, t: number, ts: string): string {
    const key = source.filePath;
    const existing = this.sourceAgents.get(key);
    if (existing) return existing;

    if (source.kind === 'root') {
      const agentId = rootAgentId(this.sessionId);
      this.cwd = this.cwd || source.cwd || rec.cwd;
      if (!this.agents.has(agentId)) {
        const agent: AwvAgent = { id: agentId, name: truncate(this.projectName, 54), color: 'cyan', limit: this.contextLimit, task: this.cwd || decodeProjectName(source.project), role: 'root', source: 'transcript' };
        this.agents.set(agentId, agent);
        if (!this.spawned.has(agentId)) { this.spawned.add(agentId); (agent as any).__spawn = { t, ts }; }
      }
      this.sourceAgents.set(key, agentId);
      return agentId;
    }

    const root = this.ensureRootPlaceholder(source, t, ts);
    let parent = root.id;
    let wfName: string | undefined;
    if (source.kind === 'workflow-agent' && source.workflowId) {
      const wf = this.ensureWorkflowAgent(source.workflowId, root.id, t, ts);
      parent = wf.id;
      wfName = this.wfMeta.get(source.workflowId)?.workflowName;
    }
    const bareId = bareIdOf(source.agentId) || bareIdOf(rec.agentId) || String(source.agentId || 'subagent');
    const pend = source.meta?.toolUseId ? this.pendingSpawn.get(source.meta.toolUseId) : undefined;
    const awvId = this.upsertSubagent(bareId, {
      parent, t, ts,
      role: source.kind === 'workflow-agent' ? 'workflow agent' : 'subagent',
      agentType: source.meta?.agentType || rec.agentType,
      subagentType: pend?.subagentType,
      description: source.meta?.description || rec.description || pend?.description,
      wfName,
    });
    if (source.meta?.toolUseId) this.byToolUseId.set(source.meta.toolUseId, awvId);
    this.sourceAgents.set(key, awvId);
    return awvId;
  }

  private upsertSubagent(bareId: string, opts: { parent?: string; role?: string; t: number; ts: string; agentType?: string; subagentType?: string; description?: string; wfName?: string }): string {
    const awvId = `${rootAgentId(this.sessionId)}:agent-${bareId}`;
    const existing = this.agents.get(awvId);
    if (existing) {
      if (opts.agentType && !existing.agentType) existing.agentType = opts.agentType;
      if (opts.subagentType && !existing.subagentType) existing.subagentType = opts.subagentType;
      if (opts.description && !existing.task) existing.task = opts.description;
      const rank = opts.description ? 1 : 0;
      this.setName(awvId, this.subagentName({ ...opts, agentType: existing.agentType, subagentType: existing.subagentType, description: existing.task }, bareId), rank);
      return awvId;
    }
    const agent: AwvAgent = {
      id: awvId,
      name: this.subagentName(opts, bareId),
      color: COLORS[this.hash(awvId) % COLORS.length],
      limit: this.contextLimit,
      task: opts.description,
      role: opts.role || 'subagent',
      agentType: opts.agentType,
      subagentType: opts.subagentType,
      source: 'transcript',
    };
    this.agents.set(awvId, agent);
    this.byAgentId.set(bareId, awvId);
    this.nameRank.set(awvId, opts.description ? 1 : 0);
    if (!this.spawned.has(awvId)) { this.spawned.add(awvId); (agent as any).__spawn = { t: opts.t, ts: opts.ts, parent: opts.parent }; }
    const pe = this.pendingEnrichment.get(bareId);
    if (pe) { this.pendingEnrichment.delete(bareId); this.applyEnrichment(agent, pe); }
    return awvId;
  }

  private subagentName(opts: { agentType?: string; subagentType?: string; description?: string; wfName?: string }, bareId: string): string {
    if (opts.wfName) return truncate(`${opts.wfName}${opts.description ? ` · ${opts.description}` : ''}`, 60);
    const type = opts.subagentType || opts.agentType || 'Agent';
    const desc = opts.description || bareId.slice(0, 7);
    return truncate(`${type}${desc ? ` · ${desc}` : ''}`, 60);
  }

  private setName(awvId: string, name: string, rank: number) {
    const cur = this.nameRank.get(awvId) ?? -1;
    if (rank < cur) return;
    const a = this.agents.get(awvId);
    if (!a || a.name === name) { this.nameRank.set(awvId, Math.max(cur, rank)); return; }
    a.name = name;
    this.nameRank.set(awvId, rank);
    this.markDirty(awvId);
  }

  private nameWorkflowAgentFromPrompt(source: TranscriptSource, awvId: string, text: string) {
    if (source.kind !== 'workflow-agent') return;
    const wfName = source.workflowId ? this.wfMeta.get(source.workflowId)?.workflowName : undefined;
    const a = this.agents.get(awvId);
    if (a && !a.task) a.task = truncate(text, 120);
    this.setName(awvId, truncate(`${wfName ? `${wfName} · ` : ''}${truncate(text, 46)}`, 60), 2);
  }

  private captureWorkflowMeta(tur: any) {
    if (!tur || typeof tur !== 'object' || !tur.workflowName || !tur.runId) return;
    const summary = tur.summary ? truncate(String(tur.summary), 80) : undefined;
    this.wfMeta.set(String(tur.runId), { workflowName: String(tur.workflowName), summary });
    const id = `${rootAgentId(this.sessionId)}:${tur.runId}`;
    const wf = this.agents.get(id);
    if (wf) {
      wf.name = truncate(`${tur.workflowName}${summary ? ` · ${summary}` : ''}`, 60);
      wf.task = summary || wf.task;
      this.markDirty(id);
    }
  }

  private resolveChild(toolUseId: string, tur: any): string | undefined {
    const byUse = toolUseId ? this.byToolUseId.get(toolUseId) : undefined;
    if (byUse) return byUse;
    const bare = tur && typeof tur === 'object' ? bareIdOf(tur.agentId) : '';
    return bare ? this.byAgentId.get(bare) : undefined;
  }

  private enrichAgent(awvId: string, e: Enrichment | null) {
    if (!e) return;
    const a = this.agents.get(awvId);
    if (a) { this.applyEnrichment(a, e); this.markDirty(awvId); }
  }

  private applyEnrichment(a: AwvAgent, e: Enrichment) {
    if (e.agentType && !a.agentType) a.agentType = e.agentType;
    if (e.subagentType && !a.subagentType) a.subagentType = e.subagentType;
    if (e.model) a.model = e.model;
    if (e.durationMs != null) a.durationMs = e.durationMs;
    if (e.finalStatus) a.finalStatus = e.finalStatus;
    if (e.totalTokens != null) a.totalTokens = e.totalTokens;
    if (e.toolCount != null) a.toolCount = e.toolCount;
    if (e.toolStats) a.toolStats = e.toolStats;
    if (e.result) a.result = e.result;
  }

  private completeFromNotifications(text: string, t: number, ts: number, events: AwvEvent[]) {
    const re = /<task-id>\s*([a-z0-9-]+)\s*<\/task-id>[\s\S]{0,4000}?<status>\s*(\w+)\s*<\/status>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const awvId = `${rootAgentId(this.sessionId)}:agent-${bareIdOf(m[1])}`;
      if (this.completed.has(awvId)) continue;
      const status = m[2].toLowerCase();
      const a = this.agents.get(awvId);
      if (a) {
        a.finalStatus = status === 'failed' ? 'error' : 'completed';
        this.markDirty(awvId);
        events.push(stamp({ t, type: 'complete', agent: awvId, label: status }, ts));
        this.completed.add(awvId);
      } else {
        this.pendingComplete.set(awvId, { status, t, ts: new Date(ts).toISOString() });
      }
    }
  }

  private markDirty(awvId: string) {
    this.dirty.add(awvId);
  }

  private finish(agents: AwvAgent[], events: AwvEvent[], titleChanged?: boolean): NormalizedBatch {
    if (this.dirty.size) {
      const have = new Set(agents.map((a) => a.id));
      for (const id of this.dirty) {
        if (have.has(id)) continue;
        const a = this.agents.get(id);
        if (a) agents.push(a);
      }
      this.dirty.clear();
    }
    return { agents, events, titleChanged };
  }

  private ensureRootPlaceholder(source: TranscriptSource, t: number, ts: string): AwvAgent {
    const id = rootAgentId(this.sessionId);
    let root = this.agents.get(id);
    if (!root) {
      root = { id, name: truncate(this.projectName, 54), color: 'cyan', limit: this.contextLimit, task: source.cwd || this.cwd || decodeProjectName(source.project), role: 'root', source: 'transcript' };
      this.agents.set(id, root);
      if (!this.spawned.has(id)) {
        this.spawned.add(id);
        (root as any).__spawn = { t, ts };
      }
    }
    return root;
  }

  private ensureWorkflowAgent(workflowId: string, parent: string, t: number, ts: string): AwvAgent {
    const id = `${rootAgentId(this.sessionId)}:${workflowId}`;
    const meta = this.wfMeta.get(workflowId);
    const named = meta ? truncate(`${meta.workflowName}${meta.summary ? ` · ${meta.summary}` : ''}`, 60) : `Workflow · ${workflowId.replace(/^wf_/, '')}`;
    let wf = this.agents.get(id);
    if (!wf) {
      wf = { id, name: named, color: 'purple', limit: this.contextLimit, task: meta?.summary || 'Workflow fan-out run', role: 'workflow', source: 'transcript' };
      this.agents.set(id, wf);
      if (!this.spawned.has(id)) {
        this.spawned.add(id);
        (wf as any).__spawn = { t, ts, parent };
      }
    } else if (meta && wf.name.startsWith('Workflow · ')) {
      wf.name = named;
      wf.task = meta.summary || wf.task;
      this.markDirty(id);
    }
    return wf;
  }

  private flushSpawns(agents: AwvAgent[], events: AwvEvent[]) {
    for (const item of this.consumeNewAgents()) {
      agents.push(item.agent);
      events.push({ t: item.spawn.t, ts: item.spawn.ts, type: 'spawn', agent: item.agent.id, parent: item.spawn.parent, tokens: 0 });
      const pc = this.pendingComplete.get(item.agent.id);
      if (pc && !this.completed.has(item.agent.id)) {
        this.pendingComplete.delete(item.agent.id);
        item.agent.finalStatus = pc.status === 'failed' ? 'error' : 'completed';
        events.push({ t: Math.max(pc.t, item.spawn.t + 1), ts: pc.ts, type: 'complete', agent: item.agent.id, label: pc.status });
        this.completed.add(item.agent.id);
      }
    }
  }

  private consumeNewAgents(): Array<{ agent: AwvAgent; spawn: { t: number; ts: string; parent?: string } }> {
    const out: Array<{ agent: AwvAgent; spawn: { t: number; ts: string; parent?: string } }> = [];
    for (const agent of this.agents.values()) {
      const spawn = (agent as any).__spawn;
      if (!spawn) continue;
      delete (agent as any).__spawn;
      out.push({ agent, spawn });
    }
    return out;
  }

  private hash(s: string): number {
    return hashStr(s);
  }
}

export function rootAgentId(sessionId: string): string {
  return `session:${sessionId}`;
}

function stamp<T extends AwvEvent>(event: T, ts: number): T {
  event.ts = new Date(ts).toISOString();
  return event;
}

function safeJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}

function timestampOf(rec: any): number {
  const v = rec.timestamp || rec.createdAt || rec.time;
  const n = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(n) ? n : Date.now();
}

function contentBlocks(content: any): any[] {
  if (Array.isArray(content)) return content;
  if (content == null) return [];
  return [{ type: 'text', text: String(content) }];
}

function textFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textFromContent).filter(Boolean).join(' ');
  if (content && typeof content === 'object') return String(content.text ?? content.content ?? '');
  return '';
}

function usageTokens(usage: any): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const keys = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
  let total = 0;
  let seen = false;
  for (const k of keys) {
    const n = Number(usage[k] ?? 0);
    if (Number.isFinite(n)) { total += n; seen = true; }
  }
  return seen ? total : null;
}

function summarizeInput(input: any, tool?: string): string {
  if (input == null) return '';
  if (typeof input === 'string') return truncate(input, 90);
  if (typeof input !== 'object') return truncate(String(input), 90);
  if ((tool === 'Agent' || tool === 'Task') && (input.subagent_type || input.description)) {
    return truncate(`${input.subagent_type || 'agent'}${input.description ? `: ${input.description}` : ''}`, 90);
  }
  const preferred = ['description', 'prompt', 'command', 'file_path', 'path', 'pattern', 'query', 'url'];
  for (const key of preferred) {
    if (input[key] != null) return `${key}: ${truncate(String(input[key]), 74)}`;
  }
  const entries = Object.entries(input).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return truncate(entries.join(', '), 90);
}

function bareIdOf(x: any): string {
  if (x == null) return '';
  return String(x).replace(/^agent-/, '');
}

function failedResult(tur: any): boolean {
  if (!tur || typeof tur !== 'object') return false;
  return tur.interrupted === true || (typeof tur.exitCode === 'number' && tur.exitCode > 0);
}

function statusLabel(tur: any): string {
  const s = tur && typeof tur === 'object' ? tur.status : undefined;
  return s ? String(s) : 'completed';
}

function mapFinalStatus(tur: any): AwvAgent['finalStatus'] {
  const s = tur && typeof tur === 'object' ? String(tur.status || '') : '';
  if (s === 'completed' || s === 'error' || s === 'interrupted' || s === 'async_launched') return s;
  if (failedResult(tur)) return 'error';
  return 'completed';
}

function enrichmentFromAgentResult(tur: any): Enrichment | null {
  if (!tur || typeof tur !== 'object' || !tur.agentType) return null;
  if (tur.totalDurationMs == null && !tur.agentId && tur.totalTokens == null) return null;
  const ts = tur.toolStats && typeof tur.toolStats === 'object' ? tur.toolStats : undefined;
  return {
    agentType: String(tur.agentType),
    model: tur.resolvedModel ? String(tur.resolvedModel) : undefined,
    durationMs: numOrUndef(tur.totalDurationMs),
    finalStatus: mapFinalStatus(tur),
    totalTokens: numOrUndef(tur.totalTokens),
    toolCount: numOrUndef(tur.totalToolUseCount),
    toolStats: ts ? {
      read: numOrUndef(ts.readCount),
      edit: numOrUndef(ts.editFileCount),
      bash: numOrUndef(ts.bashCount),
      search: numOrUndef(ts.searchCount),
      other: numOrUndef(ts.otherToolCount),
      linesAdded: numOrUndef(ts.linesAdded),
      linesRemoved: numOrUndef(ts.linesRemoved),
    } : undefined,
    result: tur.content ? truncate(textFromContent(tur.content), 140) : undefined,
  };
}

function applyToolOutcome(ev: Extract<AwvEvent, { type: 'tool' }>, tur: any, failed: boolean) {
  if (tur && typeof tur === 'object') {
    if (typeof tur.exitCode === 'number') ev.exitCode = tur.exitCode;
    else if (failed) ev.exitCode = 1;
    if (typeof tur.filePath === 'string') ev.filePath = tur.filePath;
  } else if (failed) {
    ev.exitCode = 1;
  }
}

function numOrUndef(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function splitDelta(delta: number, count: number): number[] {
  const base = Math.floor(delta / count);
  const rem = delta - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
}

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, Math.max(0, n - 1)) + '…';
}

export function decodeProjectName(name: string): string {
  try { return decodeURIComponent(name).replace(/-/g, '/').split('/').filter(Boolean).pop() || name; }
  catch { return name; }
}
