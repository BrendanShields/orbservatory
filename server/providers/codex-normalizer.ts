import type { AwvAgent, AwvEvent, AwvSession } from '../../shared/schema';
import type { NormalizedBatch } from '../normalizer';
import { truncate } from '../normalizer';
import type { SessionNormalizer } from './types';

export interface CodexLineSource {
  kind: 'root' | 'subagent';
  /** Thread id of the rollout file the line came from. */
  threadId: string;
  /** Display name for a subagent thread (payload.source.subagent), when known. */
  name?: string;
}

export class CodexNormalizer implements SessionNormalizer {
  readonly threadId: string;
  title = '';
  cwd?: string;
  startedAt = 0;
  private lastTs = 0;
  private hasTitle = false;

  private agents = new Map<string, AwvAgent>();
  private spawned = new Set<string>();
  private lastTokens = new Map<string, number>();
  private toolByCallId = new Map<string, Extract<AwvEvent, { type: 'tool' }>>();
  private models = new Map<string, string>();
  private contextLimits: Record<string, number> = {};

  constructor(opts: { threadId: string }) {
    this.threadId = opts.threadId;
    this.title = `codex · ${opts.threadId.slice(0, 8)}`;
  }

  get projectName(): string {
    if (this.cwd) return this.cwd.split('/').filter(Boolean).pop() || this.cwd;
    return 'codex';
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
      desc: `${this.projectName} · ${this.cwd || 'codex'} · codex · ${this.threadId.slice(0, 8)}`,
      agents: [...this.agents.values()],
      events: events.slice(),
    };
  }

  peekLine(raw: string) {
    const rec = safeJson(raw);
    if (!rec || typeof rec !== 'object') return;
    const payload = rec.payload;
    if (!payload || typeof payload !== 'object') return;
    if (rec.type === 'session_meta') {
      if (payload.cwd && !this.cwd) this.cwd = String(payload.cwd);
      const ts = Date.parse(payload.timestamp || rec.timestamp || '');
      if (!this.startedAt && Number.isFinite(ts)) this.startedAt = ts;
    } else if (rec.type === 'event_msg' && payload.type === 'user_message' && !this.hasTitle) {
      const text = String(payload.message ?? '');
      if (text.trim()) { this.title = truncate(text, 80); this.hasTitle = true; }
    }
  }

  normalizeLine(raw: unknown, src: CodexLineSource): NormalizedBatch {
    const rec = typeof raw === 'string' ? safeJson(raw) : raw;
    if (!rec || typeof rec !== 'object') return { agents: [], events: [] };
    const payload = (rec as any).payload;
    if (!payload || typeof payload !== 'object') return { agents: [], events: [] };
    const type = String((rec as any).type || '');
    const { ts, t } = this.clock(rec);
    const agents: AwvAgent[] = [];
    const events: AwvEvent[] = [];
    const agentId = this.agentIdFor(src);
    const push = (e: AwvEvent) => { events.push(stamp(e, ts)); };

    if (type === 'session_meta') {
      this.ensureAgent(src, payload, t, ts, agents, events);
      return { agents, events };
    }
    this.ensureAgent(src, null, t, ts, agents, events);

    if (type === 'turn_context') {
      const model = typeof payload.model === 'string' ? payload.model : undefined;
      if (model) this.setModel(agentId, model, agents);
      if (payload.cwd && !this.cwd) this.cwd = String(payload.cwd);
      return { agents, events };
    }

    if (type === 'response_item') {
      const pt = String(payload.type || '');
      if (pt === 'function_call' || pt === 'custom_tool_call' || pt === 'web_search_call') {
        const tool = String(payload.name || (pt === 'web_search_call' ? 'web_search' : 'tool'));
        const callId = payload.call_id ? String(payload.call_id) : undefined;
        const label = summarizeArgs(payload.arguments ?? payload.input ?? payload.action);
        const ev: Extract<AwvEvent, { type: 'tool' }> = { t, type: 'tool', agent: agentId, tool, label, useId: callId };
        if (callId) this.toolByCallId.set(callId, ev);
        push(ev);
      } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
        const callId = payload.call_id ? String(payload.call_id) : '';
        const toolEv = callId ? this.toolByCallId.get(callId) : undefined;
        const failure = outputFailure(payload.output);
        if (toolEv && failure.exitCode != null) toolEv.exitCode = failure.exitCode;
        if (failure.failed) {
          if (toolEv && toolEv.exitCode == null) toolEv.exitCode = 1;
          push({ t, type: 'error', agent: agentId, label: truncate(failure.label || `${toolEv?.tool || 'tool'} failed`, 96) });
        }
      }
      return { agents, events };
    }

    if (type === 'event_msg') {
      const pt = String(payload.type || '');
      if (pt === 'user_message') {
        const text = String(payload.message ?? '');
        if (text.trim()) {
          if (!this.hasTitle && src.kind === 'root') { this.title = truncate(text, 80); this.hasTitle = true; }
          push({ t, type: 'message', to: agentId, label: truncate(text, 120) });
        }
      } else if (pt === 'agent_message') {
        const text = String(payload.message ?? '');
        if (text.trim()) push({ t, type: 'message', from: agentId, to: agentId, label: truncate(text, 96) });
      } else if (pt === 'token_count') {
        const total = totalTokens(payload);
        if (total != null) {
          const prev = this.lastTokens.get(agentId) ?? 0;
          const diff = total - prev;
          if (diff < -1_000) push({ t, type: 'compact', agent: agentId, to: total, label: 'context compacted' });
          else if (diff > 0) push({ t, type: 'message', from: agentId, to: agentId, label: 'context update', tokens: diff });
          this.lastTokens.set(agentId, total);
        }
      } else if (pt === 'task_complete') {
        const a = this.agents.get(agentId);
        if (a) a.finalStatus = 'completed';
        push({ t, type: 'complete', agent: agentId, label: 'task complete' });
      } else if (pt === 'error' || pt === 'stream_error') {
        push({ t, type: 'error', agent: agentId, label: truncate(String(payload.message ?? 'error'), 96) });
      } else if (pt === 'turn_aborted') {
        push({ t, type: 'error', agent: agentId, label: truncate(`turn aborted: ${String(payload.reason ?? 'interrupted')}`, 96) });
      } else if (pt === 'patch_apply_end' && payload.success === false) {
        push({ t, type: 'error', agent: agentId, label: 'patch failed to apply' });
      } else if (pt === 'context_compacted' || pt === 'compacted') {
        push({ t, type: 'compact', agent: agentId, to: 0, label: 'context compacted' });
        this.lastTokens.set(agentId, 0);
      }
      return { agents, events };
    }

    if (type === 'compacted') {
      push({ t, type: 'compact', agent: agentId, to: 0, label: 'context compacted' });
      this.lastTokens.set(agentId, 0);
      return { agents, events };
    }

    return { agents, events };
  }

  private agentIdFor(src: CodexLineSource): string {
    const root = `session:${this.threadId}`;
    return src.kind === 'root' ? root : `${root}:agent-${src.threadId}`;
  }

  private ensureAgent(src: CodexLineSource, meta: any, t: number, ts: number, agents: AwvAgent[], events: AwvEvent[]) {
    const rootId = `session:${this.threadId}`;
    if (!this.agents.has(rootId)) {
      if (meta?.cwd && src.kind === 'root' && !this.cwd) this.cwd = String(meta.cwd);
      const root: AwvAgent = { id: rootId, name: truncate(this.projectName, 54), color: 'cyan', task: this.cwd, role: 'root', source: 'transcript' };
      this.agents.set(rootId, root);
      this.spawned.add(rootId);
      agents.push(root);
      events.push(stamp({ t, type: 'spawn', agent: rootId, tokens: 0 }, ts));
    } else if (meta?.cwd && src.kind === 'root' && !this.cwd) {
      this.cwd = String(meta.cwd);
      const root = this.agents.get(rootId)!;
      root.name = truncate(this.projectName, 54);
      root.task = this.cwd;
      if (!agents.some((a) => a.id === rootId)) agents.push(root);
    }
    if (src.kind === 'subagent') {
      const childId = this.agentIdFor(src);
      if (!this.agents.has(childId)) {
        const name = src.name || 'subagent';
        const child: AwvAgent = {
          id: childId,
          name: truncate(`${name} · ${src.threadId.slice(0, 7)}`, 60),
          color: pickColor(childId),
          role: 'subagent',
          agentType: src.name,
          source: 'transcript',
        };
        this.agents.set(childId, child);
        this.spawned.add(childId);
        agents.push(child);
        events.push(stamp({ t, type: 'spawn', agent: childId, parent: rootId, tokens: 0 }, ts));
      }
    }
  }

  private setModel(agentId: string, model: string, agents: AwvAgent[]) {
    const a = this.agents.get(agentId);
    if (!a || (a.model === model && this.models.get(agentId) === model)) return;
    a.model = model;
    this.models.set(agentId, model);
    const lim = this.contextLimits[model];
    if (lim != null) a.limit = lim;
    if (!agents.some((x) => x.id === agentId)) agents.push(a);
  }

  private clock(rec: any): { ts: number; t: number } {
    const v = rec.timestamp;
    const n = typeof v === 'number' ? v : Date.parse(v || '');
    const real = Number.isFinite(n) ? n : null;
    if (real) { this.lastTs = real; if (!this.startedAt) this.startedAt = real; }
    const ts = real ?? (this.lastTs || Date.now());
    return { ts, t: this.startedAt ? Math.max(0, ts - this.startedAt) : 0 };
  }
}

