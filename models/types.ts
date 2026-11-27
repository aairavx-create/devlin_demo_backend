// Row shapes for the devlin.* Postgres tables (columns come back camelCased, see lib/db.ts).

// Same workflow as the Lead Management app (C:\Aairavx\Lead_managment).
export const LEAD_STATUSES = ['NEW', 'WORKING', 'UNQUALIFIED', 'QUALIFIED', 'CLOSE', 'INVALID'] as const;
export const FOLLOW_UP_TYPES = ['CALL', 'WHATSAPP', 'EMAIL', 'VISIT'] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type FollowUpType = (typeof FOLLOW_UP_TYPES)[number];

export type MainAccountRow = {
  id: string;
  fbUserId: string;
  name: string | null;
  email: string | null;
  pictureUrl: string | null;
  accessTokenEnc: string;
  tokenExpiresAt: Date | null;
  grantedScopes: string[];
  businesses: { id: string; name: string }[];
  businessId: string | null;
  isActive: boolean;
  lastPagesSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PageRow = {
  id: string;
  pageId: string;
  mainAccountId: string | null;
  name: string | null;
  category: string | null;
  pictureUrl: string | null;
  link: string | null;
  fanCount: number | null;
  relationship: 'personal' | 'owned' | 'client';
  tasks: string[];
  instagram: { id?: string; username?: string; pictureUrl?: string } | null;
  accessTokenEnc: string | null;
  hasToken: boolean;
  active: boolean;
  leadgenSubscribed: boolean;
  leadsSyncedAt: Date | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PageAccessRequestRow = {
  id: string;
  pageId: string;
  pageName: string | null;
  mainAccountId: string | null;
  businessId: string;
  permittedTasks: string[];
  status: 'pending' | 'approved' | 'failed';
  metaAccessStatus: string | null;
  error: string | null;
  note: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LeadRow = {
  id: string;
  leadgenId: string;
  pageId: string | null;
  pageName: string | null;
  formId: string | null;
  formName: string | null;
  adId: string | null;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  platform: string | null;
  isOrganic: boolean | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  fieldData: { name: string; values: string[] }[];
  fields: Record<string, string>;
  consents: { checkbox_key: string; is_checked: string }[];
  createdTime: Date | null;
  status: LeadStatus;
  statusHistory: { status: string; at: string }[];
  followUp: { at: string; type: FollowUpType; notes?: string } | null;
  source: 'webhook' | 'sync';
  fetchStatus: 'pending' | 'fetched' | 'failed';
  fetchError: string | null;
  fetchAttempts: number;
  raw?: unknown;
  createdAt: Date;
  updatedAt: Date;
};
