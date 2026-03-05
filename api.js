const express  = require('express');
const router   = express.Router();
const supabase = require('./supabase');
const { sendSMS, renderTemplate } = require('./sms');
const { scheduleFollowUps } = require('./followup');

// ── GET /api/messages/:contactId — conversation history ──────
router.get('/messages/:contactId', async (req, res) => {
  const { contactId } = req.params;

  const { data, error } = await supabase
    .from('sms_messages')
    .select('id, direction, body, status, intent_category, sent_at, received_at, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/send — manually send a single SMS from CRM UI ──
router.post('/send', async (req, res) => {
  const { contactId, message } = req.body;

  if (!contactId || !message) {
    return res.status(400).json({ error: 'contactId and message are required' });
  }

  // Fetch contact
  const { data: contact, error: contactError } = await supabase
    .from('property_crm_contacts')
    .select('id, firstName, lastName, phones, sms_status, opt_out_at')
    .eq('id', contactId)
    .single();

  if (contactError || !contact) {
    return res.status(404).json({ error: 'Contact not found' });
  }

  if (contact.opt_out_at || contact.sms_status === 'do_not_contact') {
    return res.status(403).json({ error: 'Contact has opted out — cannot send' });
  }

  if (!contact.phones?.length) {
    return res.status(400).json({ error: 'Contact has no phone number' });
  }

  const { success, twilioSid } = await sendSMS({
    contactId: contact.id,
    to:        contact.phones[0],
    body:      message,
  });

  if (!success) return res.status(500).json({ error: 'Failed to send SMS' });

  res.json({ success: true, twilioSid });
});

// ── GET /api/templates — list all templates ───────────────────
router.get('/templates', async (req, res) => {
  const { data, error } = await supabase
    .from('sms_templates')
    .select('*')
    .order('touch_number', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PUT /api/templates/:id — update a template ────────────────
router.put('/templates/:id', async (req, res) => {
  const { id } = req.params;
  const { body, active } = req.body;

  const updates = {};
  if (body    !== undefined) updates.body   = body;
  if (active  !== undefined) updates.active = active;

  const { data, error } = await supabase
    .from('sms_templates')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/stats — quick dashboard numbers ─────────────────
router.get('/stats', async (req, res) => {
  const [contacts, messages, queue] = await Promise.all([
    supabase.from('property_crm_contacts').select('sms_status'),
    supabase.from('sms_messages').select('direction, created_at').gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    supabase.from('sms_followup_queue').select('status').eq('status', 'pending'),
  ]);

  const statusCounts = {};
  (contacts.data || []).forEach(c => {
    statusCounts[c.sms_status] = (statusCounts[c.sms_status] || 0) + 1;
  });

  res.json({
    contacts:       statusCounts,
    sentThisWeek:   (messages.data || []).filter(m => m.direction === 'out').length,
    repliesThisWeek:(messages.data || []).filter(m => m.direction === 'in').length,
    pendingFollowUps:(queue.data || []).length,
  });
});

module.exports = router;
