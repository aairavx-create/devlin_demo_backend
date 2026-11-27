import postgres from 'postgres';
import { env } from './env';

/**
 * Postgres connection (Supabase or any Postgres). All Devlin tables live in the `devlin`
 * schema so they can share a database with other apps without name clashes.
 * The schema is created on first use (see SCHEMA below); there is no separate migration step.
 */

type Sql = ReturnType<typeof postgres>;
type Cache = { sql: Sql | null; ready: Promise<void> | null };

// Reuse the pool across hot reloads in dev.
const globalCache = globalThis as unknown as { __pg?: Cache };
const cache: Cache = globalCache.__pg ?? (globalCache.__pg = { sql: null, ready: null });

/** Accepts SQLAlchemy-style URLs too (postgresql+psycopg://...). */
function normalizeUrl(url: string) {
  return url.replace(/^postgres(ql)?\+[a-z0-9]+:\/\//i, 'postgresql://');
}

function createSql(): Sql {
  const url = new URL(normalizeUrl(env.databaseUrl));
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  return postgres({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1) || 'postgres'),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: local || url.searchParams.get('sslmode') === 'disable' ? false : 'require',
    // Works with Supabase's transaction pooler (port 6543), which doesn't support prepared statements.
    prepare: false,
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
    idle_timeout: 60,
    connect_timeout: 15,
    onnotice: () => undefined,
    // snake_case columns <-> camelCase fields (the shape the API already returns).
    // Column names only: keys inside jsonb values are left exactly as stored.
    // undefined values are written as NULL.
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel }, undefined: null },
  });
}

const real = () => (cache.sql ??= createSql());

/** Lazily-created pool, so importing this module (e.g. during `next build`) needs no DATABASE_URL. */
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  get(_t, prop) {
    const v = (real() as any)[prop];
    return typeof v === 'function' ? v.bind(real()) : v;
  },
  apply(_t, _this, args) {
    return (real() as any)(...args);
  },
});

/** Ensures the schema exists. Call before the first query (route() does it for you). */
export async function connectDB() {
  if (!cache.ready) {
    cache.ready = (async () => {
      cache.sql ??= createSql();
      await cache.sql.unsafe(SCHEMA);
    })();
  }
  try {
    await cache.ready;
  } catch (err) {
    cache.ready = null;
    throw err;
  }
  return cache.sql!;
}

/** API rows expose `_id` (what the dashboard expects) instead of `id`. */
export function withId<T extends { id: string }>(row: T): Omit<T, 'id'> & { _id: string } {
  const { id, ...rest } = row;
  return { _id: id, ...rest };
}

export const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const SCHEMA = /* sql */ `
-- Only create the schema when missing: a restricted DB role (e.g. one that may only use an
-- existing devlin schema) is not allowed to run CREATE SCHEMA, even with IF NOT EXISTS.
do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'devlin') then
    create schema devlin;
  end if;
end $$;

create table if not exists devlin.main_accounts (
  id                 uuid primary key default gen_random_uuid(),
  fb_user_id         text not null unique,
  name               text,
  email              text,
  picture_url        text,
  access_token_enc   text not null,           -- long-lived user token, AES-256-GCM
  token_expires_at   timestamptz,
  granted_scopes     text[] not null default '{}',
  businesses         jsonb not null default '[]',
  business_id        text,
  is_active          boolean not null default true,
  last_pages_sync_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists main_accounts_active_idx on devlin.main_accounts (is_active);

create table if not exists devlin.pages (
  id                 uuid primary key default gen_random_uuid(),
  page_id            text not null unique,
  main_account_id    uuid references devlin.main_accounts(id) on delete cascade,
  name               text,
  category           text,
  picture_url        text,
  link               text,
  fan_count          bigint,
  relationship       text not null default 'personal' check (relationship in ('personal','owned','client')),
  tasks              text[] not null default '{}',
  instagram          jsonb,
  access_token_enc   text,                    -- page token, AES-256-GCM
  has_token          boolean not null default false,
  active             boolean not null default true,
  leadgen_subscribed boolean not null default false,
  leads_synced_at    timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists pages_account_idx on devlin.pages (main_account_id);

create table if not exists devlin.page_access_requests (
  id                 uuid primary key default gen_random_uuid(),
  page_id            text not null,
  page_name          text,
  main_account_id    uuid references devlin.main_accounts(id) on delete set null,
  business_id        text not null,
  permitted_tasks    text[] not null default '{}',
  status             text not null default 'pending' check (status in ('pending','approved','failed')),
  meta_access_status text,
  error              text,
  note               text,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists par_page_idx on devlin.page_access_requests (page_id);
create index if not exists par_status_idx on devlin.page_access_requests (status);

create table if not exists devlin.leads (
  id              uuid primary key default gen_random_uuid(),
  leadgen_id      text not null unique,
  page_id         text,
  page_name       text,
  form_id         text,
  form_name       text,
  ad_id           text,
  ad_name         text,
  adset_id        text,
  adset_name      text,
  campaign_id     text,
  campaign_name   text,
  platform        text,
  is_organic      boolean,
  full_name       text,
  email           text,
  phone           text,
  field_data      jsonb not null default '[]',
  fields          jsonb not null default '{}',
  consents        jsonb not null default '[]',
  created_time    timestamptz,
  -- Lead management workflow (set by staff; Meta sync never overwrites these)
  status          text not null default 'NEW' check (status in ('NEW','WORKING','UNQUALIFIED','QUALIFIED','CLOSE','INVALID')),
  status_history  jsonb not null default '[]',
  follow_up       jsonb,
  source          text not null default 'sync' check (source in ('webhook','sync')),
  fetch_status    text not null default 'fetched' check (fetch_status in ('pending','fetched','failed')),
  fetch_error     text,
  fetch_attempts  integer not null default 0,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists leads_page_idx on devlin.leads (page_id);
create index if not exists leads_form_idx on devlin.leads (form_id);
create index if not exists leads_created_idx on devlin.leads (created_time desc);
create index if not exists leads_status_idx on devlin.leads (status);
create index if not exists leads_fetch_idx on devlin.leads (fetch_status);

-- Chatbot state: one JSON document, updated under a row lock (see chatbot/store.ts).
create table if not exists devlin.chatbot_state (
  id         text primary key,
  db         jsonb not null,
  updated_at timestamptz not null default now()
);

-- Leases for background jobs (services/autoSync.ts), so only one server runs a job at a time.
create table if not exists devlin.job_locks (
  id           text primary key,
  locked_until timestamptz not null default now()
);

-- Only the backend (service connection) reads these; block Supabase's public API roles.
alter table devlin.main_accounts enable row level security;
alter table devlin.pages enable row level security;
alter table devlin.page_access_requests enable row level security;
alter table devlin.leads enable row level security;
alter table devlin.chatbot_state enable row level security;
alter table devlin.job_locks enable row level security;
`;
