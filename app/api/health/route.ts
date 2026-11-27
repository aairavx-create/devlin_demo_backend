import { NextResponse } from 'next/server';
import { connectDB, sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await connectDB();
    await sql`select 1`;
    return NextResponse.json({ ok: true, db: 'connected' });
  } catch (err: any) {
    console.error('[meta-agent] health', err);
    return NextResponse.json({ ok: false, db: 'error' }, { status: 500 });
  }
}
