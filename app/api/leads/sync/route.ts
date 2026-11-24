import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { syncLeads } from '@/services/leads';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Body (optional): { pageId?: string, full?: boolean }
export const POST = route(async (req) => {
  const body = await req.json().catch(() => ({}));
  return NextResponse.json(await syncLeads(body.pageId, Boolean(body.full)));
});
