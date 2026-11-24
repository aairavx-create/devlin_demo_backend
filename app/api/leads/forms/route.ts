import { NextResponse } from 'next/server';
import { HttpError, route } from '@/lib/http';
import { listForms } from '@/services/leads';

export const dynamic = 'force-dynamic';

// Live list of instant forms on a page: GET /api/leads/forms?pageId=123
export const GET = route(async (req) => {
  const pageId = req.nextUrl.searchParams.get('pageId');
  if (!pageId) throw new HttpError(400, 'pageId is required');
  return NextResponse.json({ forms: await listForms(pageId) });
});
