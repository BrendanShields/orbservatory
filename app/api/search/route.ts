import type { SearchRequest } from '@/shared/schema';
import { getRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as SearchRequest | null;
  const result = await getRuntime().search(body);
  return Response.json(result, { headers: { 'cache-control': 'no-store' } });
}
