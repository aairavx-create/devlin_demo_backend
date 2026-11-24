import { NextResponse } from 'next/server';
import { isValidObjectId } from 'mongoose';
import { HttpError, route } from '@/lib/http';
import { PageAccessRequest } from '@/models/PageAccessRequest';

export const dynamic = 'force-dynamic';

// Removes the local record only. To withdraw the request on Meta's side, remove it in Business Settings.
export const DELETE = route<{ params: { id: string } }>(async (_req, { params }) => {
  if (!isValidObjectId(params.id)) throw new HttpError(400, 'Invalid id');
  await PageAccessRequest.deleteOne({ _id: params.id });
  return NextResponse.json({ ok: true });
});
