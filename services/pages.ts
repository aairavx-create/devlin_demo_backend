import { decrypt, encrypt } from '@/lib/crypto';
import { sql, withId } from '@/lib/db';
import { GraphError, graph, graphAll } from '@/lib/graph';
import { HttpError } from '@/lib/http';
import type { MainAccountRow, PageAccessRequestRow, PageRow } from '@/models/types';
import { requireMainAccount } from './account';

const BASE_FIELDS = 'id,name,category,link,picture{url}';
const IG_FIELDS = 'instagram_business_account{id,username,profile_picture_url}';

export const PAGE_TASKS = ['MANAGE', 'CREATE_CONTENT', 'MODERATE', 'ADVERTISE', 'ANALYZE'] as const;

type Relationship = 'personal' | 'owned' | 'client';
type RawPage = {
  id: string;
  name?: string;
  category?: string;
  link?: string;
  fan_count?: number;
  picture?: { data?: { url?: string } };
  access_token?: string;
  tasks?: string[];
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
};
type MainAccountDocument = MainAccountRow;

/**
 * Assigns the main account's business user to a client page, so a page token can be issued.
 * Best effort: needs business_management and an admin role in the Business portfolio.
 */
async function assignSelfToPage(account: MainAccountDocument, token: string, pageId: string, tasks: string[]) {
  if (!account.businessId) throw new Error('no business selected');
  const users = await graphAll<{ id: string; name?: string; email?: string }>(`${account.businessId}/business_users`, {
    token,
    params: { fields: 'id,name,email', limit: 200 },
  });
  const me =
    users.find((u) => account.email && u.email?.toLowerCase() === account.email.toLowerCase()) ??
    users.find((u) => u.name && u.name === account.name);
  if (!me) throw new Error('could not find you among the business users');
  await graph(`${pageId}/assigned_users`, {
    method: 'POST',
    token,
    params: { user: me.id, tasks: tasks.length ? tasks : ['ANALYZE', 'ADVERTISE'], business: account.businessId },
  });
}

/** Pulls every Page the main account can reach (personal, business-owned, business-client) and stores page tokens. */
export async function syncPages() {
  const { account, token } = await requireMainAccount();
  const warnings: string[] = [];
  const found = new Map<string, { raw: RawPage; relationship: Relationship }>();

  const mine = await graphAll<RawPage>('me/accounts', {
    token,
    params: { fields: `${BASE_FIELDS},fan_count,access_token,tasks,${IG_FIELDS}`, limit: 100 },
  });
  for (const p of mine) found.set(p.id, { raw: p, relationship: 'personal' });

  if (account.businessId) {
    for (const [edge, relationship] of [
      ['owned_pages', 'owned'],
      ['client_pages', 'client'],
    ] as const) {
      try {
        const list = await graphAll<RawPage>(`${account.businessId}/${edge}`, { token, params: { fields: BASE_FIELDS, limit: 100 } });
        for (const p of list) {
          const prev = found.get(p.id);
          found.set(p.id, { raw: { ...p, ...prev?.raw }, relationship });
        }
      } catch (err: any) {
        warnings.push(`Could not read ${edge}: ${err.message}`);
      }
    }
  }

  // Tasks requested for client pages, used when auto-assigning
  const approved = await sql<PageAccessRequestRow[]>`
    select page_id, permitted_tasks from devlin.page_access_requests
    where main_account_id = ${account.id} and status = 'approved'`;
  const tasksByPage = new Map(approved.map((r) => [r.pageId, r.permittedTasks ?? []]));
  const subscribed = await sql<{ pageId: string }[]>`select page_id from devlin.pages where leadgen_subscribed`;
  const alreadySubscribed = new Set(subscribed.map((r) => r.pageId));

  const now = new Date();
  for (const { raw, relationship } of found.values()) {
    let pageToken = raw.access_token;
    const fetchToken = async () => {
      const r = await graph<{ access_token?: string }>(raw.id, { token, params: { fields: 'access_token' } });
      return r.access_token;
    };
    if (!pageToken) pageToken = await fetchToken().catch(() => undefined);
    if (!pageToken && relationship !== 'personal') {
      try {
        await assignSelfToPage(account, token, raw.id, tasksByPage.get(raw.id) ?? []);
        pageToken = await fetchToken();
      } catch (err: any) {
        warnings.push(
          `No page token for "${raw.name ?? raw.id}" (${err.message}). In Business Settings → Accounts → Pages, assign yourself to this page, then sync again.`,
        );
      }
    }

    let details: RawPage = raw;
    if (pageToken && !raw.instagram_business_account) {
      try {
        details = { ...raw, ...(await graph<RawPage>(raw.id, { token: pageToken, params: { fields: `fan_count,${IG_FIELDS}` } })) };
      } catch {
        /* optional */
      }
    }

    const row = {
      pageId: raw.id,
      mainAccountId: account.id,
      name: details.name,
      category: details.category,
      link: details.link,
      pictureUrl: details.picture?.data?.url,
      fanCount: details.fan_count,
      relationship,
      tasks: details.tasks ?? [],
      instagram: details.instagram_business_account
        ? sql.json({
            id: details.instagram_business_account.id,
            username: details.instagram_business_account.username,
            pictureUrl: details.instagram_business_account.profile_picture_url,
          })
        : null,
      // A null here keeps the token already stored (see the coalesce below).
      accessTokenEnc: pageToken ? encrypt(pageToken) : null,
      hasToken: Boolean(pageToken),
      active: true,
      lastSyncedAt: now,
    };
    await sql`
      insert into devlin.pages ${sql(row)}
      on conflict (page_id) do update set
        main_account_id = excluded.main_account_id, name = excluded.name, category = excluded.category,
        link = excluded.link, picture_url = excluded.picture_url, fan_count = excluded.fan_count,
        relationship = excluded.relationship, tasks = excluded.tasks, instagram = excluded.instagram,
        access_token_enc = coalesce(excluded.access_token_enc, devlin.pages.access_token_enc),
        has_token = excluded.has_token, active = true, last_synced_at = excluded.last_synced_at, updated_at = now()`;

    // Subscribe every page we can, so Meta pushes new leads to /api/webhooks/meta the moment they're submitted.
    if (pageToken && !alreadySubscribed.has(raw.id)) {
      try {
        await subscribeLeadgen(raw.id);
      } catch (err: any) {
        warnings.push(`Could not subscribe "${raw.name ?? raw.id}" to lead webhooks (${err.message}). New leads will still arrive via sync.`);
      }
    }
  }

  // Pages we can no longer see are kept (for lead history) but marked inactive.
  await sql`
    update devlin.pages set active = false, updated_at = now()
    where main_account_id = ${account.id} and not (page_id = any(${[...found.keys()]}::text[]))`;
  await sql`update devlin.main_accounts set last_pages_sync_at = ${now}, updated_at = now() where id = ${account.id}`;
  await markApprovedRequests(account, [...found.entries()].filter(([, v]) => v.relationship === 'client').map(([id]) => id));

  return { synced: found.size, warnings };
}

