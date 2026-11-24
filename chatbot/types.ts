export type Sender = 'customer' | 'bot' | 'staff';

export interface Option {
  id: string;
  label: string;
}

export interface ContactDetails {
  name: string;
  phone: string;
  address: string;
}

/** Extra UI the widget shows under a bot message (instead of plain buttons). */
export type MessageUi =
  | { type: 'calendar' } // the date options become a calendar; only those days can be picked
  | { type: 'contact_form'; prefill?: Partial<ContactDetails>; errors?: Partial<Record<keyof ContactDetails, string>> };

export interface Message {
  ui?: MessageUi;
  id: string;
  client_msg_id: string; // unique: stops a retried message being saved twice
  conversation_id: string;
  direction: 'in' | 'out';
  sender: Sender;
  text: string;
  options: Option[];
  created_at: string;
}

export interface Customer {
  id: string;
  session_id: string;
  name: string;
  phone: string;
  address: string;
  consent: boolean;
  created_at: string;
}

export type State =
  | 'MENU'
  // Request to Measure
  | 'MEASURE_MENU'
  | 'MEASURE_REQUEST'
  | 'MEASURE_ANSWERED'
  | 'CALLBACK_PHONE'
  | 'CALLBACK_TIME'
  // Book directly
  | 'PICK_DATE'
  | 'PICK_SLOT'
  | 'GET_DETAILS'
  | 'CONFIRM'
  // Facilitation Services
  | 'FAC_MENU'
  | 'FAC_FITTER'
  | 'FAC_MESSAGE'
  | 'FAC_PHONE'
  | 'DONE';

export interface Conversation {
  id: string;
  session_id: string;
  customer_id: string;
  state: State;
  temp: Record<string, string>;
  bot_paused: boolean;
  needs_staff: boolean;
  last_options: Option[];
  last_activity: string;
  created_at: string;
}

export interface Slot {
  id: string;
  date: string; // YYYY-MM-DD in the business time zone
  time: string; // HH:MM
  tz: string;
  capacity: number;
  blocked: boolean;
}

export interface Booking {
  id: string;
  customer_id: string;
  slot_id: string;
  service: 'measure';
  address: string;
  status: 'confirmed' | 'cancelled';
  source?: 'chat' | 'staff'; // staff = booked from the dashboard
  created_at: string;
}

export type RequestType = 'callback' | 'fitter_referral' | 'flooring_guidance';
export type RequestStatus = 'new' | 'contacted' | 'closed';

export interface ServiceRequest {
  id: string;
  type: RequestType;
  customer_id: string;
  conversation_id: string;
  message: string;
  phone: string;
  best_time: string;
  status: RequestStatus;
  created_at: string;
}

export interface DB {
  version: number;
  rev: number; // bumps on every change so clients can skip re-rendering
  customers: Customer[];
  conversations: Conversation[];
  messages: Message[];
  slots: Slot[];
  bookings: Booking[];
  requests: ServiceRequest[];
  blockedDates: string[]; // whole days closed by staff (holidays, staff off), YYYY-MM-DD
}

/** What the chat widget receives: only this visitor's own chat. */
export interface PublicThread {
  rev: number;
  conversation: { state: State; bot_paused: boolean } | null;
  messages: Pick<Message, 'id' | 'sender' | 'text' | 'options' | 'ui'>[];
}
