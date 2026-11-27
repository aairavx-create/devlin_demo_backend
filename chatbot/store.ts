/**
 * Chatbot data store, kept in Postgres (table devlin.chatbot_state, one JSON row).
 * Ported from website-chatbot-dashboard/lib/db.ts, which used a JSON file.
 *
 * Every read-change-save runs in a transaction holding a row lock (SELECT ... FOR UPDATE),
 * so a slot check and its booking can't interleave with another request, even across servers.
 */
import crypto from 'crypto';
import type { TransactionSql } from 'postgres';
import { connectDB, sql } from '@/lib/db';
import { CONFIG } from './config';
import { todayYmd, workingDates } from './dates';
import type { Booking, Conversation, Customer, DB, Message, ServiceRequest, Slot } from './types';

const DB_VERSION = 2;
const DOC_ID = 'main';

export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
export const nowIso = () => new Date().toISOString();

function makeSlots(dates: string[]): Slot[] {
  return dates.flatMap((date) =>
    CONFIG.slotTimes.map((time) => ({
      id: `slot_${date}_${time.replace(':', '')}`,
      date,
      time,
      tz: CONFIG.timeZone,
      capacity: CONFIG.slotCapacity,
      blocked: false,
    })),
  );
}

/** Sample data so the dashboard isn't empty on first run. "Reset demo data" restores it. */
function seed(): DB {
  const db: DB = {
    version: DB_VERSION,
    rev: 1,
    customers: [],
    conversations: [],
    messages: [],
    slots: makeSlots(workingDates(CONFIG.workingDays)),
    bookings: [],
    requests: [],
    blockedDates: [],
  };
  const openDays = Array.from(new Set(db.slots.map((s) => s.date)));
  if (openDays[8]) db.blockedDates.push(openDays[8]);
  const oneSlot = db.slots.find((s) => s.date === openDays[3] && s.time === CONFIG.slotTimes.at(-1));
  if (oneSlot) oneSlot.blocked = true;
  const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

  const addChat = (c: Partial<Customer>, conv: Partial<Conversation>, lines: [Message['sender'], string][], minutes: number) => {
    const session = uid('sess');
    const customer: Customer = { id: uid('cus'), session_id: session, name: '', phone: '', address: '', consent: true, created_at: ago(minutes), ...c };
    const conversation: Conversation = {
      id: uid('conv'), session_id: session, customer_id: customer.id, state: 'DONE', temp: {},
      bot_paused: false, needs_staff: false, last_options: [], last_activity: ago(minutes - lines.length), created_at: ago(minutes), ...conv,
    };
    db.customers.push(customer);
    db.conversations.push(conversation);
    lines.forEach(([sender, text], i) =>
      db.messages.push({
        id: uid('msg'), client_msg_id: uid('seed'), conversation_id: conversation.id,
        direction: sender === 'customer' ? 'in' : 'out', sender, text, options: [], created_at: ago(minutes - i),
      }),
    );
    return { customer, conversation };
  };

  [
    { name: 'Emma Clarke', phone: '+44 7700 900111', address: '14 Elm Grove, Leicester LE6 0AB', slot: 1, min: 200 },
    { name: 'James Patel', phone: '+44 7700 900222', address: '3 Mill Lane, Tamworth B78 3AA', slot: 6, min: 90 },
  ].forEach((s, i) => {
    const { customer } = addChat(
      { name: s.name, phone: s.phone, address: s.address },
      {},
      [['customer', 'Request to Measure'], ['customer', 'Book directly'], ['bot', `Booked! Your measurement reference is BK-${1001 + i}.`]],
      s.min,
    );
    const booking: Booking = {
      id: `BK-${1001 + i}`, customer_id: customer.id, slot_id: db.slots[s.slot].id, service: 'measure',
      address: s.address, status: 'confirmed', created_at: ago(s.min - 3),
    };
    db.bookings.push(booking);
  });

  {
    const { customer, conversation } = addChat(
      { phone: '+44 7700 900333' },
      {},
      [
        ['customer', 'Talk to someone'],
        ['customer', 'Do you measure for stairs and landings as well?'],
        ['customer', 'Afternoon (12pm to 5pm)'],
        ['bot', 'Thanks, great chatting with you! We will call you back as per your scheduled request.'],
      ],
      60,
    );
    const req: ServiceRequest = {
      id: uid('req'), type: 'callback', customer_id: customer.id, conversation_id: conversation.id,
      message: 'Do you measure for stairs and landings as well?', phone: customer.phone,
      best_time: 'Afternoon (12pm to 5pm)', status: 'new', created_at: ago(57),
    };
    db.requests.push(req);
  }

  {
    const { customer, conversation } = addChat(
      { phone: '+44 7700 900444' },
      {},
      [
        ['customer', 'Flooring guidance'],
        ['customer', 'Which flooring is best for a kitchen with a dog? 07700 900444'],
        ['bot', 'Thanks! One of our reps will come back to you soon. Is there anything else?'],
      ],
      30,
    );
    db.requests.push({
      id: uid('req'), type: 'flooring_guidance', customer_id: customer.id, conversation_id: conversation.id,
      message: 'Which flooring is best for a kitchen with a dog?', phone: customer.phone, best_time: '', status: 'new', created_at: ago(28),
    });
  }

  addChat(
    { name: 'Sophie Turner', phone: '+44 7700 900555' },
    { state: 'MENU', bot_paused: true, needs_staff: true },
    [
      ['customer', 'Talk to staff'],
      ['bot', 'Connecting you to our team. Someone will reply here shortly. You can keep typing your question.'],
      ['customer', 'Can I change my measuring appointment to next week?'],
    ],
    8,
  );

  return db;
}