export async function listPages() {
  const { account } = await requireMainAccount();
  const pages = await sql<PageRow[]>`
    select * from devlin.pages where main_account_id = ${account.id}
    order by active desc, relationship asc, name asc`;
  // Tokens never leave the server.
  return pages.map(({ accessTokenEnc: _token, ...p }) => withId(p));
}

export async function getPageWithToken(pageId: string) {
  const [page] = await sql<PageRow[]>`select * from devlin.pages where page_id = ${pageId}`;
  if (!page) throw new HttpError(404, `Page ${pageId} is not linked`);
  if (!page.accessTokenEnc) throw new HttpError(409, `No access token stored for page "${page.name}"`);
  return { page, token: decrypt(page.accessTokenEnc) };
}

export async function getConnectedPages(pageId?: string | null) {
  const one = pageId && pageId !== 'all' ? pageId : null;
  const pages = await sql<PageRow[]>`
    select * from devlin.pages
    where active and has_token and access_token_enc is not null ${one ? sql`and page_id = ${one}` : sql``}`;
  if (one && pages.length === 0) throw new HttpError(404, `Page ${pageId} is not connected`);
  return pages.map((page) => ({ page, token: decrypt(page.accessTokenEnc!) }));
}

/** Subscribes every connected page that isn't subscribed yet (self-healing; run by the background job). */
export async function subscribeMissingPages() {
  const pages = await sql<{ pageId: string; name: string | null }[]>`
    select page_id, name from devlin.pages where active and has_token and not leadgen_subscribed`;
  const done: string[] = [];
  const failed: string[] = [];
  for (const p of pages) {
    try {
      await subscribeLeadgen(p.pageId);
      done.push(p.name ?? p.pageId);
    } catch (err: any) {
      failed.push(`${p.name ?? p.pageId}: ${err.message}`);
    }
  }
  return { done, failed };
}

/** Installs the app on the Page so Meta sends leadgen webhooks for it. */
export async function subscribeLeadgen(pageId: string) {
  const { page, token } = await getPageWithToken(pageId);
  await graph(`${pageId}/subscribed_apps`, { method: 'POST', token, params: { subscribed_fields: 'leadgen' } });
  await sql`update devlin.pages set leadgen_subscribed = true, updated_at = now() where id = ${page.id}`;
  return { pageId, leadgenSubscribed: true };
}

// ---------------- Page access requests ----------------

