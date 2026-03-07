const express  = require('express');
const router   = express.Router();
const supabase = require('./supabase');
const { sendSMS, renderTemplate } = require('./sms');
const { scheduleFollowUps } = require('./followup');

// ── GET /api/clients ──────────────────────────────────────────
router.get('/clients', async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/clients — create a new client ───────────────────
router.post('/clients', async (req, res) => {
  const { name, twilio_number } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { data, error } = await supabase
    .from('clients')
    .insert({ name, twilio_number: twilio_number || null })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Seed default automation_paused setting for this client
  await supabase.from('sms_settings').insert({
    client_id: data.id,
    key:       'automation_paused',
    value:     'false',
  });

  res.json(data);
});

// ── PUT /api/clients/:id — update client ──────────────────────
router.put('/clients/:id', async (req, res) => {
  const { name, twilio_number, custom_field_definitions } = req.body;
  const updates = {};
  if (name                     !== undefined) updates.name                     = name;
  if (twilio_number            !== undefined) updates.twilio_number            = twilio_number;
  if (custom_field_definitions !== undefined) updates.custom_field_definitions = custom_field_definitions;

  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/clients/:id ───────────────────────────────────
router.delete('/clients/:id', async (req, res) => {
  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

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
    .select('id, first_name, last_name, phones, sms_status, opt_out_at, client_id')
    .eq('id', contactId)
    .single();

  if (contactError || !contact) return res.status(404).json({ error: 'Contact not found' });
  if (contact.opt_out_at || contact.sms_status === 'do_not_contact') return res.status(403).json({ error: 'Contact has opted out' });
  if (!contact.phones?.length) return res.status(400).json({ error: 'Contact has no phone number' });

  // Look up the client's twilio_number if set
  let fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (contact.client_id) {
    const { data: client } = await supabase
      .from('clients')
      .select('twilio_number')
      .eq('id', contact.client_id)
      .single();
    if (client?.twilio_number) fromNumber = client.twilio_number;
  }

  const { success, twilioSid } = await sendSMS({
    contactId: contact.id,
    to:        contact.phones[0],
    body:      message,
    from:      fromNumber,
    clientId:  contact.client_id,
  });

  if (!success) return res.status(500).json({ error: 'Failed to send SMS' });
  res.json({ success: true, twilioSid });
});

// ── GET /api/templates?client_id=xxx ─────────────────────────
router.get('/templates', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id query param required' });

  const { data, error } = await supabase
    .from('sms_templates')
    .select('*')
    .eq('client_id', client_id)
    .order('touch_number', { ascending: true })
    .order('active', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/templates — create new template ─────────────────
router.post('/templates', async (req, res) => {
  const { name, body, touch_number, active, client_id } = req.body;
  if (!name || !body || !touch_number || !client_id) {
    return res.status(400).json({ error: 'name, body, touch_number, client_id required' });
  }

  const { data, error } = await supabase
    .from('sms_templates')
    .insert({ name, body, touch_number, active: active || false, client_id })
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

// ── GET /api/settings/:key?client_id=xxx ─────────────────────
router.get('/settings/:key', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id query param required' });

  const { data, error } = await supabase
    .from('sms_settings')
    .select('value')
    .eq('key', req.params.key)
    .eq('client_id', client_id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PUT /api/settings/:key ────────────────────────────────────
router.put('/settings/:key', async (req, res) => {
  const { value, client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id required in body' });

  const { data, error } = await supabase
    .from('sms_settings')
    .upsert({ key: req.params.key, value, client_id })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/stats?client_id=xxx ─────────────────────────────
router.get('/stats', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id query param required' });

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [contacts, messages, queue, allMessages, leads, closed] = await Promise.all([
    supabase.from('property_crm_contacts')
      .select('sms_status')
      .eq('client_id', client_id),

    supabase.from('sms_messages')
      .select('direction, status, created_at')
      .eq('client_id', client_id)
      .gte('created_at', weekAgo),

    supabase.from('sms_followup_queue')
      .select('status')
      .eq('client_id', client_id)
      .eq('status', 'pending'),

    // All-time sent + delivered for delivery rate
    supabase.from('sms_messages')
      .select('direction, status')
      .eq('client_id', client_id)
      .eq('direction', 'out'),

    // Positive leads = contacts with interested status
    supabase.from('property_crm_contacts')
      .select('id')
      .eq('client_id', client_id)
      .eq('sms_status', 'interested'),

    // Deals closed
    supabase.from('property_crm_contacts')
      .select('id')
      .eq('client_id', client_id)
      .eq('sms_status', 'closed'),
  ]);

  const statusCounts = {};
  (contacts.data || []).forEach(c => {
    statusCounts[c.sms_status] = (statusCounts[c.sms_status] || 0) + 1;
  });

  const outboundAll   = (allMessages.data || []);
  const delivered     = outboundAll.filter(m => m.status === 'delivered').length;
  const totalSent     = outboundAll.length;
  const deliveryRate  = totalSent > 0 ? Math.round((delivered / totalSent) * 100) : null;

  const weekOut      = (messages.data || []).filter(m => m.direction === 'out');
  const weekIn       = (messages.data || []).filter(m => m.direction === 'in');
  // Unique contacts that replied this week (rough reply rate proxy)
  const replyRate    = weekOut.length > 0 ? Math.round((weekIn.length / weekOut.length) * 100) : null;

  res.json({
    contacts:        statusCounts,
    sentThisWeek:    weekOut.length,
    repliesThisWeek: weekIn.length,
    pendingFollowUps:(queue.data || []).length,
    // ── New per-client marketing metrics ──
    totalSent,
    deliveryRate,   // percent, or null if no data yet
    replyRate,      // percent this week, or null
    positiveLeads:  (leads.data || []).length,
    dealsClosed:    (closed.data || []).length,
  });
});

module.exports = router;