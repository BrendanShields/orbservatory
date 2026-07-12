import type { SearchResponse, ServerMessage, TranscriptResponse } from '../shared/schema';

interface TransportCallbacks {
  onOpen(): void;
  onMessage(msg: ServerMessage): void;
  onDown(): void;
}

/** WebSocket client with automatic reconnect. */
export class Transport {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;

  constructor(private cb: TransportCallbacks) {}

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => this.cb.onOpen();
    ws.onmessage = (e) => this.cb.onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      this.ws = null;
      this.cb.onDown();
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.connect(), 900);
    };
    ws.onerror = () => ws.close();
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }
  /** A socket exists (connecting or open) — distinguishes "connecting…" from "offline". */
  get connecting() { return this.ws !== null; }

  send(msg: unknown) { if (this.open) this.ws!.send(JSON.stringify(msg)); }
}

export async function searchServer(q: string): Promise<SearchResponse | null> {
  try {
    const r = await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q, limit: 200 }) });
    if (!r.ok) return null;
    return await r.json() as SearchResponse;
  } catch {
    return null;
  }
}

export function putSettings(patch: Record<string, unknown>) {
  fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {});
}

export interface TranscriptFetchQuery { agent?: string; before?: number; after?: number; limit?: number }
export type TranscriptFetchResult = TranscriptResponse | { unsupported: true } | { gone: true } | null;

/** Session ids contain slashes (path separators for the catch-all route); encode each segment only. */
export async function fetchTranscript(sessionId: string, q: TranscriptFetchQuery): Promise<TranscriptFetchResult> {
  const sp = new URLSearchParams();
  if (q.agent) sp.set('agent', q.agent);
  if (q.before != null) sp.set('before', String(q.before));
  if (q.after != null) sp.set('after', String(q.after));
  if (q.limit != null) sp.set('limit', String(q.limit));
  const path = sessionId.split('/').map(encodeURIComponent).join('/');
  const qs = sp.size ? `?${sp}` : '';
  try {
    const r = await fetch(`/api/session/${path}/transcript${qs}`);
    if (r.status === 410) return { gone: true };
    if (r.status === 404) {
      const body = await r.json().catch(() => null);
      return body?.unsupported ? { unsupported: true } : null;
    }
    if (!r.ok) return null;
    return await r.json() as TranscriptResponse;
  } catch {
    return null;
  }
}
