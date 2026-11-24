import { NextResponse } from 'next/server';
import { HttpError, readJson, route } from '@/lib/http';
import { disconnectMainAccount, getMainAccountPublic, setBusiness } from '@/services/account';

export const dynamic = 'force-dynamic';

export const GET = route(async () => NextResponse.json({ account: await getMainAccountPublic() }));

// Body: { businessId }: the Business portfolio used for client pages and access requests
export const PATCH = route(async (req) => {
  const body = await readJson<{ businessId?: string }>(req);
  if (!body.businessId) throw new HttpError(400, 'businessId is required');
  await setBusiness(body.businessId);
  return NextResponse.json({ account: await getMainAccountPublic() });
});

// Removes the main account and its stored page tokens (leads are kept).
export const DELETE = route(async () => {
  await disconnectMainAccount();
  return NextResponse.json({ ok: true });
});
