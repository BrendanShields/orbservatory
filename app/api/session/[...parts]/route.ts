import { getRuntime } from '@/server/runtime';
import { parseTranscriptQuery } from '@/server/transcript';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ parts: string[] }> }) {
  const { parts } = await context.params;
  const tail = parts.at(-1);
  const sessionId = parts.slice(0, -1).join('/');
  if (tail === 'export') {
    const snapshot = await getRuntime().exportSession(sessionId);
    if (!snapshot) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(snapshot, { headers: { 'cache-control': 'no-store' } });
  }
  if (tail === 'transcript') {
    const q = parseTranscriptQuery(new URL(req.url).searchParams);
    try {
      const res = await getRuntime().transcript(sessionId, q);
      if (!res) return Response.json({ error: 'not found' }, { status: 404 });
      if ('unsupported' in res) return Response.json({ error: 'transcript unsupported', unsupported: true }, { status: 404 });
      return Response.json(res, { headers: { 'cache-control': 'no-store' } });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return Response.json({ error: 'source file gone' }, { status: 410 });
      throw err;
    }
  }
  return Response.json({ error: 'not found' }, { status: 404 });
}
