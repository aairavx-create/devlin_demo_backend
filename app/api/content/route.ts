import { NextResponse } from 'next/server';
import { intParam, route } from '@/lib/http';
import { decodeCursor, getContent, type ContentType, type Platform } from '@/services/content';

export const dynamic = 'force-dynamic';

// GET /api/content?pageId=all|<id>&platform=all|facebook|instagram&type=all|post|reel&limit=12&cursor=...&insights=1
export const GET = route(async (req) => {
  const q = req.nextUrl.searchParams;
  const platform = (['all', 'facebook', 'instagram'].includes(q.get('platform') ?? '') ? q.get('platform') : 'all') as Platform;
  const type = (['all', 'post', 'reel'].includes(q.get('type') ?? '') ? q.get('type') : 'all') as ContentType;
  const result = await getContent({
    pageId: q.get('pageId'),
    platform,
    type,
    limit: intParam(q.get('limit'), 12, 1, 50),
    cursor: decodeCursor(q.get('cursor')),
    insights: q.get('insights') !== '0',
  });
  return NextResponse.json(result);
});
