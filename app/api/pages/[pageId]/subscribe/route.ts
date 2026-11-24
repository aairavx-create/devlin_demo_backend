import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { subscribeLeadgen } from '@/services/pages';

export const dynamic = 'force-dynamic';

// Installs the app on the page for leadgen webhooks.
export const POST = route<{ params: { pageId: string } }>(async (_req, { params }) =>
  NextResponse.json(await subscribeLeadgen(params.pageId)),
);
