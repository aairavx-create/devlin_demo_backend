import { graph, graphAll, type Paged } from '@/lib/graph';
import { HttpError } from '@/lib/http';
import { requireMainAccount } from './account';

export const DATE_PRESETS = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month', 'maximum'];
const LEAD_ACTIONS = new Set(['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']);
const ACCOUNT_STATUS: Record<number, string> = { 1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 9: 'IN_GRACE_PERIOD', 101: 'CLOSED' };

export async function listAdAccounts() {
  const { token } = await requireMainAccount();
  const rows = await graphAll<any>('me/adaccounts', {
    token,
    params: { fields: 'id,account_id,name,account_status,currency,business{id,name}', limit: 100 },
  });
  return rows.map((a) => ({
    id: a.id,
    accountId: a.account_id,
    name: a.name,
    currency: a.currency,
    status: ACCOUNT_STATUS[a.account_status] ?? String(a.account_status),
    business: a.business,
  }));
}

export async function listAds(opts: { adAccountId: string; datePreset: string; status?: string | null; after?: string | null; limit: number }) {
  const { token } = await requireMainAccount();
  if (!/^act_\d+$/.test(opts.adAccountId)) throw new HttpError(400, 'adAccountId must look like act_123');
  if (!DATE_PRESETS.includes(opts.datePreset)) throw new HttpError(400, `datePreset must be one of ${DATE_PRESETS.join(', ')}`);

  const fields = [
    'id,name,status,effective_status,created_time',
    'campaign{id,name,objective}',
    'adset{id,name}',
    'creative{id,title,body,thumbnail_url,image_url}',
    `insights.date_preset(${opts.datePreset}){impressions,reach,clicks,spend,ctr,cpc,cpm,actions}`,
  ].join(',');

  const params: Record<string, any> = { fields, limit: opts.limit, after: opts.after ?? undefined };
  if (opts.status) params.effective_status = [opts.status];

  const r = await graph<Paged<any>>(`${opts.adAccountId}/ads`, { token, params });
  const ads = r.data.map((ad) => {
    const ins = ad.insights?.data?.[0] ?? {};
    const leads = (ins.actions ?? [])
      .filter((a: any) => LEAD_ACTIONS.has(a.action_type))
      .reduce((max: number, a: any) => Math.max(max, Number(a.value) || 0), 0);
    return {
      id: ad.id,
      name: ad.name,
      status: ad.status,
      effectiveStatus: ad.effective_status,
      createdAt: ad.created_time,
      campaign: ad.campaign,
      adset: ad.adset,
      creative: {
        id: ad.creative?.id,
        title: ad.creative?.title,
        body: ad.creative?.body,
        thumbnailUrl: ad.creative?.thumbnail_url ?? ad.creative?.image_url,
      },
      insights: {
        impressions: Number(ins.impressions ?? 0),
        reach: Number(ins.reach ?? 0),
        clicks: Number(ins.clicks ?? 0),
        spend: Number(ins.spend ?? 0),
        ctr: ins.ctr != null ? Number(ins.ctr) : null,
        cpc: ins.cpc != null ? Number(ins.cpc) : null,
        cpm: ins.cpm != null ? Number(ins.cpm) : null,
        leads,
      },
    };
  });

  return { ads, next: r.paging?.next ? r.paging.cursors?.after ?? null : null };
}
