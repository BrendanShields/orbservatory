import type { Settings } from '@/shared/schema';
import { getRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await getRuntime().getSettings();
  return Response.json(settings, { headers: { 'cache-control': 'no-store' } });
}

export async function PUT(req: Request) {
  const patch = (await req.json().catch(() => ({}))) as Partial<Settings>;
  const settings = await getRuntime().patchSettings(patch);
  return Response.json(settings, { headers: { 'cache-control': 'no-store' } });
}
