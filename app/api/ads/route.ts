import { NextResponse } from 'next/server';
import { HttpError, intParam, route } from '@/lib/http';
import { listAds } from '@/services/ads';

export const dynamic = 'force-dynamic';

// GET /api/ads?adAccountId=act_123&datePreset=last_30d&status=ACTIVE&after=...
export const GET = route(async (req) => {
  const q = req.nextUrl.searchParams;
  const adAccountId = q.get('adAccountId');
  if (!adAccountId) throw new HttpError(400, 'adAccountId is required');
  return NextResponse.json(
    await listAds({
      adAccountId,
      datePreset: q.get('datePreset') || 'last_30d',
      status: q.get('status'),
      after: q.get('after'),
      limit: intParam(q.get('limit'), 25, 1, 100),
    }),
  );
});
