import { NextResponse } from 'next/server';
import { HttpError, readJson, route } from '@/lib/http';
import { PAGE_TASKS, listAccessRequests, requestPageAccess } from '@/services/pages';

export const dynamic = 'force-dynamic';

// GET ?refresh=1 re-checks pending requests against Meta (and stores tokens for accepted ones).
export const GET = route(async (req) => {
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';
  return NextResponse.json({ requests: await listAccessRequests(refresh), tasks: PAGE_TASKS });
});

// Body: { page: "<page id or facebook url>", tasks: ["ADVERTISE","ANALYZE"], note? }
export const POST = route(async (req) => {
  const body = await readJson<{ page?: string; tasks?: string[]; note?: string }>(req);
  if (!body.page) throw new HttpError(400, 'page is required');
  const request = await requestPageAccess(body.page, body.tasks ?? ['ADVERTISE', 'ANALYZE'], body.note);
  return NextResponse.json({ request }, { status: request.status === 'failed' ? 502 : 201 });
});
