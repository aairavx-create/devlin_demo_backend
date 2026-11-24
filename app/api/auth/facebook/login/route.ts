import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { buildLoginUrl } from '@/services/account';

export const dynamic = 'force-dynamic';

// Browser navigates here from the dashboard's "Connect Facebook" button.
export async function GET() {
  const state = crypto.randomBytes(16).toString('hex');
  let url: string;
  try {
    url = buildLoginUrl(state);
  } catch (err: any) {
    const back = new URL('/pages', env.dashboardUrl);
    back.searchParams.set('error', err.message);
    return NextResponse.redirect(back);
  }
  const res = NextResponse.redirect(url);
  res.cookies.set('fb_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600,
    path: '/api/auth/facebook',
  });
  return res;
}
