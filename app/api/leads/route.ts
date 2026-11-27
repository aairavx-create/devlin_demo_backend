import { NextResponse } from 'next/server';
import { intParam, route } from '@/lib/http';
import { queryLeads } from '@/services/leads';

export const dynamic = 'force-dynamic';

// Reads leads from Postgres (fill it via POST /api/leads/sync or the webhook).
// GET /api/leads?status=ALL|NEW|WORKING|UNQUALIFIED|QUALIFIED|CLOSE|INVALID&pageId=&formId=&search=
//               &fetchStatus=pending|fetched|failed&from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&pageSize=25
export const GET = route(async (req) => {
  const q = req.nextUrl.searchParams;
  return NextResponse.json(
    await queryLeads({
      pageId: q.get('pageId'),
      formId: q.get('formId'),
      search: q.get('search'),
      status: q.get('status'),
      fetchStatus: q.get('fetchStatus'),
      from: q.get('from'),
      to: q.get('to'),
      page: intParam(q.get('page'), 1, 1, 10_000),
      pageSize: intParam(q.get('pageSize'), 25, 1, 200),
    }),
  );
});
