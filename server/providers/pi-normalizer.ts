import type { AwvAgent, AwvEvent, AwvSession, SearchPart, TokenTotals } from '../../shared/schema';
import type { NormalizedBatch } from '../normalizer';
import { truncate } from '../normalizer';
import type { SessionNormalizer } from './types';

/**
 * Normalizer for pi (earendil-works/pi, formerly badlogic/pi-mono) session
 * files: one JSONL file per session, line 1 is a `{type:"session"}` header,
 * every other line a tree entry. pi has no subagents — one root agent per
 * session. Format reference: packages/coding-agent/docs/session-format.md (v3;
 * v1 files lack `version`/entry ids and carry provider/modelId on the header).
 */
export class PiNormalizer implements SessionNormalizer {
  readonly sessionId: string;
  title = '';
  cwd?: string;
  startedAt = 0;
  private lastTs = 0;
  /** 0 = default, 1 = first user prompt, 2 = session_info (latest wins). */
  private titleRank = 0;

  readonly usageByModel = new Map<string, TokenTotals>();
  readonly skills: Record<string, number> = {};
  userTurns = 0;
  parseFailures = 0;
  readonly searchParts: SearchPart[] = [];
  private searchChars = 0;

  private agents = new Map<string, AwvAgent>();
  private lastTokens = 0;
  private toolByCallId = new Map<string, Extract<AwvEvent, { type: 'tool' }>>();
  private model?: string;
  private contextLimits: Record<string, number> = {};

  constructor(opts: { sessionId: string }) {
    this.sessionId = opts.sessionId;
    this.title = `pi · ${opts.sessionId.slice(0, 8)}`;
  }

  get lastActiveTs(): number {
    return this.lastTs;
  }

