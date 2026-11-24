import crypto from 'crypto';
import { env } from './env';

export class GraphError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: { code?: number; error_subcode?: number; type?: string; fbtrace_id?: string },
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | object | undefined | null>;
type Options = { method?: 'GET' | 'POST' | 'DELETE'; params?: Params; token?: string };

export type Paged<T> = { data: T[]; paging?: { cursors?: { before?: string; after?: string }; next?: string } };

function appSecretProof(token: string) {
  return crypto.createHmac('sha256', env.appSecret).update(token).digest('hex');
}

export async function graph<T = any>(path: string, { method = 'GET', params = {}, token }: Options = {}): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${env.graphVersion}/${path.replace(/^\//, '')}`);
  const all: Params = { ...params };
  if (token) {
    all.access_token = token;
    all.appsecret_proof = appSecretProof(token);
  }
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined || v === null) continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (method === 'GET') url.searchParams.set(k, s);
    else body.set(k, s);
  }

  const res = await fetch(url, { method, body: method === 'GET' ? undefined : body, cache: 'no-store' });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const e = json?.error ?? {};
    throw new GraphError(e.message || `Graph API request failed (${res.status})`, res.status, {
      code: e.code,
      error_subcode: e.error_subcode,
      type: e.type,
      fbtrace_id: e.fbtrace_id,
    });
  }
  return json as T;
}

/** Follows cursor paging until there are no more pages or maxPages is reached. */
export async function graphAll<T = any>(path: string, opts: Options = {}, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await graph<Paged<T>>(path, { ...opts, params: { ...opts.params, after } });
    out.push(...(page.data ?? []));
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

export function isInvalidFieldError(err: unknown) {
  return err instanceof GraphError && err.details?.code === 100;
}
