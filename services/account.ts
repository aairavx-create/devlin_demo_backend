import { decrypt, encrypt } from '@/lib/crypto';
import { env } from '@/lib/env';
import { graph, graphAll } from '@/lib/graph';
import { HttpError } from '@/lib/http';
import { MainAccount } from '@/models/MainAccount';
import { Page } from '@/models/Page';

export function buildLoginUrl(state: string) {
  const url = new URL(`https://www.facebook.com/${env.graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', env.appId);
  url.searchParams.set('redirect_uri', env.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (env.loginConfigId) url.searchParams.set('config_id', env.loginConfigId);
  else url.searchParams.set('scope', env.scopes.join(','));
  return url.toString();
}

/** Exchanges the OAuth code for a long-lived user token and saves the main account. */
export async function connectMainAccount(code: string) {
  const short = await graph<{ access_token: string }>('oauth/access_token', {
    params: { client_id: env.appId, client_secret: env.appSecret, redirect_uri: env.redirectUri, code },
  });
  const long = await graph<{ access_token: string; expires_in?: number }>('oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: env.appId,
      client_secret: env.appSecret,
      fb_exchange_token: short.access_token,
    },
  });
  const token = long.access_token;

  const me = await graph<{ id: string; name: string; email?: string; picture?: { data?: { url?: string } } }>('me', {
    token,
    params: { fields: 'id,name,email,picture{url}' },
  });
  const perms = await graphAll<{ permission: string; status: string }>('me/permissions', { token }).catch(() => []);
  // Needs business_management. Empty if the user has no Business portfolio.
  const businesses = await graphAll<{ id: string; name: string }>('me/businesses', {
    token,
    params: { fields: 'id,name', limit: 100 },
  }).catch(() => []);

  const existing = await MainAccount.findOne({ fbUserId: me.id });
  const businessId =
    existing?.businessId && businesses.some((b) => b.id === existing.businessId) ? existing.businessId : businesses[0]?.id;

  // Only one main account is active at a time.
  await MainAccount.updateMany({ fbUserId: { $ne: me.id } }, { isActive: false });
  const account = await MainAccount.findOneAndUpdate(
    { fbUserId: me.id },
    {
      fbUserId: me.id,
      name: me.name,
      email: me.email,
      pictureUrl: me.picture?.data?.url,
      accessTokenEnc: encrypt(token),
      tokenExpiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : undefined,
      grantedScopes: perms.filter((p) => p.status === 'granted').map((p) => p.permission),
      businesses: businesses.map((b) => ({ id: b.id, name: b.name })),
      businessId,
      isActive: true,
    },
    { upsert: true, new: true },
  );
  return account;
}

export async function requireMainAccount() {
  const account = await MainAccount.findOne({ isActive: true }).select('+accessTokenEnc');
  if (!account) throw new HttpError(409, 'No main account connected. Connect Facebook on the Pages screen first.');
  return { account, token: decrypt(account.accessTokenEnc) };
}

export async function getMainAccountPublic() {
  const account = await MainAccount.findOne({ isActive: true }).lean();
  if (!account) return null;
  const pageCount = await Page.countDocuments({ mainAccountId: account._id, active: true });
  return {
    id: String(account._id),
    fbUserId: account.fbUserId,
    name: account.name,
    email: account.email,
    pictureUrl: account.pictureUrl,
    tokenExpiresAt: account.tokenExpiresAt,
    grantedScopes: account.grantedScopes,
    businesses: account.businesses ?? [],
    businessId: account.businessId,
    lastPagesSyncAt: account.lastPagesSyncAt,
    pageCount,
    connectedAt: (account as any).createdAt,
  };
}

export async function setBusiness(businessId: string) {
  const { account } = await requireMainAccount();
  if (!account.businesses?.some((b) => b.id === businessId)) throw new HttpError(400, 'Unknown business for this account');
  account.businessId = businessId;
  await account.save();
}

export async function disconnectMainAccount() {
  const account = await MainAccount.findOne({ isActive: true });
  if (!account) return;
  await Page.deleteMany({ mainAccountId: account._id });
  await account.deleteOne();
}