// ---------- Postgres persistence ----------
type Tx = TransactionSql;

/** Adds slot days as time moves on. Returns true when it added any. */
function topUpSlots(db: DB): boolean {
  const have = new Set(db.slots.map((s) => s.date));
  const fresh = makeSlots(workingDates(CONFIG.workingDays).filter((d) => !have.has(d)));
  db.slots.push(...fresh);
  return fresh.length > 0;
}

async function save(tx: Tx, db: DB) {
  await tx`update devlin.chatbot_state set db = ${tx.json(db as any)}, updated_at = now() where id = ${DOC_ID}`;
}

/** Loads the state with its row locked until the transaction ends; seeds it on first use. */
async function loadLocked(tx: Tx): Promise<DB> {
  const select = () => tx<{ db: DB }[]>`select db from devlin.chatbot_state where id = ${DOC_ID} for update`;
  let [row] = await select();
  if (!row) {
    await tx`insert into devlin.chatbot_state (id, db) values (${DOC_ID}, ${tx.json(seed() as any)}) on conflict (id) do nothing`;
    [row] = await select();
  }
  let db = row.db;
  let dirty = false;
  if (db.version !== DB_VERSION) {
    db = seed();
    dirty = true;
  }
  db.blockedDates ??= [];
  if (topUpSlots(db)) dirty = true;
  if (dirty) await save(tx, db);
  return db;
}

export async function getDb(): Promise<DB> {
  await connectDB();
  return sql.begin((tx) => loadLocked(tx));
}

/** Read, change and save in one locked step. */
export async function transact<T>(fn: (db: DB) => T): Promise<T> {
  await connectDB();
  return sql.begin(async (tx) => {
    const db = await loadLocked(tx);
    const result = fn(db);
    db.rev += 1;
    await save(tx, db);
    return result;
  }) as Promise<T>;
}

export async function resetDb(): Promise<void> {
  await connectDB();
  await sql.begin(async (tx) => {
    const old = await loadLocked(tx);
    const db = seed();
    db.rev = (old?.rev ?? 0) + 1;
    await save(tx, db);
  });
}

// ---------- Query helpers (pure, work on a loaded DB) ----------
export const findSlot = (db: DB, id: string) => db.slots.find((s) => s.id === id);

export const bookingsForSlot = (db: DB, slotId: string) => db.bookings.filter((b) => b.slot_id === slotId && b.status === 'confirmed');

export const isFree = (db: DB, slot: Slot | undefined): slot is Slot =>
  !!slot && !slot.blocked && !db.blockedDates.includes(slot.date) && slot.date > todayYmd() && bookingsForSlot(db, slot.id).length < slot.capacity;

export const freeSlots = (db: DB, date: string) => db.slots.filter((s) => s.date === date && isFree(db, s)).sort((a, b) => a.time.localeCompare(b.time));

export const datesWithFreeSlots = (db: DB) => Array.from(new Set(db.slots.filter((s) => isFree(db, s)).map((s) => s.date))).sort();
