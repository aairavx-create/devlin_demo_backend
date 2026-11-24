import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const conn = await connectDB();
    return NextResponse.json({ ok: true, mongo: conn.connection.readyState === 1 ? 'connected' : 'not-ready' });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
