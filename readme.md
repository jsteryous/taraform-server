# Taraform SMS Engine

Backend server for Taraform CRM — handles outbound SMS drip, inbound reply processing, AI categorization, and lead alerts.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.template .env
```
Then open `.env` and fill in all values.

### 3. Run locally
```bash
npm run dev
```
Server starts on http://localhost:3000

### 4. Test health check
```bash
curl http://localhost:3000/
```

---

## Deploy to Railway

1. Push this `server/` folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repo
4. Go to Variables tab → add all keys from your `.env` file
5. Railway auto-detects Node.js and runs `npm start`
6. Copy your Railway public URL (e.g. `https://taraform-server.railway.app`)

### Set Twilio webhook
In Twilio Console → Phone Numbers → your number → Messaging:
- Set "A message comes in" → Webhook → `https://your-railway-url.railway.app/webhook/sms`
- Method: HTTP POST

---

## File Overview

| File | Purpose |
|------|---------|
| `index.js` | Express server entry point |
| `supabase.js` | Supabase client |
| `sms.js` | Twilio send + alert functions |
| `ai.js` | Claude reply categorization |
| `webhook.js` | Receives inbound SMS from Twilio |
| `scheduler.js` | Daily 50-text drip (runs every 10min during business hours) |
| `followup.js` | 7/30/180-day follow-up queue logic |
| `api.js` | REST endpoints for CRM frontend |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/webhook/sms` | Twilio inbound webhook |
| GET | `/api/messages/:contactId` | Conversation history |
| POST | `/api/send` | Manual SMS from CRM UI |
| GET | `/api/templates` | List all templates |
| PUT | `/api/templates/:id` | Update a template |
| GET | `/api/stats` | Dashboard stats |

---

## Message Templates

Templates are stored in Supabase `sms_templates` table.
Variables: `{{firstName}}` `{{lastName}}` `{{propertyAddress}}` `{{city}}` `{{county}}`

Touch sequence:
- **Touch 1** — Initial outreach (Day 0)
- **Touch 2** — 7 business days later
- **Touch 3** — 30 days later
- **Touch 4** — 180 days later