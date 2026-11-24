import { NextResponse } from 'next/server';
import { readJson, route } from '@/lib/http';
import { updateLead } from '@/services/leads';

export const dynamic = 'force-dynamic';

// PATCH /api/leads/:id  { status?: "WORKING", followUp?: { at: ISO, type: "CALL"|"WHATSAPP"|"EMAIL"|"VISIT", notes? } | null }
export const PATCH = route<{ params: { id: string } }>(async (req, { params }) =>
  NextResponse.json({ lead: await updateLead(params.id, await readJson(req)) }),
);
