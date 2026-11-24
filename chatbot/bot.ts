/**
 * Bot engine (server only). Called by POST /api/widget/chat.
 * Ported from website-chatbot-dashboard/lib/bot.ts; only storage calls became async.
 *
 * Main menu
 *  ├─ Request to Measure
 *  │    ├─ Talk to someone → request → (answer if possible) → phone → best time → confirmation
 *  │    └─ Book directly   → day → time → name → phone → address → confirm → booked
 *  ├─ Facilitation Services (note: independent fitters are separate businesses)
 *  │    ├─ Independent fitter referral → info → message + phone → confirmation
 *  │    └─ Flooring guidance           → message + phone → confirmation
 *  └─ Talk to staff → bot pauses, staff reply from the dashboard
 */
import { CALLBACK_TIMES, CONFIG, FAQ, MESSAGES as M } from './config';
import { datesWithFreeSlots, findSlot, freeSlots, getDb, isFree, nowIso, transact, uid } from './store';
import { fmtDate, fmtTime } from './dates';
import type { ContactDetails, Conversation, Customer, DB, MessageUi, Option, PublicThread, RequestType } from './types';

type Reply = { text: string; options: Option[]; ui?: MessageUi };
const R = (text: string, options: Option[] = [], ui?: MessageUi): Reply => ({ text, options, ...(ui ? { ui } : {}) });
const O = (id: string, label: string): Option => ({ id, label });

const BACK = [O('menu', 'Main menu')];
const MAIN_MENU = [O('measure', 'Request to Measure'), O('facilitation', 'Facilitation Services'), O('staff', 'Talk to staff')];
const MEASURE_MENU = [O('measure_book', 'Book directly'), O('measure_talk', 'Talk to someone'), ...BACK];
const FAC_MENU = [O('fac_fitter', 'Independent fitter referral'), O('fac_guidance', 'Flooring guidance'), ...BACK];
const AFTER_DONE = [O('measure', 'Request to Measure'), O('facilitation', 'Facilitation Services'), O('menu', 'Main menu')];

// ---------- helpers ----------
export const digitsOf = (s: string) => s.replace(/\D/g, '');
export const isPhone = (s: string) => /^\+?[\d\s()-]+$/.test(s.trim()) && digitsOf(s).length >= 8 && digitsOf(s).length <= 15;

/** Finds a phone number inside a longer message, e.g. "... call me on 07700 900123". */
function findPhone(text: string): { phone: string; rest: string } | null {
  const match = /\+?\d[\d\s()-]{6,18}\d/.exec(text);
  if (!match || !isPhone(match[0])) return null;
  const rest = text
    .replace(match[0], '')
    .trim()
    .replace(/(?:my )?(?:phone number|number|phone|mobile|tel)(?: is)?[:\s-]*$/i, '')
    .replace(/(?:call me|reach me|contact me)?(?: on| at)?[:\s-]*$/i, '')
    .replace(/[\s,;.-]+$/, '')
    .trim();
  return { phone: match[0].trim(), rest };
}

function faqAnswer(text: string): string | null {
  const t = text.toLowerCase();
  return FAQ.find(f => f.keys.some(k => t.includes(k)))?.answer ?? null;
}

const dateOptions = (db: DB) => datesWithFreeSlots(db).map(d => O(`date_${d}`, fmtDate(d)));
const slotOptions = (db: DB, date: string) => freeSlots(db, date).map(s => O(s.id, fmtTime(s.time)));

/** Bot message with a calendar: the widget turns the date options into a calendar (only free days clickable). */
const calendarReply = (db: DB, text: string): Reply => R(text, [...dateOptions(db), ...BACK], { type: 'calendar' });

/** Bot message with one form for name, phone and address. */
const detailsForm = (text: string, prefill?: Partial<ContactDetails>, errors?: Partial<Record<keyof ContactDetails, string>>): Reply =>
  R(text, BACK, { type: 'contact_form', ...(prefill ? { prefill } : {}), ...(errors ? { errors } : {}) });