  get projectName(): string {
    if (this.cwd) return this.cwd.split('/').filter(Boolean).pop() || this.cwd;
    return 'pi';
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
      desc: `${this.projectName} · ${this.cwd || 'pi'} · pi · ${this.sessionId.slice(0, 8)}`,
      agents: [...this.agents.values()],
      events: events.slice(),
    };
  }

  getAgents(): AwvAgent[] {
    return [...this.agents.values()];
  }

  peekLine(raw: string) {
    const rec = safeJson(raw);
    if (!rec || typeof rec !== 'object') return;
    if (rec.type === 'session') {
      if (rec.cwd && !this.cwd) this.cwd = String(rec.cwd);
      const ts = Date.parse(rec.timestamp || '');
      if (!this.startedAt && Number.isFinite(ts)) this.startedAt = ts;
    } else if (rec.type === 'session_info') {
      this.setTitle(strOf(rec.name), 2);
    } else if (rec.type === 'message' && rec.message?.role === 'user') {
      this.setTitle(textOf(rec.message.content), 1);
    }
  }

  private setTitle(text: string, rank: number) {
    const t = truncate(text, 80);
    // session_info re-applies (latest wins, empty clears back to prompt rank);
    // user prompts only ever set the first one.
    if (rank === 2) {
      if (t) { this.title = t; this.titleRank = 2; }
      else if (this.titleRank === 2) this.titleRank = 1;
      return;
    }
    if (!t || this.titleRank >= rank) return;
    this.title = t;
    this.titleRank = rank;
  }

  private addSearchPart(f: SearchPart['f'], s: string) {
    if (this.searchChars >= 400_000) return;
    const text = s.replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!text) return;
    this.searchChars += text.length;
    this.searchParts.push({ f, s: text });
  }

  normalizeLine(raw: unknown): NormalizedBatch {
    const rec = typeof raw === 'string' ? safeJson(raw) : raw;
    if (!rec || typeof rec !== 'object') {
      if (typeof raw === 'string' && raw.trim()) this.parseFailures++;
      return { agents: [], events: [] };
    }
    const type = String((rec as any).type || '');
    const { ts, t } = this.clock(rec);
    const agents: AwvAgent[] = [];
    const events: AwvEvent[] = [];
    const agentId = this.agentId();
    const push = (e: AwvEvent) => { events.push(stamp(e, ts)); };

    if (type === 'session') {
      if ((rec as any).cwd && !this.cwd) this.cwd = String((rec as any).cwd);
      this.ensureAgent(t, ts, agents, events);
      // v1 headers carry the model directly.
      const v1Model = strOf((rec as any).modelId);
      if (v1Model) this.setModel(v1Model, agents);
      return { agents, events };
    }
    this.ensureAgent(t, ts, agents, events);

    if (type === 'message') {
      const msg = (rec as any).message;
      if (!msg || typeof msg !== 'object') return { agents, events };
      const role = String(msg.role || '');

      if (role === 'user') {
        const text = textOf(msg.content);
        if (text.trim()) {
          this.setTitle(text, 1);
          this.userTurns++;
          this.addSearchPart('prompt', text);
          push({ t, type: 'message', to: agentId, label: truncate(text, 120) });
        }
      } else if (role === 'assistant') {
        const model = strOf(msg.model);
        if (model) this.setModel(model, agents);
        this.accumulateUsage(model, msg.usage);
        const toolEvents: Array<Extract<AwvEvent, { type: 'tool' }>> = [];
        for (const block of blocksOf(msg.content)) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && block.text) this.addSearchPart('assistant', String(block.text));
          if (block.type !== 'toolCall') continue;
          const tool = String(block.name || 'tool');
          const useId = block.id ? String(block.id) : undefined;
          const label = summarizeArgs(block.arguments);
          this.addSearchPart('tool', `${tool} ${label}`);
          const ev: Extract<AwvEvent, { type: 'tool' }> = { t: t + toolEvents.length * 30, type: 'tool', agent: agentId, tool, label, useId };
          toolEvents.push(ev);
          if (useId) this.toolByCallId.set(useId, ev);
        }
        const total = totalTokens(msg.usage);
        if (total != null) {
          const diff = total - this.lastTokens;
          if (diff > 0) {
            if (toolEvents.length) toolEvents[0].tokens = diff;
            else push({ t, type: 'message', from: agentId, to: agentId, label: 'assistant reply', tokens: diff });
          }
          this.lastTokens = total;
        }
        for (const ev of toolEvents) push(ev);
        const stop = String(msg.stopReason || '');
        if (stop === 'error' || stop === 'aborted') {
          push({ t, type: 'error', agent: agentId, label: truncate(strOf(msg.errorMessage) || stop, 96) });
        }
      } else if (role === 'toolResult') {
        const callId = strOf(msg.toolCallId);
        const toolEv = callId ? this.toolByCallId.get(callId) : undefined;
        if (msg.isError) {
          if (toolEv && toolEv.exitCode == null) toolEv.exitCode = 1;
          const label = textOf(msg.content) || `${strOf(msg.toolName) || toolEv?.tool || 'tool'} failed`;
          push({ t, type: 'error', agent: agentId, label: truncate(label, 96) });
        }
      } else if (role === 'bashExecution') {
        const command = strOf(msg.command);
        const exit = Number(msg.exitCode);
        const ev: Extract<AwvEvent, { type: 'tool' }> = { t, type: 'tool', agent: agentId, tool: 'bash', label: truncate(command, 90) };
        if (Number.isFinite(exit)) ev.exitCode = exit;
        this.addSearchPart('tool', `bash ${command}`);
        push(ev);
        if (Number.isFinite(exit) && exit !== 0 && !msg.cancelled) {
          push({ t, type: 'error', agent: agentId, label: truncate(firstLine(strOf(msg.output)) || `exit ${exit}`, 96) });
        }
      }
      return { agents, events };
    }

    if (type === 'session_info') {
      this.setTitle(strOf((rec as any).name), 2);
      return { agents, events };
    }

    if (type === 'model_change') {
      const model = strOf((rec as any).modelId);
      if (model) this.setModel(model, agents);
      return { agents, events };
    }

    if (type === 'compaction') {
      const before = Number((rec as any).tokensBefore);
      push({ t, type: 'compact', agent: agentId, to: 0, label: Number.isFinite(before) && before > 0 ? `compacted from ${Math.round(before / 1000)}k` : 'context compacted' });
      this.lastTokens = 0;
      return { agents, events };
    }

    // thinking_level_change, branch_summary, custom, custom_message, label,
    // leaf, active_tools_change and unknown future types are housekeeping.
    return { agents, events };
  }

  private agentId(): string {
    return `session:${this.sessionId}`;
  }

  private ensureAgent(t: number, ts: number, agents: AwvAgent[], events: AwvEvent[]) {
    const id = this.agentId();
    if (this.agents.has(id)) return;
    const agent: AwvAgent = { id, name: truncate(this.projectName, 54), color: 'cyan', task: this.cwd, role: 'root', source: 'transcript' };
    this.agents.set(id, agent);
    agents.push(agent);
    events.push(stamp({ t, type: 'spawn', agent: id, tokens: 0 }, ts));
  }

  private setModel(model: string, agents: AwvAgent[]) {
    const a = this.agents.get(this.agentId());
    if (!a || a.model === model) return;
    a.model = model;
    this.model = model;
    const lim = this.contextLimits[model];
    if (lim != null) a.limit = lim;
    if (!agents.some((x) => x.id === a.id)) agents.push(a);
  }

  private accumulateUsage(model: string | undefined, usage: any) {
    if (!usage || typeof usage !== 'object') return;
    const key = model || this.model || 'unknown';
    let tot = this.usageByModel.get(key);
    if (!tot) { tot = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }; this.usageByModel.set(key, tot); }
    const n = (v: any) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
    const input = n(usage.input), output = n(usage.output);
    const cacheRead = n(usage.cacheRead), cacheCreation = n(usage.cacheWrite);
    tot.input += input; tot.output += output; tot.cacheRead += cacheRead; tot.cacheCreation += cacheCreation;
    tot.total += input + output + cacheRead + cacheCreation;
  }

  /**
   * Entry timestamps are ISO strings; message payloads carry Unix-ms
   * timestamps which are closer to the actual API call — prefer those.
   */
  private clock(rec: any): { ts: number; t: number } {
    const inner = Number(rec?.message?.timestamp);
    const outer = Date.parse(rec?.timestamp || '');
    const real = Number.isFinite(inner) && inner > 0 ? inner : Number.isFinite(outer) ? outer : null;
    if (real) { this.lastTs = real; if (!this.startedAt) this.startedAt = real; }
    const ts = real ?? (this.lastTs || Date.now());
    return { ts, t: this.startedAt ? Math.max(0, ts - this.startedAt) : 0 };
  }
}

