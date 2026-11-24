import { decrypt, encrypt } from '@/lib/crypto';
import { GraphError, graph, graphAll } from '@/lib/graph';
import { HttpError } from '@/lib/http';
import { Page } from '@/models/Page';
import { PageAccessRequest } from '@/models/PageAccessRequest';
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
type MainAccountDocument = Awaited<ReturnType<typeof requireMainAccount>>['account'];

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
  const approved = await PageAccessRequest.find({ mainAccountId: account._id, status: 'approved' }).lean();
  const tasksByPage = new Map(approved.map((r) => [r.pageId, r.permittedTasks ?? []]));

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

    const update: Record<string, unknown> = {
      pageId: raw.id,
      mainAccountId: account._id,
      name: details.name,
      category: details.category,
      link: details.link,
      pictureUrl: details.picture?.data?.url,
      fanCount: details.fan_count,
      relationship,
      tasks: details.tasks ?? [],
      instagram: details.instagram_business_account
        ? {
            id: details.instagram_business_account.id,
            username: details.instagram_business_account.username,
            pictureUrl: details.instagram_business_account.profile_picture_url,
          }
        : undefined,
      hasToken: Boolean(pageToken),
      active: true,
      lastSyncedAt: now,
    };
    if (pageToken) update.accessTokenEnc = encrypt(pageToken);
    await Page.findOneAndUpdate({ pageId: raw.id }, update, { upsert: true });
  }

  // Pages we can no longer see are kept (for lead history) but marked inactive.
  await Page.updateMany({ mainAccountId: account._id, pageId: { $nin: [...found.keys()] } }, { active: false });
  account.lastPagesSyncAt = now;
  await account.save();
  await markApprovedRequests(account, [...found.entries()].filter(([, v]) => v.relationship === 'client').map(([id]) => id));

  return { synced: found.size, warnings };
}

export async function listPages() {
  const { account } = await requireMainAccount();
  return Page.find({ mainAccountId: account._id }).sort({ active: -1, relationship: 1, name: 1 }).lean();
}

export async function getPageWithToken(pageId: string) {
  const page = await Page.findOne({ pageId }).select('+accessTokenEnc');
  if (!page) throw new HttpError(404, `Page ${pageId} is not linked`);
  if (!page.accessTokenEnc) throw new HttpError(409, `No access token stored for page "${page.name}"`);
  return { page, token: decrypt(page.accessTokenEnc) };
}

export async function getConnectedPages(pageId?: string | null) {
  const filter: Record<string, unknown> = { active: true, hasToken: true };
  if (pageId && pageId !== 'all') filter.pageId = pageId;
  const pages = await Page.find(filter).select('+accessTokenEnc');
  if (pageId && pageId !== 'all' && pages.length === 0) throw new HttpError(404, `Page ${pageId} is not connected`);
  return pages.map((page) => ({ page, token: decrypt(page.accessTokenEnc!) }));
}

/** Installs the app on the Page so Meta sends leadgen webhooks for it. */
export async function subscribeLeadgen(pageId: string) {
  const { page, token } = await getPageWithToken(pageId);
  await graph(`${pageId}/subscribed_apps`, { method: 'POST', token, params: { subscribed_fields: 'leadgen' } });
  page.leadgenSubscribed = true;
  await page.save();
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
  if (await Page.exists({ pageId, mainAccountId: account._id, active: true, hasToken: true })) {
    throw new HttpError(409, 'This page is already linked.');
  }
  if (await PageAccessRequest.exists({ pageId, businessId: account.businessId, status: 'pending' })) {
    throw new HttpError(409, 'A pending request for this page already exists.');
  }

  const request = new PageAccessRequest({ pageId, pageName: name, mainAccountId: account._id, businessId: account.businessId, permittedTasks: permitted, note });
  try {
    const r = await graph<{ access_status?: string }>(`${account.businessId}/client_pages`, {
      method: 'POST',
      token,
      params: { page_id: pageId, permitted_tasks: permitted },
    });
    request.metaAccessStatus = r.access_status;
    if (r.access_status === 'CONFIRMED') {
      request.status = 'approved';
      request.resolvedAt = new Date();
    }
  } catch (err) {
    request.status = 'failed';
    request.error = err instanceof GraphError ? err.message : String(err);
  }
  await request.save();
  if (request.status === 'approved') await syncPages().catch(() => undefined);
  return request.toObject();
}

async function markApprovedRequests(account: MainAccountDocument, clientPageIds: string[]) {
  if (!clientPageIds.length) return 0;
  const r = await PageAccessRequest.updateMany(
    { mainAccountId: account._id, status: 'pending', pageId: { $in: clientPageIds } },
    { status: 'approved', resolvedAt: new Date() },
  );
  return r.modifiedCount;
}

/** Re-checks pending requests; when one was accepted, syncs pages so its token gets stored. */
export async function listAccessRequests(refresh: boolean) {
  const { account, token } = await requireMainAccount();
  if (refresh && account.businessId && (await PageAccessRequest.exists({ mainAccountId: account._id, status: 'pending' }))) {
    const clientPages = await graphAll<{ id: string }>(`${account.businessId}/client_pages`, { token, params: { fields: 'id', limit: 100 } });
    if ((await markApprovedRequests(account, clientPages.map((p) => p.id))) > 0) await syncPages();
  }
  return PageAccessRequest.find({ mainAccountId: account._id }).sort({ createdAt: -1 }).lean();
}
