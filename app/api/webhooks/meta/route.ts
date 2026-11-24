import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/crypto';
import { connectDB } from '@/lib/db';
import { env } from '@/lib/env';
import { processLeadgenPing } from '@/services/leads';

export const dynamic = 'force-dynamic';

// Meta's subscription handshake
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  if (q.get('hub.mode') === 'subscribe' && safeEqual(q.get('hub.verify_token') || '', env.webhookVerifyToken)) {
    return new NextResponse(q.get('hub.challenge') || '', { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

// Leadgen pings: { object: "page", entry: [{ changes: [{ field: "leadgen", value: {...} }] }] }
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', env.appSecret).update(raw).digest('hex');
  if (!safeEqual(signature, expected)) return new NextResponse('Invalid signature', { status: 401 });

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse('Bad JSON', { status: 400 });
  }

  const pings: any[] = [];
  if (payload.object === 'page') {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'leadgen' && change.value?.leadgen_id) pings.push(change.value);
      }
    }
  }

  if (pings.length) {
    await connectDB();
    // Answer Meta quickly; fetch lead details in the background. Failures are retried by /api/leads/sync.
    void Promise.allSettled(pings.map((p) => processLeadgenPing(p))).then((rs) =>
      rs.forEach((r) => r.status === 'rejected' && console.error('[meta-agent] leadgen', r.reason)),
    );
  }
  return NextResponse.json({ received: pings.length });
}
