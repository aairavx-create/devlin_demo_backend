import { graph, graphAll, isInvalidFieldError } from '@/lib/graph';
import { isValidObjectId } from 'mongoose';
import { HttpError } from '@/lib/http';
import { FOLLOW_UP_TYPES, LEAD_STATUSES, Lead } from '@/models/Lead';
import { Page } from '@/models/Page';
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
        if (leads.length) {
          await Lead.bulkWrite(
            leads.map((l) => {
              const doc = leadDoc({ ...l, form_id: l.form_id ?? form.id }, { pageId: page.pageId, pageName: page.name, formName: form.name });
              return {
                updateOne: {
                  filter: { leadgenId: l.id },
                  update: { $set: doc as Record<string, unknown>, $setOnInsert: { source: 'sync' as const, status: 'NEW' } },
                  upsert: true,
                },
              };
            }),
          );
        }
        row.leads += leads.length;
      }
      await Page.updateOne({ pageId: page.pageId }, { leadsSyncedAt: startedAt });
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
  await Lead.updateOne(
    { leadgenId: v.leadgen_id },
    {
      $setOnInsert: {
        leadgenId: v.leadgen_id,
        pageId: v.page_id,
        formId: v.form_id,
        adId: v.ad_id,
        adsetId: v.adgroup_id,
        createdTime: v.created_time ? new Date(v.created_time * 1000) : new Date(),
        source: 'webhook',
        fetchStatus: 'pending',
        status: 'NEW',
      },
    },
    { upsert: true },
  );
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
    await Lead.updateOne(
      { leadgenId },
      { $set: leadDoc(raw, { pageId, pageName: page.name, formName }), $inc: { fetchAttempts: 1 } },
    );
  } catch (err: any) {
    await Lead.updateOne({ leadgenId }, { $set: { fetchStatus: 'failed', fetchError: err.message }, $inc: { fetchAttempts: 1 } });
  }
}

export async function retryPendingLeads(maxAttempts = 5) {
  const stuck = await Lead.find({ fetchStatus: { $in: ['pending', 'failed'] }, fetchAttempts: { $lt: maxAttempts } })
    .limit(100)
    .lean();
  for (const l of stuck) if (l.pageId) await fetchLead(l.leadgenId, l.pageId);
  return stuck.length;
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
  const base: Record<string, any> = {};
  if (q.pageId && q.pageId !== 'all') base.pageId = q.pageId;
  if (q.formId) base.formId = q.formId;
  if (q.fetchStatus) base.fetchStatus = q.fetchStatus;
  if (q.from || q.to) {
    base.createdTime = {};
    if (q.from) base.createdTime.$gte = new Date(q.from);
    if (q.to) base.createdTime.$lte = new Date(`${q.to}T23:59:59.999Z`);
  }
  if (q.search) {
    const rx = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    base.$or = [{ fullName: rx }, { email: rx }, { phone: rx }, { campaignName: rx }, { adName: rx }, { formName: rx }];
  }
  const filter: Record<string, any> = { ...base };
  if (q.status && q.status !== 'ALL') {
    // Leads stored before statuses existed count as NEW
    filter.status = q.status === 'NEW' ? { $in: ['NEW', null] } : q.status;
  }

  const [items, total, counts, forms] = await Promise.all([
    Lead.find(filter)
      .select('-raw')
      .sort({ createdTime: -1 })
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .lean(),
    Lead.countDocuments(filter),
    Lead.aggregate([{ $match: base }, { $group: { _id: { $ifNull: ['$status', 'NEW'] }, count: { $sum: 1 } } }]),
    Lead.aggregate([
      { $match: q.pageId && q.pageId !== 'all' ? { pageId: q.pageId } : {} },
      { $group: { _id: '$formId', name: { $first: '$formName' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const statusCounts: Record<string, number> = { ALL: 0 };
  for (const s of LEAD_STATUSES) statusCounts[s] = 0;
  for (const c of counts) {
    statusCounts[c._id] = c.count;
    statusCounts.ALL += c.count;
  }

  return {
    items: items.map((l) => ({ ...l, status: l.status ?? 'NEW' })),
    total,
    page: q.page,
    pageSize: q.pageSize,
    statuses: ['ALL', ...LEAD_STATUSES],
    statusCounts,
    forms: forms.filter((f) => f._id).map((f) => ({ id: f._id, name: f.name, count: f.count })),
  };
}

/** Staff updates: status and/or follow-up. Never touches the Meta data. */
export async function updateLead(
  id: string,
  body: { status?: string; followUp?: { at?: string | null; type?: string; notes?: string } | null },
) {
  if (!isValidObjectId(id)) throw new HttpError(400, 'Invalid lead id');
  const lead = await Lead.findById(id);
  if (!lead) throw new HttpError(404, 'Lead not found');

  if (body.status !== undefined) {
    if (!(LEAD_STATUSES as readonly string[]).includes(body.status)) {
      throw new HttpError(400, `status must be one of ${LEAD_STATUSES.join(', ')}`);
    }
    if (lead.status !== body.status) {
      lead.status = body.status as (typeof LEAD_STATUSES)[number];
      lead.statusHistory.push({ status: body.status, at: new Date() });
    }
  }

  if (body.followUp === null) {
    lead.set('followUp', undefined);
  } else if (body.followUp) {
    const { at, type, notes } = body.followUp;
    const when = at ? new Date(at) : null;
    if (!when || Number.isNaN(when.getTime())) throw new HttpError(400, 'followUp.at must be a valid date');
    if (type && !(FOLLOW_UP_TYPES as readonly string[]).includes(type)) {
      throw new HttpError(400, `followUp.type must be one of ${FOLLOW_UP_TYPES.join(', ')}`);
    }
    lead.set('followUp', { at: when, type: type ?? 'CALL', notes: notes?.trim() || undefined });
  }

  await lead.save();
  const out = lead.toObject();
  delete (out as any).raw;
  return out;
}
