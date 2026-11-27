import { isUuid, sql, withId } from '@/lib/db';
import { graph, graphAll, isInvalidFieldError } from '@/lib/graph';
import { HttpError } from '@/lib/http';
import { FOLLOW_UP_TYPES, LEAD_STATUSES, type FollowUpType, type LeadRow, type LeadStatus } from '@/models/types';
import { getConnectedPages, getPageWithToken } from './pages';

const BASE_LEAD_FIELDS =
  'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,field_data,custom_disclaimer_responses';
// `platform` (fb/ig) is not documented for every API version; we try it and fall back without it.
let leadFields = `${BASE_LEAD_FIELDS},platform`;

async function withFieldFallback<T>(fn: (fields: string) => Promise<T>): Promise<T> {
  try {
    return await fn(leadFields);
  } catch (err) {
    if (leadFields !== BASE_LEAD_FIELDS && isInvalidFieldError(err)) {
      leadFields = BASE_LEAD_FIELDS;
      return fn(leadFields);
    }
    throw err;
  }
}

type RawLead = {
  id: string;
  created_time: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  is_organic?: boolean;
  platform?: string;
  field_data?: { name: string; values: string[] }[];
  custom_disclaimer_responses?: { checkbox_key: string; is_checked: string }[];
};

function normalizePhone(v?: string) {
  if (!v) return undefined;
  const cleaned = v.replace(/[^\d+]/g, '');
  return cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;
}

function leadDoc(raw: RawLead, ctx: { pageId: string; pageName?: string | null; formName?: string }) {
  const fields: Record<string, string> = {};
  for (const f of raw.field_data ?? []) fields[f.name] = (f.values ?? []).join(', ');
  const pick = (...keys: string[]) => keys.map((k) => fields[k]).find(Boolean);
  const fullName =
    pick('full_name', 'name') ?? ([pick('first_name'), pick('last_name')].filter(Boolean).join(' ') || undefined);

  return {
    leadgenId: raw.id,
    pageId: ctx.pageId,
    pageName: ctx.pageName ?? undefined,
    formId: raw.form_id,
    ...(ctx.formName ? { formName: ctx.formName } : {}),
    adId: raw.ad_id,
    adName: raw.ad_name,
    adsetId: raw.adset_id,
    adsetName: raw.adset_name,
    campaignId: raw.campaign_id,
    campaignName: raw.campaign_name,
    platform: raw.platform,
    isOrganic: raw.is_organic,
    fullName,
    email: pick('email', 'work_email')?.toLowerCase(),
    phone: normalizePhone(pick('phone_number', 'phone')),
    fieldData: raw.field_data ?? [],
    fields,
    consents: raw.custom_disclaimer_responses ?? [],
    createdTime: new Date(raw.created_time),
    fetchStatus: 'fetched' as const,
    fetchError: undefined,
    raw,
  };
}

export async function listForms(pageId: string) {
  const { token } = await getPageWithToken(pageId);
  return graphAll<any>(`${pageId}/leadgen_forms`, {
    token,
    params: { fields: 'id,name,status,leads_count,created_time', limit: 100 },
  });
}

/** leadDoc() → column values (jsonb columns wrapped for the driver). */
function toRow(doc: ReturnType<typeof leadDoc>) {
  const { fieldData, fields, consents, raw, fetchError, formName, ...rest } = doc as ReturnType<typeof leadDoc> & { formName?: string };
  return {
    ...rest,
    formName: formName ?? null,
    fetchError: fetchError ?? null,
    fieldData: sql.json(fieldData as any),
    fields: sql.json(fields),
    consents: sql.json(consents as any),
    raw: sql.json(raw as any),
  };
}

// Meta data columns refreshed by sync/fetch. Staff columns (status, follow_up, ...) are never touched.
const metaUpdate = () => sql`
  page_id = excluded.page_id,
  page_name = coalesce(excluded.page_name, devlin.leads.page_name),
  form_id = excluded.form_id,
  form_name = coalesce(excluded.form_name, devlin.leads.form_name),
  ad_id = excluded.ad_id, ad_name = excluded.ad_name,
  adset_id = excluded.adset_id, adset_name = excluded.adset_name,
  campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name,
  platform = excluded.platform, is_organic = excluded.is_organic,
  full_name = excluded.full_name, email = excluded.email, phone = excluded.phone,
  field_data = excluded.field_data, fields = excluded.fields, consents = excluded.consents,
  created_time = excluded.created_time, fetch_status = excluded.fetch_status, fetch_error = null,
  raw = excluded.raw, updated_at = now()`;

