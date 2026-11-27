/**
 * Background safety net for leads. The webhook saves leads instantly; this catches anything it missed:
 *   - every LEADS_RETRY_MINUTES (default 5): re-fetch leads whose webhook fetch is pending/failed
 *   - every LEADS_SYNC_MINUTES (default 60) and shortly after start-up: incremental sync from Meta,
 *     which picks up leads submitted while the server was down
 * Set either to 0 to turn it off. A lease row (devlin.job_locks) makes sure only one server runs a job at a time;
 * it expires on its own if a server dies mid-job. No DB connection is held while a job runs.
 */
import { connectDB, sql } from '@/lib/db';
import { retryPendingLeads, syncLeads } from './leads';
import { subscribeMissingPages } from './pages';

const LEASE_MINUTES = 15; // longer than any sync takes (route maxDuration is 5 min)

const minutes = (name: string, fallback: number) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : fallback;
};

const running = new Set<string>();

/** Runs fn only if this process isn't already running the job and no other server holds its lease. */
async function exclusive<T>(job: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (running.has(job)) return undefined;
  running.add(job);
  try {
    const [lease] = await sql`
      insert into devlin.job_locks (id, locked_until) values (${job}, now() + make_interval(mins => ${LEASE_MINUTES}))
      on conflict (id) do update set locked_until = excluded.locked_until
      where devlin.job_locks.locked_until < now()
      returning id`;
    if (!lease) return undefined;
    try {
      return await fn();
    } finally {
      await sql`update devlin.job_locks set locked_until = now() where id = ${job}`;
    }
  } finally {
    running.delete(job);
  }
}

async function hasConnectedPages() {
  await connectDB();
  const [row] = await sql`select 1 from devlin.pages where active and has_token limit 1`;
  return Boolean(row);
}

export async function runLeadSync(reason: string) {
  try {
    if (!(await hasConnectedPages())) return;
    const result = await exclusive('leads-sync', async () => {
      // Make sure Meta pushes new leads instantly for every page (e.g. pages connected before auto-subscribe).
      const subs = await subscribeMissingPages();
      if (subs.done.length) console.log(`[auto-sync] subscribed to lead webhooks: ${subs.done.join(', ')}`);
      if (subs.failed.length) console.error(`[auto-sync] could not subscribe: ${subs.failed.join('; ')}`);
      return syncLeads();
    });
    if (!result) return;
    const saved = result.pages.reduce((n, p) => n + p.leads, 0);
    const errors = result.pages.filter((p) => p.error);
    console.log(`[auto-sync] ${reason}: ${saved} leads checked across ${result.pages.length} pages, ${result.retried} retried` +
      (errors.length ? `, errors: ${errors.map((p) => `${p.pageName ?? p.pageId}: ${p.error}`).join('; ')}` : ''));
  } catch (err: any) {
    console.error(`[auto-sync] ${reason} failed:`, err?.message ?? err);
  }
}

export async function runLeadRetry() {
  try {
    await connectDB();
    const retried = await exclusive('leads-retry', () => retryPendingLeads());
    if (retried) console.log(`[auto-sync] retried ${retried} pending/failed leads`);
  } catch (err: any) {
    console.error('[auto-sync] retry failed:', err?.message ?? err);
  }
}

let started = false;

export function startLeadAutoSync() {
  if (started || !process.env.DATABASE_URL) return;
  started = true;
  const syncEvery = minutes('LEADS_SYNC_MINUTES', 60);
  const retryEvery = minutes('LEADS_RETRY_MINUTES', 5);

  if (syncEvery > 0) {
    // Catch up after a restart/deploy/outage, once the server has settled.
    setTimeout(() => void runLeadSync('start-up catch-up'), 30_000).unref();
    setInterval(() => void runLeadSync('scheduled'), syncEvery * 60_000).unref();
  }
  if (retryEvery > 0) setInterval(() => void runLeadRetry(), retryEvery * 60_000).unref();
  console.log(`[auto-sync] on: sync every ${syncEvery || 'never'} min, retry every ${retryEvery || 'never'} min`);
}
