import { getRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const sessions = await getRuntime().sessions();
  return Response.json(sessions, { headers: { 'cache-control': 'no-store' } });
}