const timesReply = (db: DB, date: string, text: string): Reply =>
  R(text, [...slotOptions(db, date), O('back_date', 'Change day'), ...BACK]);

// ---------- rate limit (per session and per IP, in memory) ----------
const g = globalThis as unknown as { __chatRate?: Map<string, number[]> };
const rate: Map<string, number[]> = (g.__chatRate ??= new Map<string, number[]>());
function limited(key: string, max: number): boolean {
  const now = Date.now();
  const recent = (rate.get(key) ?? []).filter(t => now - t < 60_000);
  recent.push(now);
  rate.set(key, recent);
  return recent.length > max;
}

// ---------- data helpers ----------
function newConversation(db: DB, sessionId: string): Conversation {
  const customer: Customer = { id: uid('cus'), session_id: sessionId, name: '', phone: '', address: '', consent: true, created_at: nowIso() };
  const conv: Conversation = {
    id: uid('conv'), session_id: sessionId, customer_id: customer.id, state: 'MENU', temp: {},
    bot_paused: false, needs_staff: false, last_options: [], last_activity: nowIso(), created_at: nowIso()
  };
  db.customers.push(customer);
  db.conversations.push(conv);
  return conv;
}

function pushReplies(db: DB, conv: Conversation, replies: Reply[], sender: 'bot' | 'staff' = 'bot') {
  for (const r of replies) {
    db.messages.push({
      id: uid('msg'), client_msg_id: uid('srv'), conversation_id: conv.id, direction: 'out',
      sender, text: r.text, options: r.options, ...(r.ui ? { ui: r.ui } : {}), created_at: nowIso()
    });
  }
  if (replies.length) conv.last_options = replies.at(-1)!.options;
}

/** Saves name/phone/address on the lead. Merges into an earlier lead with the same phone. */
function saveLead(db: DB, conv: Conversation): Customer {
  const t = conv.temp;
  let cust = db.customers.find(c => c.id === conv.customer_id);
  const existing = t.phone ? db.customers.find(c => c !== cust && c.phone && digitsOf(c.phone) === digitsOf(t.phone)) : undefined;
  if (existing) {
    if (cust && !cust.phone) db.customers.splice(db.customers.indexOf(cust), 1);
    cust = existing;
  }
  if (!cust) {
    cust = { id: uid('cus'), session_id: conv.session_id, name: '', phone: '', address: '', consent: true, created_at: nowIso() };
    db.customers.push(cust);
  }
  if (t.name) cust.name = t.name;
  if (t.phone) cust.phone = t.phone;
  if (t.address) cust.address = t.address;
  conv.customer_id = cust.id;
  return cust;
}

function addRequest(db: DB, conv: Conversation, type: RequestType) {
  const cust = saveLead(db, conv);
  db.requests.push({
    id: uid('req'), type, customer_id: cust.id, conversation_id: conv.id,
    message: conv.temp.message ?? '', phone: conv.temp.phone ?? cust.phone, best_time: conv.temp.bestTime ?? '',
    status: 'new', created_at: nowIso()
  });
}

function summary(db: DB, conv: Conversation): Reply {
  const t = conv.temp;
  const slot = findSlot(db, t.slotId)!;
  return R(
    `Please check your measurement booking:\n• ${fmtDate(slot.date)} at ${fmtTime(slot.time)}\n• ${t.name}, ${t.phone}\n• ${t.address}`,
    [O('confirm_yes', 'Confirm booking'), O('confirm_change', 'Change details'), O('confirm_redate', 'Change day or time'), ...BACK]
  );
}

/** After a time is picked: the details form, pre-filled for a returning customer. */
function askDetails(db: DB, conv: Conversation): Reply {
  const t = conv.temp;
  const cust = db.customers.find(c => c.id === conv.customer_id);
  const prefill = {
    name: t.name || cust?.name || '',
    phone: t.phone || cust?.phone || '',
    address: t.address || cust?.address || ''
  };
  conv.state = 'GET_DETAILS';
  return detailsForm(M.askDetails, prefill.name || prefill.phone || prefill.address ? prefill : undefined);
}

