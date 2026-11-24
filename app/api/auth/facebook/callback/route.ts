import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/crypto';
import { connectDB } from '@/lib/db';
import { env } from '@/lib/env';
import { connectMainAccount } from '@/services/account';
import { syncPages } from '@/services/pages';

export const dynamic = 'force-dynamic';

function back(params: Record<string, string>) {
  const url = new URL('/pages', env.dashboardUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.delete({ name: 'fb_oauth_state', path: '/api/auth/facebook' });
  return res;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  if (q.get('error')) return back({ error: q.get('error_description') || q.get('error') || 'Login cancelled' });

  const code = q.get('code');
  const state = q.get('state') || '';
  const expected = req.cookies.get('fb_oauth_state')?.value || '';
  if (!code || !expected || !safeEqual(state, expected)) return back({ error: 'Invalid login state. Please try again.' });

  try {
    await connectDB();
    await connectMainAccount(code);
    const sync = await syncPages().catch((e) => ({ synced: 0, warnings: [e.message] }));
    return back({ connected: '1', pages: String(sync.synced), ...(sync.warnings.length ? { warnings: String(sync.warnings.length) } : {}) });
  } catch (err: any) {
    console.error('[meta-agent] oauth callback', err);
    return back({ error: err.message || 'Login failed' });
  }
}
