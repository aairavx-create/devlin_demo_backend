/**
 * Business settings and every message the bot sends.
 * Edit this file to change wording, opening days or slot times.
 */
export const CONFIG = {
  businessName: 'Devlin Carpets & Flooring',
  locale: 'en-GB',
  timeZone: 'Europe/London',
  slotTimes: ['09:00', '11:00', '14:00', '16:00'],
  workingDays: 21, // how many working days ahead customers can book on the calendar
  closedWeekdays: [0], // 0 = Sunday
  slotCapacity: 1, // measuring visits per slot
  sessionTimeoutMin: 30, // idle minutes before a half-finished chat restarts
  rateLimitPerMin: 20 // messages per session (and per IP) per minute
};

export const CALLBACK_TIMES = [
  { id: 'time_morning', label: 'Morning (9am to 12pm)' },
  { id: 'time_afternoon', label: 'Afternoon (12pm to 5pm)' },
  { id: 'time_evening', label: 'Evening (5pm to 7pm)' }
];

export const MESSAGES = {
  greeting: `Hi! Welcome to ${CONFIG.businessName}. How can we help you today?\n\nType "menu" at any time to start over.`,
  menu: 'How can we help you today?',
  notUnderstood: "Sorry, I didn't understand that. Please choose an option below.",
  pickOption: 'Please choose one of the options below, or type "menu" to start over.',
  timedOut: 'Your previous chat timed out, so we started again.',

  // Request to Measure
  // Shown when the customer picks Request to Measure inside the chat (already greeted).
  measureIntro:
    'How can we help you with our measurement service?\n\nWould you like to book directly with our automated system, or talk to someone before booking?',
  // Shown when the chat is opened from the Request to Measure banner button (first thing they see).
  measureIntroBanner:
    'Hi, how can we help you with our measurement service?\n\nWould you like to book directly with our automated system, or talk to someone before booking?',
  measureTalk:
    'Great, please state your request. If possible, I can answer it, or I can help you schedule a call with someone from our store.',
  stillWantCall: 'Would you still like a call back from our store?',
  noCallNeeded: 'Glad I could help! Is there anything else?',
  callbackPhone: 'What is the best phone number to call you back on?',
  callbackTime: 'And what is the best time to call you back?',
  callbackDone: 'Thanks, great chatting with you! We will call you back as per your scheduled request.',

  // Book directly
  bookIntro: "Let's book your measurement visit. Pick a day on the calendar:",
  pickAnotherDay: 'Pick another day on the calendar:',
  dayFull: 'Sorry, that day just filled up. Please pick another day:',
  noSlots: 'Sorry, there are no free measuring slots in the next few weeks. Choose Talk to someone and we will find a time.',
  askDetails: 'Great. Please fill in your details for the visit:',
  fixDetails: 'Please check the highlighted details:',
  useForm: 'Please fill in your details using the form below.',
  bookedReminder: 'We will send a reminder 24 hours before the visit.',

  // Facilitation Services
  facIntro: 'Please note: independent fitters operate as separate businesses.\n\nWhich service would you like?',
  fitterInfo:
    'Hi, we can help refer you to independent fitters. Any installation services are arranged directly between you and the fitter, although we are happy to help facilitate communication if needed.',
  fitterAsk: 'Please leave your message (what needs fitting and roughly when) and your phone number, and we will share fitter details.',
  fitterDone: 'Thanks! We will be in touch with independent fitter details. Is there anything else?',
  guidanceAsk:
    'Hi, thanks for opting for this service. Please leave your message and your phone number, and one of our reps will come back to you.',
  guidanceDone: 'Thanks! One of our reps will come back to you soon. Is there anything else?',
  askPhoneOnly: 'Thanks. What phone number should we use?',

  // Staff
  staff: 'Connecting you to our team. Someone will reply here shortly. You can keep typing your question.',
  handBack: "You're back with the assistant. How can we help?",

  // Validation
  badName: 'Please enter your name.',
  badPhone: 'That number looks wrong. Please type it with the country code, for example +44 7700 900123.',
  badAddress: 'Please enter the full address, including postcode.',
  badMessage: 'Please type a short message so our team knows how to help.'
};

/**
 * SAMPLE answers used when a customer asks something under "Talk to someone".
 * Replace them with your store's real answers (or plug in an AI model later).
 */
export const FAQ = [
  {
    keys: ['how long', 'duration', 'take long', 'minutes'],
    answer: 'A measurement visit usually takes 30 to 60 minutes, depending on the number of rooms.'
  },
  {
    keys: ['prepare', 'furniture', 'ready', 'clear the'],
    answer: "Please make sure we can reach each room. You don't need to move furniture before the visit."
  },
  {
    keys: ['area', 'postcode', 'cover', 'come to', 'travel'],
    answer: 'We measure within our local area. Share your postcode when booking and we will confirm.'
  },
  {
    keys: ['cost', 'price', 'charge', 'fee', 'free', 'how much'],
    answer: 'Our team will confirm any measuring charge for your area when they call or book you in.'
  }
];