type DetailErrors = Partial<Record<keyof ContactDetails, string>>;

/** Checks the details form. Returns cleaned values, or the errors to show next to each field. */
function checkDetails(form: ContactDetails): { ok: ContactDetails } | { errors: DetailErrors; values: ContactDetails } {
  const values = {
    name: String(form.name ?? '').trim().slice(0, 80),
    phone: String(form.phone ?? '').trim().slice(0, 30),
    address: String(form.address ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join(', ')
      .slice(0, 200)
  };
  const errors: DetailErrors = {};
  if (values.name.length < 2) errors.name = M.badName;
  if (!isPhone(values.phone)) errors.phone = M.badPhone;
  if (values.address.length < 8) errors.address = M.badAddress;
  return Object.keys(errors).length ? { errors, values } : { ok: values };
}

// ---------- flow entry points ----------
function toMenu(conv: Conversation): Reply[] {
  conv.state = 'MENU';
  conv.temp = {};
  return [R(M.menu, MAIN_MENU)];
}

function toMeasure(conv: Conversation): Reply[] {
  conv.state = 'MEASURE_MENU';
  conv.temp = {};
  return [R(M.measureIntro, MEASURE_MENU)];
}

function toBooking(db: DB, conv: Conversation): Reply[] {
  conv.temp = {};
  if (!dateOptions(db).length) {
    conv.state = 'MEASURE_MENU';
    return [R(M.noSlots, MEASURE_MENU)];
  }
  conv.state = 'PICK_DATE';
  return [calendarReply(db, M.bookIntro)];
}

function toFacilitation(conv: Conversation): Reply[] {
  conv.state = 'FAC_MENU';
  conv.temp = {};
  return [R(M.facIntro, FAC_MENU)];
}

function toFacMessage(conv: Conversation, type: RequestType, text: string): Reply[] {
  conv.state = 'FAC_MESSAGE';
  conv.temp = { reqType: type };
  return [R(text, BACK)];
}

function toStaff(conv: Conversation): Reply[] {
  conv.bot_paused = true;
  conv.needs_staff = true;
  return [R(M.staff)];
}

// ---------- the state machine ----------
function step(db: DB, conv: Conversation, opt: string, text: string, form?: ContactDetails): Reply[] {
  const lower = text.toLowerCase();
  if (opt === 'menu' || lower === 'menu' || lower === 'restart') return toMenu(conv);
  const again = () => [R(M.pickOption, conv.last_options)];

  switch (conv.state) {
    case 'MENU':
    case 'DONE': {
      if (opt === 'measure' || (!opt && /measur|\bbook/i.test(text))) return toMeasure(conv);
      if (opt === 'facilitation' || (!opt && /\b(fitter|fitting|install|facilitat)/i.test(text))) return toFacilitation(conv);
      if (opt === 'staff' || (!opt && /\b(staff|human|person|agent|someone)\b/i.test(text))) return toStaff(conv);
      if (!opt && /\b(guidance|advice|advise|recommend)/i.test(text)) return toFacMessage(conv, 'flooring_guidance', M.guidanceAsk);
      return [R(text ? M.notUnderstood : M.menu, MAIN_MENU)];
    }

    // ----- Request to Measure -----
    case 'MEASURE_MENU': {
      if (opt === 'measure_book') return toBooking(db, conv);
      if (opt === 'measure_talk') {
        conv.state = 'MEASURE_REQUEST';
        return [R(M.measureTalk, BACK)];
      }
      return again();
    }

    case 'MEASURE_REQUEST': {
      if (opt || text.length < 3) return [R(M.badMessage, BACK)];
      conv.temp.message = text.slice(0, 1000);
      const answer = faqAnswer(text);
      if (answer) {
        conv.state = 'MEASURE_ANSWERED';
        return [R(`${answer}\n\n${M.stillWantCall}`, [O('cb_yes', 'Yes, schedule a call'), O('measure_book', 'Book directly'), O('cb_no', 'No, thanks')])];
      }
      const inline = findPhone(text);
      if (inline) {
        if (inline.rest.length >= 3) conv.temp.message = inline.rest.slice(0, 1000);
        conv.temp.phone = inline.phone;
        saveLead(db, conv);
        conv.state = 'CALLBACK_TIME';
        return [R(M.callbackTime, CALLBACK_TIMES)];
      }
      conv.state = 'CALLBACK_PHONE';
      return [R(M.callbackPhone)];
    }

    case 'MEASURE_ANSWERED': {
      if (opt === 'cb_yes') {
        conv.state = 'CALLBACK_PHONE';
        return [R(M.callbackPhone)];
      }
      if (opt === 'measure_book') return toBooking(db, conv);
      if (opt === 'cb_no') {
        conv.state = 'DONE';
        conv.temp = {};
        return [R(M.noCallNeeded, AFTER_DONE)];
      }
      return again();
    }

    case 'CALLBACK_PHONE': {
      if (!isPhone(text)) return [R(M.badPhone)];
      conv.temp.phone = text.trim();
      saveLead(db, conv); // lead saved now, even if they leave before choosing a time
      conv.state = 'CALLBACK_TIME';
      return [R(M.callbackTime, CALLBACK_TIMES)];
    }

    case 'CALLBACK_TIME': {
      const picked = CALLBACK_TIMES.find(t => t.id === opt);
      const bestTime = picked ? picked.label : text;
      if (!bestTime || bestTime.length < 2) return again();
      conv.temp.bestTime = bestTime.slice(0, 100);
      addRequest(db, conv, 'callback');
      conv.state = 'DONE';
      conv.temp = {};
      return [R(M.callbackDone, AFTER_DONE)];
    }

    // ----- Book directly -----
    case 'PICK_DATE': {
      const date = opt.startsWith('date_') ? opt.slice(5) : '';
      if (!date) return [calendarReply(db, M.pickAnotherDay)];
      if (!slotOptions(db, date).length) return [calendarReply(db, M.dayFull)];
      conv.temp.date = date;
      conv.state = 'PICK_SLOT';
      return [timesReply(db, date, `Free times on ${fmtDate(date)}:`)];
    }

    case 'PICK_SLOT': {
      if (opt === 'back_date') {
        conv.state = 'PICK_DATE';
        return [calendarReply(db, M.pickAnotherDay)];
      }
      const slot = findSlot(db, opt);
      if (!slot || slot.date !== conv.temp.date) return again();
      if (!isFree(db, slot)) return [timesReply(db, conv.temp.date, 'Sorry, that time was just taken. Please pick another.')];
      conv.temp.slotId = slot.id;
      if (conv.temp.name && conv.temp.phone && conv.temp.address) {
        conv.state = 'CONFIRM'; // picked a new day or time after giving details
        return [summary(db, conv)];
      }
      return [askDetails(db, conv)];
    }

    // Name, phone and address arrive together from the form.
    case 'GET_DETAILS': {
      if (!form) return [detailsForm(M.useForm, { name: conv.temp.name, phone: conv.temp.phone, address: conv.temp.address })];
      const checked = checkDetails(form);
      if ('errors' in checked) return [detailsForm(M.fixDetails, checked.values, checked.errors)];
      Object.assign(conv.temp, checked.ok);
      saveLead(db, conv); // lead saved now, even if they leave before confirming
      conv.state = 'CONFIRM';
      return [summary(db, conv)];
    }

    case 'CONFIRM': {
      if (opt === 'confirm_change') return [askDetails(db, conv)];
      if (opt === 'confirm_redate') {
        conv.state = 'PICK_DATE';
        return [calendarReply(db, M.pickAnotherDay)];
      }
      if (opt !== 'confirm_yes') return again();
      const slot = findSlot(db, conv.temp.slotId);
      // Check and book in the same transaction so two people can't take one slot.
      if (!isFree(db, slot)) {
        if (slotOptions(db, conv.temp.date).length) {
          conv.state = 'PICK_SLOT';
          return [timesReply(db, conv.temp.date, 'Sorry, someone booked that time a moment ago. Please pick another.')];
        }
        conv.state = 'PICK_DATE';
        return [calendarReply(db, 'Sorry, that day is now full. Please pick another day:')];
      }
      const cust = saveLead(db, conv);
      const ref = `BK-${1001 + db.bookings.length}`;
      db.bookings.push({
        id: ref, customer_id: cust.id, slot_id: slot.id, service: 'measure',
        address: conv.temp.address, status: 'confirmed', created_at: nowIso()
      });
      conv.state = 'DONE';
      conv.temp = {};
      return [R(`Booked! Your measurement reference is ${ref}.\n${fmtDate(slot.date)} at ${fmtTime(slot.time)}.\n${M.bookedReminder}`, AFTER_DONE)];
    }

    // ----- Facilitation Services -----
    case 'FAC_MENU': {
      if (opt === 'fac_fitter') {
        conv.state = 'FAC_FITTER';
        return [R(M.fitterInfo, [O('fac_fitter_go', 'Request a fitter referral'), O('fac_guidance', 'Flooring guidance'), ...BACK])];
      }
      if (opt === 'fac_guidance') return toFacMessage(conv, 'flooring_guidance', M.guidanceAsk);
      return again();
    }

    case 'FAC_FITTER': {
      if (opt === 'fac_fitter_go') return toFacMessage(conv, 'fitter_referral', M.fitterAsk);
      if (opt === 'fac_guidance') return toFacMessage(conv, 'flooring_guidance', M.guidanceAsk);
      return again();
    }

    case 'FAC_MESSAGE': {
      if (opt || text.length < 3) return [R(M.badMessage, BACK)];
      const inline = findPhone(text);
      conv.temp.message = (inline && inline.rest.length >= 3 ? inline.rest : text).slice(0, 1000);
      if (!inline) {
        conv.state = 'FAC_PHONE';
        return [R(M.askPhoneOnly)];
      }
      conv.temp.phone = inline.phone;
      return finishFacilitation(db, conv);
    }

    case 'FAC_PHONE': {
      if (!isPhone(text)) return [R(M.badPhone)];
      conv.temp.phone = text.trim();
      return finishFacilitation(db, conv);
    }

    default:
      return toMenu(conv);
  }
}

function finishFacilitation(db: DB, conv: Conversation): Reply[] {
  const type = (conv.temp.reqType as RequestType) || 'flooring_guidance';
  addRequest(db, conv, type);
  conv.state = 'DONE';
  conv.temp = {};
  return [R(type === 'fitter_referral' ? M.fitterDone : M.guidanceDone, AFTER_DONE)];
}

// ---------- public API ----------
export function publicThread(db: DB, sessionId: string): PublicThread {
  const conv = db.conversations.find(c => c.session_id === sessionId);
  return {
    rev: db.rev,
    conversation: conv ? { state: conv.state, bot_paused: conv.bot_paused } : null,
    messages: conv
      ? db.messages.filter(m => m.conversation_id === conv.id).map(({ id, sender, text, options, ui }) => ({ id, sender, text, options, ...(ui ? { ui } : {}) }))
      : []
  };
}

export async function getThread(sessionId: string): Promise<PublicThread> {
  return publicThread(await getDb(), sessionId);
}

export type ChatEntry = 'measure';

/**
 * Starts a chat (visitor ticked consent + captcha), or jumps an existing chat to a flow.
 * entry 'measure' = opened from the Request to Measure banner: skip the main menu
 * and open with the measurement greeting.
 */
export async function startChat(sessionId: string, entry?: ChatEntry): Promise<PublicThread> {
  await transact(db => {
    let conv = db.conversations.find(c => c.session_id === sessionId);
    if (!conv) {
      conv = newConversation(db, sessionId);
      if (entry !== 'measure') {
        pushReplies(db, conv, [R(M.greeting, MAIN_MENU)]);
        return;
      }
    } else if (entry !== 'measure' || conv.bot_paused || conv.state === 'MEASURE_MENU') {
      return; // nothing to change (staff are chatting, or already at the measuring question)
    }
    conv.state = 'MEASURE_MENU';
    conv.temp = {};
    conv.last_activity = nowIso();
    pushReplies(db, conv, [R(M.measureIntroBanner, MEASURE_MENU)]);
  });
  return getThread(sessionId);
}

export type ChatInput = { text?: string; optionId?: string; clientMsgId?: string; form?: ContactDetails };

export async function handleMessage(sessionId: string, input: ChatInput, ip: string): Promise<{ error: string } | PublicThread> {
  // Per IP allows more, since several customers can share one network (office, mobile carrier).
  if (limited(`s:${sessionId}`, CONFIG.rateLimitPerMin) || limited(`ip:${ip}`, CONFIG.rateLimitPerMin * 3)) return { error: 'Too many messages. Please wait a minute and try again.' };
  const text = String(input.text ?? '').trim().slice(0, 1000);
  const optionId = String(input.optionId ?? '');
  if (!text && !optionId) return { error: 'Empty message.' };

  await transact(db => {
    const conv = db.conversations.find(c => c.session_id === sessionId) ?? newConversation(db, sessionId);

    // Network retry sent the same message twice: keep only the first.
    if (input.clientMsgId && db.messages.some(m => m.client_msg_id === input.clientMsgId)) return;

    const idleMin = (Date.now() - Date.parse(conv.last_activity)) / 60_000;
    const expired = idleMin > CONFIG.sessionTimeoutMin && !['MENU', 'DONE'].includes(conv.state) && !conv.bot_paused;
    if (expired) {
      conv.state = 'MENU';
      conv.temp = {};
    }

    db.messages.push({
      id: uid('msg'), client_msg_id: input.clientMsgId || uid('cli'), conversation_id: conv.id,
      direction: 'in', sender: 'customer', text, options: [], created_at: nowIso()
    });
    conv.last_activity = nowIso();

    // Staff has taken over: save the message, the bot stays quiet.
    if (conv.bot_paused) {
      conv.needs_staff = true;
      return;
    }

    // Only accept button ids the bot actually offered; a typed label counts as pressing it.
    let opt = conv.last_options.some(o => o.id === optionId) || optionId === 'menu' ? optionId : '';
    if (!opt && text) opt = conv.last_options.find(o => o.label.toLowerCase() === text.toLowerCase())?.id ?? '';

    const replies = [...(expired ? [R(M.timedOut)] : []), ...step(db, conv, opt, opt ? '' : text, input.form)];
    pushReplies(db, conv, replies);
  });
  return getThread(sessionId);
}

// ---------- staff actions (dashboard) ----------
export async function staffTakeover(convId: string, paused: boolean) {
  await transact(db => {
    const conv = db.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.bot_paused = paused;
    if (!paused) {
      conv.needs_staff = false;
      conv.state = 'MENU';
      conv.temp = {};
      pushReplies(db, conv, [R(M.handBack, MAIN_MENU)]);
    }
  });
}

export async function staffReply(convId: string, text: string) {
  const clean = String(text ?? '').trim().slice(0, 1000);
  if (!clean) return;
  await transact(db => {
    const conv = db.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.bot_paused = true;
    conv.needs_staff = false;
    conv.last_activity = nowIso();
    pushReplies(db, conv, [R(clean)], 'staff');
  });
}
