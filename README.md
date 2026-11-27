# meta-agent

A standalone Next.js backend (API only) that connects one **main Facebook account**, finds every Page linked to it, and serves:

- Facebook posts and reels, plus Instagram posts and reels, with likes, comments, shares, saves and reach
- Ads with spend, impressions, reach, clicks, CTR, CPC and leads
- Instant-form leads (Facebook and Instagram), saved to Postgres by sync and by webhook

Tokens (main account + every page) are **AES-256-GCM encrypted** in Postgres and never returned by the API.

The UI lives in `../meta-dashboard`.

## Run locally

```bash
npm install
# fill META_APP_ID and META_APP_SECRET in .env.local (the other values are already generated)
npm run dev          # http://localhost:4000
```

Postgres: set `DATABASE_URL` (Supabase works). Tables are created on first request in the `devlin` schema: `main_accounts`, `pages`, `page_access_requests`, `leads`, `chatbot_state` (see `lib/db.ts`).

## Meta app setup (one time)

1. developers.facebook.com → **Create app** → type **Business**.
2. Add products: **Facebook Login for Business**, **Marketing API**, **Webhooks**, **Instagram Graph API**.
3. Facebook Login → Settings → **Valid OAuth Redirect URIs**: `http://localhost:4000/api/auth/facebook/callback`
4. Copy App ID / App Secret into `.env.local`.
5. Permissions used (`META_SCOPES`): `pages_show_list, pages_read_engagement, pages_read_user_content, pages_manage_metadata, pages_manage_ads, read_insights, instagram_basic, instagram_manage_insights, ads_read, leads_retrieval, business_management`.
   While the app is in Development mode these work for app admins/testers without App Review. Other people's Pages need Advanced Access (App Review).
   If you use a Facebook Login for Business **configuration**, put its ID in `META_LOGIN_CONFIG_ID` and the scopes list is ignored.
6. **Lead webhooks** (optional, recommended): Webhooks → *Page* object → callback `https://<public-url>/api/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`, subscribe to `leadgen`.
   Locally you need a tunnel (e.g. `ngrok http 4000`). Then click **Subscribe** next to each page on the dashboard's Linked pages screen.
   Also check *Leads Access Manager* in Business Settings isn't blocking the app.

## How linking works

| Relationship | Where it comes from |
|---|---|
| `personal` | `GET /me/accounts`: Pages your profile has a role on |
| `owned` | `GET /{business}/owned_pages` |
| `client` | `GET /{business}/client_pages`: Pages other owners shared with your business |

**Requesting access to someone else's Page** (needs a Business portfolio + `business_management`):
1. Dashboard → Linked pages → *Request access*: calls `POST /{business}/client_pages` with `page_id` + `permitted_tasks`.
2. The Page admin accepts it in **Meta Business Suite → Settings → Requests** (or the Page's access settings).
3. *Check status* (or *Sync pages*) sees the page under `client_pages`, tries to assign you to it (`POST /{page}/assigned_users`) and stores its page token.
   If that automatic step fails, assign yourself in Business Settings → Accounts → Pages, then sync again.

## API

Every route except `/api/health`, `/api/auth/facebook/*` and `/api/webhooks/*` needs the header `x-api-key: $AGENT_API_KEY`.

| Method | Route | Notes |
|---|---|---|
| GET | `/api/health` | Database status |
| GET | `/api/auth/facebook/login` | Browser redirect to Facebook |
| GET | `/api/auth/facebook/callback` | Saves long-lived token, syncs pages, redirects to dashboard |
| GET / PATCH / DELETE | `/api/account` | Main account info / `{businessId}` / disconnect |
| GET | `/api/pages` | Linked pages (no tokens) |
| POST | `/api/pages/sync` | Re-read pages + page tokens from Meta |
| POST | `/api/pages/:pageId/subscribe` | Install app on page for `leadgen` webhooks |
| GET | `/api/pages/requests?refresh=1` | Access requests (refresh re-checks Meta and stores tokens of accepted pages) |
| POST | `/api/pages/requests` | `{ page: "<id or url>", tasks: ["ADVERTISE","ANALYZE"], note? }` |
| DELETE | `/api/pages/requests/:id` | Remove local record |
| GET | `/api/content` | `pageId=all\|<id>&platform=all\|facebook\|instagram&type=all\|post\|reel&limit=12&cursor=&insights=1` |
| GET | `/api/ads/accounts` | Ad accounts |
| GET | `/api/ads` | `adAccountId=act_..&datePreset=last_30d&status=ACTIVE&after=` |
| GET | `/api/leads` | From Postgres: `status` (ALL, NEW, WORKING, UNQUALIFIED, QUALIFIED, CLOSE, INVALID), `pageId, formId, search, fetchStatus, from, to, page, pageSize`. Returns `statusCounts` for the tabs |
| PATCH | `/api/leads/:id` | `{ status?, followUp?: { at, type: CALL\|WHATSAPP\|EMAIL\|VISIT, notes } \| null }`. Staff fields; Meta sync never overwrites them |
| POST | `/api/leads/sync` | `{ pageId?, full? }`: incremental pull from every form; also retries failed webhook leads |
| GET | `/api/leads/forms?pageId=` | Live list of instant forms |
| GET/POST | `/api/webhooks/meta` | Meta handshake + signed `leadgen` pings |

Run `POST /api/leads/sync` on a schedule (e.g. daily cron) to catch any missed webhook ping. Meta may delete leads after 90 days.

## Notes

- The long-lived user token lasts ~60 days. The dashboard shows the expiry; click **Reconnect** to renew. Page tokens taken from it don't expire.
- `TOKEN_ENCRYPTION_KEY` must never change once tokens are stored (they'd become unreadable; reconnect to recover).
- `AGENT_API_KEY` is shipped to the browser via the dashboard's env, which is fine locally. Before deploying, put real user auth in front of the dashboard.

## Website chatbot

Ported from `website-chatbot-dashboard`. Data is stored in Postgres (table `devlin.chatbot_state`, one JSON row).

| Path | What it does |
|---|---|
| `chatbot/config.ts` | **Edit this first.** Business name, time zone, slot times, every bot message, call-back times, sample FAQ |
| `chatbot/bot.ts` | Bot engine: menu flows, validation, slot check, staff takeover |
| `chatbot/store.ts` | Postgres storage; each change locks the row (`SELECT ... FOR UPDATE`) so two chats can't book the same slot, even across servers |
| `chatbot/admin.ts` | Builds the dashboard data |

| Method | Route | Notes |
|---|---|---|
| GET/POST | `/api/widget/chat` | **Public** (no API key) chat API for the website widget. Allowed origins come from `CORS_ORIGINS` |
| GET/POST | `/api/chatbot/admin` | Dashboard data and staff actions (`takeover`, `handback`, `reply`, `cancelBooking`, `toggleSlot`, `blockDays`, `requestStatus`, `reset`). Needs `x-api-key` |

The widget lives in `meta-dashboard/src/chatbot/` (copy that folder into any React project), and the staff dashboard in `meta-dashboard/src/chatbot-admin/`.