async function resolvePageId(input: string, token: string) {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return { id: trimmed, name: undefined as string | undefined };
  let handle = trimmed;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://facebook.com/${trimmed}`);
    const idParam = url.searchParams.get('id') ?? url.searchParams.get('asset_id');
    if (idParam && /^\d+$/.test(idParam)) return { id: idParam, name: undefined };
    const segments = url.pathname.split('/').filter(Boolean);
    // e.g. facebook.com/765544103316989/page_completion_meter/ or facebook.com/profile.php?id=...
    const numeric = segments.find((s) => /^\d{6,}$/.test(s));
    if (numeric) return { id: numeric, name: undefined };
    handle = segments[0] ?? trimmed;
    const tail = handle.match(/-(\d{6,})$/);
    if (tail) return { id: tail[1], name: undefined };
  } catch {
    /* treat as handle */
  }
  try {
    const r = await graph<{ id: string; name: string }>(handle, { token, params: { fields: 'id,name' } });
    return { id: r.id, name: r.name };
  } catch {
    throw new HttpError(400, `Could not resolve "${input}". Use the numeric Page ID (Page → About → Page transparency).`);
  }
}

/**
 * Sends a partner request from the Business portfolio to a Page.
 * The Page's admin accepts it in Meta Business Suite → Settings → Requests (or the Page's access settings).
 */
export async function requestPageAccess(input: string, tasks: string[], note?: string) {
  const { account, token } = await requireMainAccount();
  if (!account.businessId) {
    throw new HttpError(
      409,
      'Requesting page access needs a Business portfolio. Create one at business.facebook.com, add the business_management permission, then Reconnect.',
    );
  }
  const permitted = tasks.filter((t) => (PAGE_TASKS as readonly string[]).includes(t));
  if (permitted.length === 0) throw new HttpError(400, `Pick at least one task: ${PAGE_TASKS.join(', ')}`);

  const { id: pageId, name } = await resolvePageId(input, token);
  const [linked] = await sql`
    select 1 from devlin.pages where page_id = ${pageId} and main_account_id = ${account.id} and active and has_token`;
  if (linked) throw new HttpError(409, 'This page is already linked.');
  const [dupe] = await sql`
    select 1 from devlin.page_access_requests
    where page_id = ${pageId} and business_id = ${account.businessId} and status = 'pending'`;
  if (dupe) throw new HttpError(409, 'A pending request for this page already exists.');

  const request = {
    pageId,
    pageName: name ?? null,
    mainAccountId: account.id,
    businessId: account.businessId,
    permittedTasks: permitted,
    note: note ?? null,
    status: 'pending' as PageAccessRequestRow['status'],
    metaAccessStatus: null as string | null,
    error: null as string | null,
    resolvedAt: null as Date | null,
  };
  try {
    const r = await graph<{ access_status?: string }>(`${account.businessId}/client_pages`, {
      method: 'POST',
      token,
      params: { page_id: pageId, permitted_tasks: permitted },
    });
    request.metaAccessStatus = r.access_status ?? null;
    if (r.access_status === 'CONFIRMED') {
      request.status = 'approved';
      request.resolvedAt = new Date();
    }
  } catch (err) {
    request.status = 'failed';
    request.error = err instanceof GraphError ? err.message : String(err);
  }
  const [saved] = await sql<PageAccessRequestRow[]>`insert into devlin.page_access_requests ${sql(request)} returning *`;
  if (saved.status === 'approved') await syncPages().catch(() => undefined);
  return withId(saved);
}

async function markApprovedRequests(account: MainAccountDocument, clientPageIds: string[]) {
  if (!clientPageIds.length) return 0;
  const r = await sql`
    update devlin.page_access_requests set status = 'approved', resolved_at = now(), updated_at = now()
    where main_account_id = ${account.id} and status = 'pending' and page_id = any(${clientPageIds}::text[])`;
  return r.count;
}

/** Re-checks pending requests; when one was accepted, syncs pages so its token gets stored. */
export async function listAccessRequests(refresh: boolean) {
  const { account, token } = await requireMainAccount();
  const [pending] = await sql`
    select 1 from devlin.page_access_requests where main_account_id = ${account.id} and status = 'pending' limit 1`;
  if (refresh && account.businessId && pending) {
    const clientPages = await graphAll<{ id: string }>(`${account.businessId}/client_pages`, { token, params: { fields: 'id', limit: 100 } });
    if ((await markApprovedRequests(account, clientPages.map((p) => p.id))) > 0) await syncPages();
  }
  const rows = await sql<PageAccessRequestRow[]>`
    select * from devlin.page_access_requests where main_account_id = ${account.id} order by created_at desc`;
  return rows.map(withId);
}

/** Removes the local record only. To withdraw the request on Meta's side, remove it in Business Settings. */
export async function deleteAccessRequest(id: string) {
  await sql`delete from devlin.page_access_requests where id = ${id}`;
}
