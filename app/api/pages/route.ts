import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { listPages } from '@/services/pages';

export const dynamic = 'force-dynamic';

export const GET = route(async () => NextResponse.json({ pages: await listPages() }));
