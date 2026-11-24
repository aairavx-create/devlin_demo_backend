/**
 * Chatbot dashboard API (needs x-api-key, like the rest of the agent API).
 *   GET  /api/chatbot/admin            → inbox, requests, bookings, leads, slot calendar
 *   POST /api/chatbot/admin { action } → staff actions: takeover, handback, reply, cancelBooking,
 *                                        toggleSlot, blockDays, requestStatus, reset,
 *                                        createBooking { slotId, name, phone, address }, rescheduleBooking { id, slotId }
 */
import { NextRequest, NextResponse } from 'next/server';
import { loadAdminData } from '@/chatbot/admin';
import { digitsOf, isPhone, staffReply, staffTakeover } from '@/chatbot/bot';
import { todayYmd } from '@/chatbot/dates';
import { findSlot, isFree, nowIso, resetDb, transact, uid } from '@/chatbot/store';
import type { RequestStatus } from '@/chatbot/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await loadAdminData());
}

const STATUSES: RequestStatus[] = ['new', 'contacted', 'closed'];

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id : '';

  switch (body.action) {
    case 'takeover':
      await staffTakeover(id, true);
      break;
    case 'handback':
      await staffTakeover(id, false);
      break;
    case 'reply':
      await staffReply(id, typeof body.text === 'string' ? body.text : '');
      break;
    case 'cancelBooking':
      await transact((db) => {
        const b = db.bookings.find((x) => x.id === id);
        if (b) b.status = 'cancelled';
      });
      break;
    case 'toggleSlot':
      await transact((db) => {
        const s = db.slots.find((x) => x.id === id);
        if (s) s.blocked = !s.blocked;
      });
      break;
    case 'blockDays': {
      // Block or reopen whole days (a day, a week or any range). Dates are YYYY-MM-DD.
      const dates = Array.isArray(body.dates) ? body.dates.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
      if (!dates.length || dates.length > 400) return NextResponse.json({ error: 'Pick between 1 and 400 days.' }, { status: 400 });
      const block = body.blocked === true;
      const today = todayYmd();
      await transact((db) => {
        const set = new Set(db.blockedDates);
        for (const d of dates) {
          if (d <= today) continue; // past days can't change
          if (block) set.add(d);
          else set.delete(d);
        }
        db.blockedDates = Array.from(set).sort((a, b) => a.localeCompare(b));
        // Reopening a day also reopens any single slots that were blocked on it.
        if (!block) for (const s of db.slots) if (dates.includes(s.date)) s.blocked = false;
      });
      break;
    }
    case 'requestStatus': {
      const status = body.status as RequestStatus;
      if (!STATUSES.includes(status)) return NextResponse.json({ error: 'Bad status.' }, { status: 400 });
      await transact((db) => {
        const r = db.requests.find((x) => x.id === id);
        if (r) r.status = status;
      });
      break;
    }
    case 'createBooking': {
      // Staff books a visit for a customer (e.g. someone who phoned the store).
      const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
      const name = str(body.name, 80);
      const phone = str(body.phone, 30);
      const address = str(body.address, 200).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(', ');
      const slotId = str(body.slotId, 40);
      if (name.length < 2) return NextResponse.json({ error: 'Enter the customer name.' }, { status: 400 });
      if (!isPhone(phone)) return NextResponse.json({ error: 'Enter a valid phone number, e.g. +44 7700 900123.' }, { status: 400 });
      if (address.length < 8) return NextResponse.json({ error: 'Enter the full address, including postcode.' }, { status: 400 });
      const result = await transact((db) => {
        const slot = findSlot(db, slotId);
        if (!isFree(db, slot)) return { error: 'That slot is no longer free. Pick another time.' };
        let customer = db.customers.find((c) => c.phone && digitsOf(c.phone) === digitsOf(phone));
        if (!customer) {
          customer = { id: uid('cus'), session_id: '', name, phone, address, consent: true, created_at: nowIso() };
          db.customers.push(customer);
        }
        customer.name = name;
        customer.address = address;
        const ref = `BK-${1001 + db.bookings.length}`;
        db.bookings.push({ id: ref, customer_id: customer.id, slot_id: slot.id, service: 'measure', address, status: 'confirmed', source: 'staff', created_at: nowIso() });
        return { ref };
      });
      if ('error' in result) return NextResponse.json(result, { status: 409 });
      break;
    }
    case 'rescheduleBooking': {
      const slotId = typeof body.slotId === 'string' ? body.slotId : '';
      const result = await transact((db) => {
        const booking = db.bookings.find((b) => b.id === id && b.status === 'confirmed');
        if (!booking) return { error: 'Booking not found or already cancelled.' };
        const slot = findSlot(db, slotId);
        if (!isFree(db, slot)) return { error: 'That slot is no longer free. Pick another time.' };
        booking.slot_id = slot.id;
        return { ok: true };
      });
      if ('error' in result) return NextResponse.json(result, { status: 409 });
      break;
    }
    case 'reset':
      await resetDb();
      break;
    default:
      return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  }
  return NextResponse.json(await loadAdminData());
}