/**
 * Pulls leads for every connected page (or one page) and upserts them.
 * Incremental after the first run; also retries leads whose webhook fetch failed.
 * Run it daily as well, to pick up any lead whose webhook ping was missed.
 */
export async function syncLeads(pageId?: string | null, full = false) {
  const pages = await getConnectedPages(pageId);
  const summary: { pageId: string; pageName?: string | null; forms: number; leads: number; error?: string }[] = [];

  for (const { page, token } of pages) {
    const startedAt = new Date();
    const row = { pageId: page.pageId, pageName: page.name, forms: 0, leads: 0 } as (typeof summary)[number];
    try {
      const forms = await graphAll<{ id: string; name: string }>(`${page.pageId}/leadgen_forms`, {
        token,
        params: { fields: 'id,name', limit: 100 },
      });
      row.forms = forms.length;
      // 1-day overlap so nothing slips between runs
      const since = !full && page.leadsSyncedAt ? Math.floor(page.leadsSyncedAt.getTime() / 1000) - 86400 : undefined;

      for (const form of forms) {
        const leads = await withFieldFallback((fields) =>
          graphAll<RawLead>(
            `${form.id}/leads`,
            {
              token,
              params: {
                fields,
                limit: 100,
                filtering: since ? [{ field: 'time_created', operator: 'GREATER_THAN', value: since }] : undefined,
              },
            },
            50,
          ),
        );
        // Upsert in chunks; new rows get source 'sync' and status 'NEW' (column defaults).
        for (let i = 0; i < leads.length; i += 200) {
          const rows = leads
            .slice(i, i + 200)
            .map((l) => toRow(leadDoc({ ...l, form_id: l.form_id ?? form.id }, { pageId: page.pageId, pageName: page.name, formName: form.name })));
          await sql`insert into devlin.leads ${sql(rows)} on conflict (leadgen_id) do update set ${metaUpdate()}`;
        }
        row.leads += leads.length;
      }
      await sql`update devlin.pages set leads_synced_at = ${startedAt}, updated_at = now() where page_id = ${page.pageId}`;
    } catch (err: any) {
      row.error = err.message;
    }
    summary.push(row);
  }

  const retried = await retryPendingLeads();
  return { pages: summary, retried };
}

/** Called from the webhook: store the ping, then fetch the full lead. */
export async function processLeadgenPing(v: { leadgen_id: string; page_id: string; form_id?: string; ad_id?: string; adgroup_id?: string; created_time?: number }) {
  const ping = {
    leadgenId: v.leadgen_id,
    pageId: v.page_id,
    formId: v.form_id ?? null,
    adId: v.ad_id ?? null,
    adsetId: v.adgroup_id ?? null,
    createdTime: v.created_time ? new Date(v.created_time * 1000) : new Date(),
    source: 'webhook',
    fetchStatus: 'pending',
  };
  await sql`insert into devlin.leads ${sql(ping)} on conflict (leadgen_id) do nothing`;
  await fetchLead(v.leadgen_id, v.page_id);
}

async function fetchLead(leadgenId: string, pageId: string) {
  try {
    const { page, token } = await getPageWithToken(pageId);
    const raw = await withFieldFallback((fields) => graph<RawLead>(leadgenId, { token, params: { fields } }));
    let formName: string | undefined;
    if (raw.form_id) {
      formName = await graph<{ name: string }>(raw.form_id, { token, params: { fields: 'name' } })
        .then((f) => f.name)
        .catch(() => undefined);
    }
    const row = toRow(leadDoc(raw, { pageId, pageName: page.name, formName }));
    await sql`
      insert into devlin.leads ${sql(row)}
      on conflict (leadgen_id) do update set ${metaUpdate()}, fetch_attempts = devlin.leads.fetch_attempts + 1`;
    console.log(`[leads] saved ${leadgenId} from "${page.name ?? pageId}"`);
  } catch (err: any) {
    console.warn(`[leads] could not fetch ${leadgenId} (page ${pageId}): ${err.message}. Will retry.`);
    await sql`
      update devlin.leads set fetch_status = 'failed', fetch_error = ${err.message},
        fetch_attempts = fetch_attempts + 1, updated_at = now()
      where leadgen_id = ${leadgenId}`;
  }
}

