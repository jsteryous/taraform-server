const express = require('express');
const router  = express.Router();
const supabase = require('./supabase');
const { categorizeReply } = require('./ai');
const { sendAlert } = require('./sms');

// ── Opt-out keywords (TCPA required — must honor immediately) ─
const OPT_OUT_KEYWORDS = [
  'stop', 'quit', 'cancel', 'unsubscribe', 'end',
  'stopall', 'remove me', "don't text", 'dont text',
  'do not text', 'no more texts', 'take me off'
];

function isOptOut(text) {
  const lower = text.toLowerCase().trim();
  return OPT_OUT_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Map Claude category → CRM sms_status ─────────────────────
const CATEGORY_TO_STATUS = {
  INTERESTED:     'interested',
  WANTS_CALL:     'interested',   // treat as interested for status
  NOT_INTERESTED: 'not_interested',
  OPT_OUT:        'do_not_contact',
  UNCLEAR:        'unclear',
};

// ── POST /webhook/sms — Twilio calls this on every inbound ───
router.post('/sms', async (req, res) => {
  // Respond to Twilio immediately (empty TwiML = no auto-reply)
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const from = req.body.From;   // e.g. "+18645551234"
  const body = req.body.Body?.trim();

  if (!from || !body) return;

  console.log(`Inbound SMS from ${from}: "${body}"`);

  // ── 1. Look up contact by phone number ──────────────────────
  const { data: contacts, error: lookupError } = await supabase
    .from('property_crm_contacts')
    .select('id, first_name, last_name, phones, sms_status')
    .filter('phones', 'cs', JSON.stringify([from]));

  if (lookupError) {
    console.error('Contact lookup failed:', lookupError.message);
    return;
  }

  const contact = contacts?.[0];

  if (!contact) {
    console.warn(`No contact found for number ${from} — logging as unknown`);
    return;
  }

  // ── 2. Hard opt-out keyword check (before AI) ────────────────
  let category;
  if (isOptOut(body)) {
    category = 'OPT_OUT';
  } else {
    // ── 3. Claude categorization ──────────────────────────────
    category = await categorizeReply(body);
  }

  console.log(`Contact ${contact.id} reply categorized as: ${category}`);

  // ── 4. Log inbound message ───────────────────────────────────
  const { error: logError } = await supabase.from('sms_messages').insert({
    contact_id:      contact.id,
    direction:       'in',
    body,
    status:          'received',
    intent_category: category,
    received_at:     new Date().toISOString(),
  });

  if (logError) console.error('Failed to log inbound SMS:', logError.message);

  // ── 5. Update contact status ─────────────────────────────────
  const newStatus = CATEGORY_TO_STATUS[category];
  const updates = {
    sms_status:          newStatus,
    reply_received_at:   new Date().toISOString(),
    followup_paused:     true,   // pause cadence on any reply
  };

  if (category === 'OPT_OUT') {
    updates.opt_out_at = new Date().toISOString();
  }

  await supabase
    .from('property_crm_contacts')
    .update(updates)
    .eq('id', contact.id);

  // ── 6. Cancel pending follow-ups if opted out or not interested
  if (category === 'OPT_OUT' || category === 'NOT_INTERESTED') {
    await supabase
      .from('sms_followup_queue')
      .update({ status: 'cancelled' })
      .eq('contact_id', contact.id)
      .eq('status', 'pending');
  }

  // ── 7. Alert owner if hot lead ───────────────────────────────
  if (category === 'INTERESTED' || category === 'WANTS_CALL') {
    const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unknown';
    const action = category === 'WANTS_CALL' ? 'wants you to call them' : 'is open to an offer';

    await sendAlert(
      `🔥 Taraform lead: ${name} (${from}) ${action}.\n\nTheir message: "${body}"\n\nReply manually from your Twilio number.`
    );
  }
});

module.exports = router;