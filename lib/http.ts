import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from './db';
import { GraphError } from './graph';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

/** Makes sure the DB schema exists, runs the handler and turns thrown errors into JSON responses. */
export function route<C = any>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      await connectDB();
      return await handler(req, ctx);
    } catch (err: any) {
      if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
      if (err instanceof GraphError) {
        return NextResponse.json({ error: err.message, source: 'meta', meta: err.details }, { status: 502 });
      }
      console.error('[meta-agent]', err);
      return NextResponse.json({ error: err?.message || 'Internal error' }, { status: 500 });
    }
  };
}

export async function readJson<T = any>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

export function intParam(value: string | null, fallback: number, min: number, max: number) {
  const n = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
