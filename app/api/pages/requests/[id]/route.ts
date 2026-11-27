import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/db';
import { HttpError, route } from '@/lib/http';
import { deleteAccessRequest } from '@/services/pages';

export const dynamic = 'force-dynamic';

// Removes the local record only. To withdraw the request on Meta's side, remove it in Business Settings.
export const DELETE = route<{ params: { id: string } }>(async (_req, { params }) => {
  if (!isUuid(params.id)) throw new HttpError(400, 'Invalid id');
  await deleteAccessRequest(params.id);
  return NextResponse.json({ ok: true });
});
