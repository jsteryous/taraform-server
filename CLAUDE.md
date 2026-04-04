# Taraform Server

## What this is
Express.js backend for Taraform CRM. Handles SMS (Twilio), email (Microsoft Graph API or Gmail API),
email verification (Reoon), and AI intent detection (Claude). Deployed on Railway.

## Stack
- Node.js + Express
- Supabase JS client (server-side)
- BullMQ + Redis for email job queue
- googleapis (Gmail API — send + inbox polling)
- Sentry (@sentry/node) for error monitoring
- Deployed on Railway (auto-deploys from main branch of taraform-server repo)
- No TypeScript — plain JS throughout

## Project structure
```
index.js              — mounts routes, starts schedulers, initializes Sentry
api.js                — all API routes (/api/*)
auth.js               — OAuth callbacks (/auth/microsoft/callback, /auth/google/callback)
email.js              — send (Graph API or Gmail API), token management, OAuth helpers, renderEmailTemplate
email-scheduler.js    — 4-touch follow-up, reply detection via Outlook or Gmail inbox poll
email-worker.js       — BullMQ worker that processes email jobs from the queue
queues.js             — BullMQ queue definitions (emailQueue, etc.)
bull-board.js         — Bull Board admin dashboard setup (/admin/queues)
reoon.js              — bulk email verification submit/poll/update
scheduler.js          — SMS scheduler (cron, per-client Eastern time windows)
sms.js                — Twilio send helpers
webhook.js            — Twilio incoming SMS webhook
followup.js           — SMS follow-up logic
ai.js                 — Claude intent detection
supabase.js           — Supabase client singleton
```

## Key env vars (set in Railway dashboard)
```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER=+18644775752
ANTHROPIC_API_KEY
SUPABASE_URL=https://ykuenmwfxecmmqichwit.supabase.co
SUPABASE_SERVICE_KEY
MS_CLIENT_ID=f50ae523-287e-49b4-b8a2-fbe84aab2e28
MS_TENANT_ID=742b7e37-645a-4307-bb22-525f452389a3
MS_CLIENT_SECRET
MS_REDIRECT_URI=https://taraform-server-production.up.railway.app/auth/microsoft/callback
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=https://taraform-server-production.up.railway.app/auth/google/callback
REOON_API_KEY
REDIS_URL
BULL_BOARD_PASSWORD
SENTRY_DSN
```

## API routes
All routes are under `/api/*` (mounted in index.js).
Auth callbacks: `/auth/microsoft/callback` and `/auth/google/callback` (no /api prefix).

Key routes:
- GET  /api/stats?client_id&period          — SMS + offer stats
- GET  /api/email/stats?client_id&period    — email stats
- GET  /api/email/gmail-auth-url?client_id  — get Google OAuth URL (uses googleapis)
- GET  /api/email/auth-url?client_id&provider=outlook|gmail — generic OAuth URL
- GET  /api/email/status?client_id          — { connected, email, provider: 'gmail'|'outlook'|null }
- DELETE /api/email/disconnect?client_id    — remove connected account
- POST /api/email/send-one                  — manual single send
- POST /api/email/send-batch                — bulk manual send
- POST /api/email/verify-start              — start Reoon verification job
- GET  /api/email/verify-status             — poll job progress
- POST /api/email/verify-reprocess          — re-apply results from existing task
- DELETE /api/email/verify-reset            — clear stuck job state
- GET  /admin/queues                        — Bull Board dashboard (password protected)

Other client routes:
- PUT    /api/clients/:id                   — update client (name, twilio_number, config, custom_field_definitions)
- DELETE /api/clients/:id                   — delete client

Multi-tenancy (client_users) routes — all require Authorization: Bearer <supabase_jwt>:
- GET    /api/clients                       — returns only clients the caller belongs to ([] if no token)
- POST   /api/clients                       — creates client + inserts owner row in client_users
- GET    /api/clients/:id/users             — list members (caller must be a member)
- POST   /api/clients/:id/users             — add user by email as 'member' (caller must be a member)
- DELETE /api/clients/:id/users/:userId     — remove member (caller must be 'owner')

## Schedulers
Both schedulers run via node-cron and check Eastern time (America/New_York) — NOT server local time.

**SMS scheduler (scheduler.js):** runs every 10 min, sends within per-client configured windows.
**Email scheduler (email-scheduler.js):** runs every 15 min, 8:30AM-5:30PM Eastern, Mon-Fri.
  Flow: 1) check inbox for replies (Outlook via Graph API, Gmail via googleapis) → cancel follow-ups
        2) enqueue due follow-ups from email_followup_queue → BullMQ processes them via email-worker.js
        3) send Touch 1 to new verified contacts up to daily limit
  Sending and reply detection branch on email_tokens.provider ('outlook' | 'gmail') per client.

## Email verification (Reoon)
- Bulk API endpoint: POST /create-bulk-verification-task/
- Results endpoint: GET /get-result-bulk-verification-task/?key=&task_id=&task-id=
- Results come back as object keyed by email (not array) — normalize with Object.values()
- mapStatus() reads boolean fields (is_safe_to_send, is_deliverable, etc.) not a status string
- email_status values: eligible → verified | do_not_email | unknown
- unknown = tried but unverifiable (Yahoo/AT&T/AOL) — don't retry

## Email templates
renderEmailTemplate() variables:
{{firstName}} {{lastName}} {{fullName}} {{county}} {{acreage}}
{{propertyAddress}} {{propertyStreet}} {{ownerAddress}} {{ownerStreet}} {{taxMapId}}

## Auth
Routes that need the caller's identity extract the Supabase JWT via `getUserFromReq(req)` in api.js.
This calls `supabase.auth.getUser(token)` using the service key client — no separate auth library needed.
CORS allows `Authorization` header (index.js) so browser preflight passes.

## Database
Supabase. Uses snake_case column names.
Job state (Reoon, etc.) stored in sms_settings table as key/value JSON.
Offers stored as JSONB array on property_crm_contacts.offers — known limitation, plan to migrate to own table.
email_followup_queue status values: queued | pending | sent | failed | skipped | cancelled
email_tokens(client_id, access_token, refresh_token, expires_at, email, provider, updated_at) — provider: 'gmail' | 'outlook'; one row per client
client_users(id, client_id, user_id, role, created_at) — junction table for multi-tenancy; role: 'owner' | 'member'

## Required DB migration (run once in Supabase)
```sql
ALTER TABLE email_tokens ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'outlook';
```

## Code style
- No TypeScript — plain JS
- Async/await throughout, no callbacks
- Always check for Supabase errors before using .data
- Use .maybeSingle() (not .single()) when a row may not exist — .single() throws a 406 error on no rows
- Log meaningful messages for scheduler actions: [ClientName] Touch 1 → Contact Name
- module.exports = router must be at the END of api.js (after all routes)

## Known architectural limitations (future work)
- SMS cron jobs should be migrated to BullMQ + Redis (email queue already uses BullMQ)
- Offers should be their own table, not JSONB
- Need rate limiting per client
- Business hours check relies on toLocaleString timezone conversion — works but fragile
