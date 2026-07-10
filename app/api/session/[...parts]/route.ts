import { getRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, context: { params: Promise<{ parts: string[] }> }) {
  const { parts } = await context.params;
  if (parts.at(-1) !== 'export') {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const sessionId = parts.slice(0, -1).join('/');
  const snapshot = await getRuntime().exportSession(sessionId);
  if (!snapshot) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json(snapshot, { headers: { 'cache-control': 'no-store' } });
}
