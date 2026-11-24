import { NextRequest, NextResponse } from 'next/server';

// These are hit by the browser (OAuth redirect) or by Meta (webhooks), so they can't send x-api-key.
const PUBLIC_PREFIXES = ['/api/health', '/api/auth/facebook/', '/api/webhooks/', '/api/widget/'];

export function middleware(req: NextRequest) {
  const origin = req.headers.get('origin');
  const allowed = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim());
  const cors: Record<string, string> = {};
  if (origin && allowed.includes(origin)) {
    cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Methods'] = 'GET,POST,PATCH,DELETE,OPTIONS';
    cors['Access-Control-Allow-Headers'] = 'Content-Type, x-api-key';
    cors['Vary'] = 'Origin';
  }

  if (req.method === 'OPTIONS') return new NextResponse(null, { status: 204, headers: cors });

  const isPublic = PUBLIC_PREFIXES.some((p) => req.nextUrl.pathname.startsWith(p));
  if (!isPublic) {
    const expected = process.env.AGENT_API_KEY;
    if (!expected || req.headers.get('x-api-key') !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
    }
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

export const config = { matcher: '/api/:path*' };
