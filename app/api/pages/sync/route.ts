import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { listPages, syncPages } from '@/services/pages';

export const dynamic = 'force-dynamic';

export const POST = route(async () => {
  const result = await syncPages();
  return NextResponse.json({ ...result, pages: await listPages() });
});
