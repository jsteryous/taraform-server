const express  = require('express');
const router   = express.Router();
const supabase = require('./supabase');
const { sendSMS, renderTemplate } = require('./sms');
const { scheduleFollowUps } = require('./followup');

// ── GET /api/messages/:contactId ─────────────────────────────
router.get('/messages/:contactId', async (req, res) => {
  const { data, error } = await supabase
    .from('sms_messages')
    .select('id, direction, body, status, intent_category, sent_at, received_at, created_at')
    .eq('contact_id', req.params.contactId)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/send — manual send from CRM ────────────────────
router.post('/send', async (req, res) => {
  const { contactId, message } = req.body;
  if (!contactId || !message) return res.status(400).json({ error: 'contactId and message are required' });

  const { data: contact, error: contactError } = await supabase
    .from('property_crm_contacts')
    .select('id, first_name, last_name, phones, sms_status, opt_out_at')
    .eq('id', contactId)
    .single();

  if (contactError || !contact) return res.status(404).json({ error: 'Contact not found' });
  if (contact.opt_out_at || contact.sms_status === 'do_not_contact') return res.status(403).json({ error: 'Contact has opted out' });
  if (!contact.phones?.length) return res.status(400).json({ error: 'Contact has no phone number' });

  const { success, twilioSid } = await sendSMS({
    contactId: contact.id,
    to:        contact.phones[0],
    body:      message,
  });

  if (!success) return res.status(500).json({ error: 'Failed to send SMS' });
  res.json({ success: true, twilioSid });
});

// ── GET /api/templates ────────────────────────────────────────
router.get('/templates', async (req, res) => {
  const { data, error } = await supabase
    .from('sms_templates')
    .select('*')
    .order('touch_number', { ascending: true })
    .order('active', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/templates — create new template ─────────────────
router.post('/templates', async (req, res) => {
  const { name, body, touch_number, active } = req.body;
  if (!name || !body || !touch_number) return res.status(400).json({ error: 'name, body, touch_number required' });

  const { data, error } = await supabase
    .from('sms_templates')
    .insert({ name, body, touch_number, active: active || false })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PUT /api/templates/:id — update template ──────────────────
router.put('/templates/:id', async (req, res) => {
  const { name, body, active, touch_number } = req.body;
  const updates = {};
  if (name         !== undefined) updates.name         = name;
  if (body         !== undefined) updates.body         = body;
  if (active       !== undefined) updates.active       = active;
  if (touch_number !== undefined) updates.touch_number = touch_number;

  const { data, error } = await supabase
    .from('sms_templates')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/templates/:id ─────────────────────────────────
router.delete('/templates/:id', async (req, res) => {
  // Don't allow deleting active templates
  const { data: tpl } = await supabase
    .from('sms_templates')
    .select('active')
    .eq('id', req.params.id)
    .single();

  if (tpl?.active) return res.status(400).json({ error: 'Cannot delete an active template. Set another as active first.' });

  const { error } = await supabase
    .from('sms_templates')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});


// ── GET /api/settings/:key ────────────────────────────────────
router.get('/settings/:key', async (req, res) => {
  const { data, error } = await supabase
    .from('sms_settings')
    .select('value')
    .eq('key', req.params.key)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PUT /api/settings/:key ────────────────────────────────────
router.put('/settings/:key', async (req, res) => {
  const { value } = req.body;
  const { data, error } = await supabase
    .from('sms_settings')
    .upsert({ key: req.params.key, value })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/stats ────────────────────────────────────────────
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
    contacts:        statusCounts,
    sentThisWeek:    (messages.data || []).filter(m => m.direction === 'out').length,
    repliesThisWeek: (messages.data || []).filter(m => m.direction === 'in').length,
    pendingFollowUps:(queue.data || []).length,
  });
});

module.exports = router;