function totalTokens(usage: any): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const total = Number(usage.totalTokens);
  if (Number.isFinite(total) && total > 0) return total;
  let sum = 0;
  let seen = false;
  for (const k of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    const n = Number(usage[k]);
    if (Number.isFinite(n)) { sum += n; seen = true; }
  }
  return seen ? sum : null;
}

function blocksOf(content: any): any[] {
  if (Array.isArray(content)) return content;
  if (content == null) return [];
  return [{ type: 'text', text: String(content) }];
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && b.type === 'text' ? String(b.text ?? '') : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function summarizeArgs(args: any): string {
  if (args == null || typeof args !== 'object') return truncate(String(args ?? ''), 90);
  const preferred = ['command', 'path', 'file_path', 'pattern', 'query', 'url'];
  for (const key of preferred) {
    if (args[key] != null) {
      const v = args[key];
      return truncate(`${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}`, 90);
    }
  }
  const entries = Object.entries(args).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return truncate(entries.join(', '), 90);
}

function firstLine(v: string): string {
  return v.trim().split('\n')[0] || '';
}

function strOf(v: any): string {
  return typeof v === 'string' ? v : '';
}

function stamp<T extends AwvEvent>(event: T, ts: number): T {
  event.ts = new Date(ts).toISOString();
  return event;
}

function safeJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}
