import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { listAdAccounts } from '@/services/ads';

export const dynamic = 'force-dynamic';

export const GET = route(async () => NextResponse.json({ adAccounts: await listAdAccounts() }));