export async function retryPendingLeads(maxAttempts = 5) {
  const stuck = await sql<{ leadgenId: string; pageId: string | null }[]>`
    select leadgen_id, page_id from devlin.leads
    where fetch_status in ('pending', 'failed') and fetch_attempts < ${maxAttempts}
    limit 100`;
  for (const l of stuck) if (l.pageId) await fetchLead(l.leadgenId, l.pageId);
  return stuck.length;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** API shape: `_id` instead of `id`, never the raw Meta payload. */
function publicLead(row: LeadRow) {
  const { raw: _raw, ...rest } = row;
  return withId(rest);
}

export async function queryLeads(q: {
  pageId?: string | null;
  formId?: string | null;
  search?: string | null;
  status?: string | null; // lead workflow status (NEW, WORKING, ...) or ALL
  fetchStatus?: string | null;
  from?: string | null;
  to?: string | null;
  page: number;
  pageSize: number;
}) {
  // Base filter = everything except the status tab, so tab counts reflect the other filters.
  const conds = [sql`true`];
  const onePage = q.pageId && q.pageId !== 'all' ? q.pageId : null;
  if (onePage) conds.push(sql`page_id = ${onePage}`);
  if (q.formId) conds.push(sql`form_id = ${q.formId}`);
  if (q.fetchStatus) conds.push(sql`fetch_status = ${q.fetchStatus}`);
  if (q.from) conds.push(sql`created_time >= ${new Date(q.from)}`);
  if (q.to) conds.push(sql`created_time <= ${new Date(`${q.to}T23:59:59.999Z`)}`);
  if (q.search) {
    const p = `%${likeEscape(q.search)}%`;
    conds.push(sql`(full_name ilike ${p} or email ilike ${p} or phone ilike ${p}
      or campaign_name ilike ${p} or ad_name ilike ${p} or form_name ilike ${p})`);
  }
  const base = conds.reduce((acc, c) => sql`${acc} and ${c}`);
  const filter = q.status && q.status !== 'ALL' ? sql`${base} and status = ${q.status}` : base;

  const [items, [{ total }], counts, forms] = await Promise.all([
    sql<LeadRow[]>`
      select * from devlin.leads where ${filter}
      order by created_time desc nulls last
      limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`,
    sql<{ total: number }[]>`select count(*)::int as total from devlin.leads where ${filter}`,
    sql<{ status: string; count: number }[]>`
      select status, count(*)::int as count from devlin.leads where ${base} group by status`,
    sql<{ id: string; name: string | null; count: number }[]>`
      select form_id as id, max(form_name) as name, count(*)::int as count from devlin.leads
      where form_id is not null ${onePage ? sql`and page_id = ${onePage}` : sql``}
      group by form_id order by count desc`,
  ]);

  const statusCounts: Record<string, number> = { ALL: 0 };
  for (const s of LEAD_STATUSES) statusCounts[s] = 0;
  for (const c of counts) {
    statusCounts[c.status] = c.count;
    statusCounts.ALL += c.count;
  }

  return {
    items: items.map(publicLead),
    total,
    page: q.page,
    pageSize: q.pageSize,
    statuses: ['ALL', ...LEAD_STATUSES],
    statusCounts,
    forms,
  };
}

/** Staff updates: status and/or follow-up. Never touches the Meta data. */
export async function updateLead(
  id: string,
  body: { status?: string; followUp?: { at?: string | null; type?: string; notes?: string } | null },
) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid lead id');

  return sql.begin(async (tx) => {
    const [lead] = await tx<LeadRow[]>`select * from devlin.leads where id = ${id} for update`;
    if (!lead) throw new HttpError(404, 'Lead not found');

    let status = lead.status;
    let statusHistory = lead.statusHistory ?? [];
    if (body.status !== undefined) {
      if (!(LEAD_STATUSES as readonly string[]).includes(body.status)) {
        throw new HttpError(400, `status must be one of ${LEAD_STATUSES.join(', ')}`);
      }
      if (lead.status !== body.status) {
        status = body.status as LeadStatus;
        statusHistory = [...statusHistory, { status: body.status, at: new Date().toISOString() }];
      }
    }

    let followUp = lead.followUp;
    if (body.followUp === null) {
      followUp = null;
    } else if (body.followUp) {
      const { at, type, notes } = body.followUp;
      const when = at ? new Date(at) : null;
      if (!when || Number.isNaN(when.getTime())) throw new HttpError(400, 'followUp.at must be a valid date');
      if (type && !(FOLLOW_UP_TYPES as readonly string[]).includes(type)) {
        throw new HttpError(400, `followUp.type must be one of ${FOLLOW_UP_TYPES.join(', ')}`);
      }
      followUp = { at: when.toISOString(), type: (type ?? 'CALL') as FollowUpType, ...(notes?.trim() ? { notes: notes.trim() } : {}) };
    }

    const [updated] = await tx<LeadRow[]>`
      update devlin.leads set
        status = ${status},
        status_history = ${tx.json(statusHistory)},
        follow_up = ${followUp ? tx.json(followUp) : null},
        updated_at = now()
      where id = ${id}
      returning *`;
    return publicLead(updated);
  });
}
