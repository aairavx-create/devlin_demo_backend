import { decrypt, encrypt } from '@/lib/crypto';
import { sql } from '@/lib/db';
import { env } from '@/lib/env';
import { graph, graphAll } from '@/lib/graph';
import { HttpError } from '@/lib/http';
import type { MainAccountRow } from '@/models/types';

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

  return sql.begin(async (tx) => {
    const [existing] = await tx<{ businessId: string | null }[]>`
      select business_id from devlin.main_accounts where fb_user_id = ${me.id}`;
    const businessId =
      existing?.businessId && businesses.some((b) => b.id === existing.businessId) ? existing.businessId : businesses[0]?.id ?? null;

    // Only one main account is active at a time.
    await tx`update devlin.main_accounts set is_active = false, updated_at = now() where fb_user_id <> ${me.id}`;
    const row = {
      fbUserId: me.id,
      name: me.name,
      email: me.email ?? null,
      pictureUrl: me.picture?.data?.url ?? null,
      accessTokenEnc: encrypt(token),
      tokenExpiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
      grantedScopes: perms.filter((p) => p.status === 'granted').map((p) => p.permission),
      businesses: tx.json(businesses.map((b) => ({ id: b.id, name: b.name }))),
      businessId,
      isActive: true,
    };
    const [account] = await tx<MainAccountRow[]>`
      insert into devlin.main_accounts ${tx(row)}
      on conflict (fb_user_id) do update set
        name = excluded.name, email = excluded.email, picture_url = excluded.picture_url,
        access_token_enc = excluded.access_token_enc, token_expires_at = excluded.token_expires_at,
        granted_scopes = excluded.granted_scopes, businesses = excluded.businesses,
        business_id = excluded.business_id, is_active = true, updated_at = now()
      returning *`;
    return account;
  });
}

export async function requireMainAccount() {
  const [account] = await sql<MainAccountRow[]>`
    select * from devlin.main_accounts where is_active order by updated_at desc limit 1`;
  if (!account) throw new HttpError(409, 'No main account connected. Connect Facebook on the Pages screen first.');
  return { account, token: decrypt(account.accessTokenEnc) };
}

export async function getMainAccountPublic() {
  const [account] = await sql<(MainAccountRow & { pageCount: number })[]>`
    select a.*, (select count(*)::int from devlin.pages p where p.main_account_id = a.id and p.active) as page_count
    from devlin.main_accounts a where a.is_active order by a.updated_at desc limit 1`;
  if (!account) return null;
  return {
    id: account.id,
    fbUserId: account.fbUserId,
    name: account.name,
    email: account.email,
    pictureUrl: account.pictureUrl,
    tokenExpiresAt: account.tokenExpiresAt,
    grantedScopes: account.grantedScopes,
    businesses: account.businesses ?? [],
    businessId: account.businessId,
    lastPagesSyncAt: account.lastPagesSyncAt,
    pageCount: account.pageCount,
    connectedAt: account.createdAt,
  };
}

export async function setBusiness(businessId: string) {
  const { account } = await requireMainAccount();
  if (!account.businesses?.some((b) => b.id === businessId)) throw new HttpError(400, 'Unknown business for this account');
  await sql`update devlin.main_accounts set business_id = ${businessId}, updated_at = now() where id = ${account.id}`;
}

export async function disconnectMainAccount() {
  // Its pages go with it (on delete cascade). Leads and access-request history are kept.
  await sql`delete from devlin.main_accounts where is_active`;
}
