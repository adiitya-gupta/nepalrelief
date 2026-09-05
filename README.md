# Opsiys for Nepal — donation site with real Razorpay integration

A working Node/Express app: the landing page plus a backend that creates real
Razorpay orders, verifies payments server-side, handles webhooks, and powers
a live transparency dashboard. Nothing is faked — a donation only shows as
"paid" once Razorpay has actually confirmed it.

## 1. One-time setup

```bash
cd opsiys-nepal-app
npm install
cp .env.example .env
```

Open `.env` and fill in:

- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — from your Razorpay Dashboard →
  **Settings → API Keys**. Start with the **Test Mode** keys (prefixed
  `rzp_test_...`) so you can run full test payments before any real money
  moves.
- `ADMIN_TOKEN` — make up a long random string yourself, this protects the
  admin API.
- `RAZORPAY_WEBHOOK_SECRET` — you'll get this in step 3 below.

**Never paste your `RAZORPAY_KEY_SECRET` into a chat with anyone, including
an AI assistant.** Only ever put it directly into `.env` on your own
machine or your hosting provider's environment-variable settings.

## 2. Run it locally

```bash
npm start
```

Visit `http://localhost:4000`. With test keys in place, clicking "Continue
to donate" opens a real Razorpay Checkout in test mode — use Razorpay's
[test card numbers](https://razorpay.com/docs/payments/payments/test-card-details/)
to complete a full test donation end-to-end, including the server-side
signature verification.

## 3. Set up the webhook (do this before going live)

The webhook is what makes a donation count even if someone closes the tab
right after paying — don't skip it.

1. Razorpay Dashboard → **Settings → Webhooks → Add New Webhook**
2. URL: `https://YOUR-DEPLOYED-DOMAIN/api/webhooks/razorpay`
3. Active events: tick **payment.captured** (and optionally `order.paid`)
4. Razorpay will show you a webhook secret — put that in `.env` as
   `RAZORPAY_WEBHOOK_SECRET`

Webhooks need a public URL, so you'll only be able to fully test this step
once the app is deployed (step 5), or by using a tunnel like `ngrok` while
developing locally.

## 4. Go live with real payments

1. In Razorpay, complete your business KYC and switch to **Live Mode**.
2. Swap the test keys in `.env` for the live `rzp_live_...` keys.
3. Update the webhook URL/secret for live mode the same way as step 3.
4. Before switching this on publicly: confirm the legal entity this
   campaign is operating under, and the verified relief organization the
   funds are being transferred to — both belong in the footer/FAQ
   placeholders in `public/index.html`, and Razorpay's own KYC for
   donation-style collection will typically ask for this too.

## 5. Deploy

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). General shape:

1. Push this folder to a git repo (`.env` and `data/` are already
   git-ignored — don't force-add them).
2. On your host, set the same environment variables from `.env` in its
   dashboard/secrets manager.
3. Start command: `npm start`. The app serves both the frontend and the
   API from the same process, so no separate frontend deploy is needed.

The included datastore (`db.js`) writes to a local `data/db.json` file —
that's fine to launch with, but pick a host with persistent disk (not one
that wipes the filesystem on every deploy), and plan to migrate to a real
database (Postgres, etc.) once the campaign is getting steady traffic —
the architecture notes for that swap are in
`opsiys-nepal-backend-architecture.md` from the earlier version of this
project.

## 6. Admin access

There's no UI yet, just protected API routes (send `Authorization: Bearer
<ADMIN_TOKEN>`):

- `GET /api/admin/donations` — every donation record
- `GET /api/admin/export.csv` — CSV export
- `POST /api/admin/settings` — update `{ goalPaise, opsiysContributionPaise,
  transferredPaise, adminChargesPaise }`, all in paise (₹1 = 100)

Example:
```bash
curl -X POST https://YOUR-DOMAIN/api/admin/settings \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"opsiysContributionPaise": 5000000}'
```

## What's still a placeholder

- Hero/section images — swap for verified, rights-cleared photos
- Relief partner name, campaign contact email, legal footer text
- Privacy Policy / Terms / Refund Policy / Donation Disclaimer pages
  (linked in the footer but not written)
- A proper admin dashboard UI (currently API-only — fine to drive from
  curl/Postman for a small campaign, worth building a simple page once
  volume picks up)

## One more thing worth 30 seconds

Publicly collecting donations for disaster relief in India generally
expects a registered entity behind the campaign, and moving funds into
Nepal specifically adds cross-border compliance (FEMA/RBI, and FCRA-style
rules if it's routed as foreign contribution). This app is built to be
switched on the moment that's sorted — the code doesn't need to change,
just the footer/FAQ placeholders and your Razorpay KYC. Worth confirming
with someone who knows this space before flipping `.env` to live keys.
