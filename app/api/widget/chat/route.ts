/**
 * Public chat API used by the website chat widget (no API key; allowed origins come from CORS_ORIGINS).
 *   GET  /api/widget/chat?sessionId=...                               → this visitor's chat
 *   POST /api/widget/chat { action: 'start', sessionId, consent, entry? } → start a chat (after consent + captcha);
 *        entry 'measure' opens straight into Request to Measure
 *   POST /api/widget/chat { sessionId, text, optionId?, clientMsgId, form? } → send a message, get the updated chat
 */
import { NextRequest, NextResponse } from 'next/server';
import { getThread, handleMessage, startChat } from '@/chatbot/bot';
import type { ContactDetails } from '@/chatbot/types';

export const dynamic = 'force-dynamic';

/** The details form (name, phone, address) sent in one go. Anything else is ignored. */
function readForm(raw: unknown): ContactDetails | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : '');
  return { name: str(f.name), phone: str(f.phone), address: str(f.address) };
}

const validSession = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!validSession(sessionId)) return NextResponse.json({ error: 'Invalid session.' }, { status: 400 });
  return NextResponse.json(await getThread(sessionId));
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }
  const { sessionId, action } = body;
  if (!validSession(sessionId)) return NextResponse.json({ error: 'Invalid session.' }, { status: 400 });

  if (action === 'start') {
    // Production: verify the captcha token (e.g. Cloudflare Turnstile) here before starting.
    if (body.consent !== true) return NextResponse.json({ error: 'Consent is required.' }, { status: 400 });
    return NextResponse.json(await startChat(sessionId, body.entry === 'measure' ? 'measure' : undefined));
  }

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
  const result = await handleMessage(
    sessionId,
    {
      text: typeof body.text === 'string' ? body.text : '',
      optionId: typeof body.optionId === 'string' ? body.optionId : '',
      clientMsgId: typeof body.clientMsgId === 'string' ? body.clientMsgId.slice(0, 64) : undefined,
      form: readForm(body.form),
    },
    ip,
  );
  if ('error' in result) return NextResponse.json(result, { status: 429 });
  return NextResponse.json(result);
}
