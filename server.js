// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const Razorpay = require('razorpay');
const { nanoid } = require('nanoid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn(
    '[warning] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. ' +
      'Copy .env.example to .env and fill in your Razorpay keys before accepting real donations.'
  );
}

const razorpay =
  RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
    ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
    : null;

// The webhook route needs the RAW request body to verify Razorpay's
// signature, so it must be registered BEFORE the global json() parser.
app.post(
  '/api/webhooks/razorpay',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    try {
      if (!RAZORPAY_WEBHOOK_SECRET) {
        console.error('[webhook] RAZORPAY_WEBHOOK_SECRET not configured — rejecting.');
        return res.status(500).send('Webhook secret not configured');
      }

      const signature = req.headers['x-razorpay-signature'];
      const expected = crypto
        .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
        .update(req.body) // raw Buffer
        .digest('hex');

      if (!signature || signature !== expected) {
        console.warn('[webhook] signature mismatch — ignoring payload.');
        return res.status(400).send('Invalid signature');
      }

      const event = JSON.parse(req.body.toString('utf-8'));

      if (event.event === 'payment.captured' || event.event === 'order.paid') {
        const payment = event.payload.payment.entity;
        const orderId = payment.order_id;
        const paymentId = payment.id;

        const donation = db.findDonationByOrderId(orderId);
        if (donation && donation.status !== 'paid') {
          db.updateDonation(donation.id, {
            status: 'paid',
            razorpayPaymentId: paymentId,
            verifiedAt: new Date().toISOString(),
            verifiedVia: 'webhook',
          });
          console.log(`[webhook] donation ${donation.id} marked paid via webhook.`);
        }
      }

      // Always 200 quickly so Razorpay doesn't retry unnecessarily.
      res.status(200).send('ok');
    } catch (err) {
      console.error('[webhook] error handling payload:', err);
      res.status(500).send('error');
    }
  }
);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// 1. Create a Razorpay order. Nothing is marked "paid" here — this only
//    reserves an order that the frontend's Razorpay Checkout will use.
// ---------------------------------------------------------------------
app.post('/api/donations/create-order', async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(500).json({ error: 'Payment gateway is not configured on the server yet.' });
    }

    const { amount, name, email, phone, anonymous } = req.body;
    const amountNum = Number(amount);

    if (!amountNum || amountNum < 1 || !Number.isFinite(amountNum)) {
      return res.status(400).json({ error: 'Enter a valid donation amount.' });
    }
    if (amountNum > 500000) {
      return res.status(400).json({ error: 'For amounts this large, please contact us directly.' });
    }

    const amountPaise = Math.round(amountNum * 100);
    const donationId = nanoid(12);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: donationId,
      notes: { donationId },
    });

    db.createDonation({
      id: donationId,
      razorpayOrderId: order.id,
      razorpayPaymentId: null,
      amountPaise,
      currency: 'INR',
      status: 'created',
      donorName: anonymous ? null : (name || '').trim() || null,
      donorEmail: (email || '').trim() || null,
      donorPhone: (phone || '').trim() || null,
      isAnonymous: !!anonymous,
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      verifiedVia: null,
    });

    res.json({
      orderId: order.id,
      amount: amountPaise,
      currency: 'INR',
      keyId: RAZORPAY_KEY_ID,
      donationId,
    });
  } catch (err) {
    console.error('[create-order] error:', err);
    res.status(500).json({ error: 'Could not start the payment. Please try again.' });
  }
});

// ---------------------------------------------------------------------
// 2. Verify a payment right after Razorpay Checkout closes. This is a
//    fast-path confirmation for the UI — the webhook above is the
//    authoritative fallback if this call never happens (closed tab, etc).
// ---------------------------------------------------------------------
app.post('/api/donations/verify', (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing payment details.' });
    }

    const expected = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Payment could not be verified.' });
    }

    const donation = db.findDonationByOrderId(razorpay_order_id);
    if (!donation) {
      return res.status(404).json({ success: false, error: 'Donation record not found.' });
    }

    if (donation.status !== 'paid') {
      db.updateDonation(donation.id, {
        status: 'paid',
        razorpayPaymentId: razorpay_payment_id,
        verifiedAt: new Date().toISOString(),
        verifiedVia: 'client-verify',
      });
    }

    res.json({ success: true, referenceId: donation.id });
  } catch (err) {
    console.error('[verify] error:', err);
    res.status(500).json({ success: false, error: 'Verification failed.' });
  }
});

// ---------------------------------------------------------------------
// 3. Public campaign summary — powers the transparency dashboard.
// ---------------------------------------------------------------------
app.get('/api/campaign/summary', (req, res) => {
  const settings = db.getSettings();
  const paid = db.getPaidDonations();

  const raisedPaise = paid.reduce((sum, d) => sum + d.amountPaise, 0);
  const supporters = paid.length;

  const recent = paid
    .slice(-8)
    .reverse()
    .map((d) => ({
      label: d.isAnonymous || !d.donorName ? 'Anonymous' : d.donorName,
      amountPaise: d.amountPaise,
    }));

  res.json({
    goalPaise: settings.goalPaise,
    raisedPaise,
    supporters,
    opsiysContributionPaise: settings.opsiysContributionPaise,
    transferredPaise: settings.transferredPaise,
    adminChargesPaise: settings.adminChargesPaise,
    recent,
  });
});

// ---------------------------------------------------------------------
// Admin routes — protected by a bearer token (ADMIN_TOKEN in .env).
// This is a minimal gate; replace with real authenticated admin auth
// (e.g. a proper login + session/JWT) before relying on this long-term.
// ---------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/donations', requireAdmin, (req, res) => {
  res.json(db.getAllDonations());
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { goalPaise, opsiysContributionPaise, transferredPaise, adminChargesPaise } = req.body;
  const patch = {};
  if (goalPaise !== undefined) patch.goalPaise = Number(goalPaise);
  if (opsiysContributionPaise !== undefined) patch.opsiysContributionPaise = Number(opsiysContributionPaise);
  if (transferredPaise !== undefined) patch.transferredPaise = Number(transferredPaise);
  if (adminChargesPaise !== undefined) patch.adminChargesPaise = Number(adminChargesPaise);
  res.json(db.updateSettings(patch));
});

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const rows = db.getAllDonations();
  const header = 'id,status,amount_inr,donor_name,donor_email,donor_phone,anonymous,created_at,verified_at,razorpay_payment_id\n';
  const body = rows
    .map((d) =>
      [
        d.id,
        d.status,
        (d.amountPaise / 100).toFixed(2),
        d.isAnonymous ? '' : (d.donorName || ''),
        d.donorEmail || '',
        d.donorPhone || '',
        d.isAnonymous,
        d.createdAt,
        d.verifiedAt || '',
        d.razorpayPaymentId || '',
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    )
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="donations.csv"');
  res.send(header + body);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Opsiys for Nepal server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
