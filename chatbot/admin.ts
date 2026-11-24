/** Builds what the Leads Management dashboard shows. Server only. */
import { CONFIG } from './config';
import { bookingsForSlot, findSlot, getDb } from './store';
import { fmtDate, fmtTime, todayYmd } from './dates';
import type { DB, RequestStatus, RequestType, Sender, State } from './types';

export interface AdminData {
  rev: number;
  kpis: { chats: number; leads: number; bookings: number; openRequests: number; waiting: number };
  conversations: {
    id: string;
    name: string;
    phone: string;
    address: string;
    state: State;
    bot_paused: boolean;
    needs_staff: boolean;
    last_activity: string;
    messages: { id: string; sender: Sender; text: string; created_at: string }[];
  }[];
  leads: { id: string; name: string; phone: string; address: string; status: 'Needs staff' | 'Booked' | 'Request' | 'New lead'; created_at: string }[];
  bookings: {
    id: string;
    name: string;
    phone: string;
    address: string;
    when: string;
    sortKey: string;
    slotId: string;
    date: string; // YYYY-MM-DD
    time: string; // HH:MM
    source: 'chat' | 'staff';
    status: 'confirmed' | 'cancelled';
    created_at: string;
  }[];
  requests: { id: string; type: RequestType; name: string; phone: string; message: string; best_time: string; status: RequestStatus; created_at: string }[];
  calendar: SlotCalendarData;
}

export interface SlotCalendarData {
  today: string; // YYYY-MM-DD in the business time zone
  bookableUntil: string; // last day customers can currently book
  closedWeekdays: number[]; // 0 = Sunday
  blockedDates: string[]; // whole days blocked by staff (may be beyond the booking window)
  /** Days that have measuring slots, keyed by date. */
  days: Record<
    string,
    {
      label: string;
      slots: { id: string; time: string; state: 'free' | 'blocked' | 'booked'; bookedBy: string[] }[];
    }
  >;
}

export async function loadAdminData(): Promise<AdminData> {
  return buildAdminData(await getDb());
}

export function buildAdminData(db: DB): AdminData {
  const customer = (id: string) => db.customers.find(c => c.id === id);
  const visitor = (id: string) => customer(id)?.name || 'Website visitor';

  const conversations = db.conversations
    .map(conv => {
      const c = customer(conv.customer_id);
      return {
        id: conv.id,
        name: c?.name || 'Website visitor',
        phone: c?.phone ?? '',
        address: c?.address ?? '',
        state: conv.state,
        bot_paused: conv.bot_paused,
        needs_staff: conv.needs_staff,
        last_activity: conv.last_activity,
        messages: db.messages
          .filter(m => m.conversation_id === conv.id)
          .map(({ id, sender, text, created_at }) => ({ id, sender, text, created_at }))
      };
    })
    .filter(c => c.messages.length)
    .sort((a, b) => Number(b.needs_staff) - Number(a.needs_staff) || b.last_activity.localeCompare(a.last_activity));

  const confirmed = db.bookings.filter(b => b.status === 'confirmed');

  const leads = db.customers
    .filter(c => c.phone)
    .map(c => {
      const conv = db.conversations.find(x => x.customer_id === c.id);
      const status: AdminData['leads'][number]['status'] = conv?.needs_staff
        ? 'Needs staff'
        : confirmed.some(b => b.customer_id === c.id)
          ? 'Booked'
          : db.requests.some(r => r.customer_id === c.id && r.status !== 'closed')
            ? 'Request'
            : 'New lead';
      return { id: c.id, name: c.name || '—', phone: c.phone, address: c.address, status, created_at: c.created_at };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const bookings = db.bookings
    .map(b => {
      const slot = findSlot(db, b.slot_id);
      const c = customer(b.customer_id);
      return {
        id: b.id,
        name: c?.name || '—',
        phone: c?.phone ?? '',
        address: b.address,
        when: slot ? `${fmtDate(slot.date)}, ${fmtTime(slot.time)}` : '—',
        sortKey: slot ? slot.date + slot.time : '',
        slotId: b.slot_id,
        date: slot?.date ?? '',
        time: slot?.time ?? '',
        source: b.source ?? 'chat',
        created_at: b.created_at,
        status: b.status
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const requests = db.requests
    .map(r => ({ id: r.id, type: r.type, name: visitor(r.customer_id), phone: r.phone, message: r.message, best_time: r.best_time, status: r.status, created_at: r.created_at }))
    .sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || b.created_at.localeCompare(a.created_at));

  const today = todayYmd();
  const days: SlotCalendarData['days'] = {};
  for (const slot of db.slots.filter(s => s.date > today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
    const day = (days[slot.date] ??= { label: fmtDate(slot.date), slots: [] });
    const booked = bookingsForSlot(db, slot.id);
    day.slots.push({
      id: slot.id,
      time: fmtTime(slot.time),
      state: booked.length ? 'booked' : slot.blocked || db.blockedDates.includes(slot.date) ? 'blocked' : 'free',
      bookedBy: booked.map(b => `${visitor(b.customer_id)} (${b.id})`)
    });
  }
  const slotDates = Object.keys(days).sort();

  return {
    rev: db.rev,
    kpis: {
      chats: conversations.filter(c => c.messages.some(m => m.sender === 'customer')).length,
      leads: leads.length,
      bookings: confirmed.length,
      openRequests: db.requests.filter(r => r.status === 'new').length,
      waiting: db.conversations.filter(c => c.needs_staff).length
    },
    conversations,
    leads,
    bookings,
    requests,
    calendar: {
      today,
      bookableUntil: slotDates.at(-1) ?? today,
      closedWeekdays: CONFIG.closedWeekdays,
      blockedDates: db.blockedDates.filter(d => d > today).sort(),
      days
    }
  };
}