function totalTokens(payload: any): number | null {
  const usage = payload?.info?.total_token_usage ?? payload?.info?.token_usage ?? payload;
  if (!usage || typeof usage !== 'object') return null;
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total > 0) return total;
  let sum = 0;
  let seen = false;
  for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    const n = Number(usage[k]);
    if (Number.isFinite(n)) { sum += n; seen = true; }
  }
  return seen ? sum : null;
}

export function outputFailure(output: any): { failed: boolean; exitCode?: number; label?: string } {
  let obj = output;
  if (typeof output === 'string') {
    obj = safeJson(output);
    // Current Codex writes plain-text shell output ("…\nProcess exited with
    // code N\nOutput:\n…"), not JSON — parse the exit code out of the text.
    if (!obj) {
      const m = /(?:^|\n)Process exited with code (\d+)/.exec(output);
      if (m) {
        const exit = Number(m[1]);
        const body = output.split(/\nOutput:\n/)[1] ?? output;
        return { failed: exit !== 0, exitCode: exit, label: exit !== 0 ? firstLine(body) : undefined };
      }
      return { failed: false };
    }
  }
  if (obj && typeof obj === 'object') {
    const exit = Number(obj.metadata?.exit_code ?? obj.exit_code);
    if (Number.isFinite(exit)) {
      return { failed: exit !== 0, exitCode: exit, label: exit !== 0 ? firstLine(obj.output ?? obj.content) : undefined };
    }
    if (obj.success === false) return { failed: true, label: firstLine(obj.output ?? obj.content ?? obj.error) };
  }
  return { failed: false };
}

/** Raw display text of a tool output payload: JSON envelopes unwrap to their output/content field. */
export function outputText(output: any): string {
  if (typeof output === 'string') {
    const obj = safeJson(output);
    if (obj && typeof obj === 'object') return outputText(obj);
    return output;
  }
  if (output && typeof output === 'object') {
    const v = output.output ?? output.content ?? output.error;
    if (typeof v === 'string') return v;
    return JSON.stringify(output);
  }
  return output == null ? '' : String(output);
}

function firstLine(v: any): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v.trim().split('\n')[0];
}

export function summarizeArgs(args: any): string {
  if (args == null) return '';
  if (typeof args === 'string') {
    const parsed = safeJson(args);
    if (parsed && typeof parsed === 'object') return summarizeArgs(parsed);
    return truncate(args, 90);
  }
  if (typeof args !== 'object') return truncate(String(args), 90);
  const preferred = ['command', 'query', 'file_path', 'path', 'pattern', 'input', 'url'];
  for (const key of preferred) {
    if (args[key] != null) {
      const v = args[key];
      return truncate(`${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}`, 90);
    }
  }
  const entries = Object.entries(args).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return truncate(entries.join(', '), 90);
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
