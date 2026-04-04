const express  = require('express');
const router   = express.Router();
const supabase = require('./supabase');
const { sendSMS, renderTemplate } = require('./sms');
const { scheduleFollowUps } = require('./followup');

// ── Auth helper — extracts and verifies Supabase JWT ─────────
async function getUserFromReq(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// ── GET /api/clients ──────────────────────────────────────────
router.get('/clients', async (req, res) => {
  const user = await getUserFromReq(req);
  if (!user) return res.json([]);

  // Get client_ids this user belongs to
  const { data: memberships, error: memErr } = await supabase
    .from('client_users')
    .select('client_id')
    .eq('user_id', user.id);

  if (memErr) return res.status(500).json({ error: memErr.message });
  if (!memberships.length) return res.json([]);

  const clientIds = memberships.map(m => m.client_id);

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .in('id', clientIds)
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

  // Add the creating user as owner if they're authenticated
  const user = await getUserFromReq(req);
  if (user) {
    await supabase.from('client_users').insert({
      client_id: data.id,
      user_id:   user.id,
      role:      'owner',
    });
  }

  res.json(data);
});

// ── PUT /api/clients/:id — update client ──────────────────────
router.put('/clients/:id', async (req, res) => {
  const { name, twilio_number, config, custom_field_definitions } = req.body;
  const updates = {};
  if (name                     !== undefined) updates.name                     = name;
  if (twilio_number            !== undefined) updates.twilio_number            = twilio_number;
  if (config                   !== undefined) updates.config                   = config;
  if (custom_field_definitions !== undefined) updates.custom_field_definitions =
    typeof custom_field_definitions === 'string'
      ? custom_field_definitions
      : JSON.stringify(custom_field_definitions);

  if (Object.keys(updates).length === 0) {
    const { data, error } = await supabase.from('clients').select('*').eq('id', req.params.id).single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  const { data, error } = await supabase
    .from('clients').update(updates).eq('id', req.params.id).select().single();

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
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || { value: null });
});

// ── PUT /api/settings/:key ────────────────────────────────────
router.put('/settings/:key', async (req, res) => {
  const { value, client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id required in body' });

  const { data: existing } = await supabase
    .from('sms_settings').select('id')
    .eq('key', req.params.key).eq('client_id', client_id)
    .maybeSingle();

  let data, error;
  if (existing) {
    ({ data, error } = await supabase
      .from('sms_settings').update({ value })
      .eq('key', req.params.key).eq('client_id', client_id)
      .select().single());
  } else {
    ({ data, error } = await supabase
      .from('sms_settings').insert({ key: req.params.key, value, client_id })
      .select().single());
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/stats?client_id=xxx ─────────────────────────────
router.get('/stats', async (req, res) => {
  const { client_id, period = 'week' } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id query param required' });

  const now = new Date();
  const periodStart = {
    today:   new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    week:    new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString(),
    month:   new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    alltime: new Date(0).toISOString(),
  }[period] || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [contacts, periodMessages, allMessages, queue, templates, contactsWithOffers] = await Promise.all([
    supabase.from('property_crm_contacts').select('sms_status, status').eq('client_id', client_id),
    supabase.from('sms_messages').select('direction, status, intent_category, template_id, created_at').eq('client_id', client_id).gte('created_at', periodStart),
    supabase.from('sms_messages').select('direction, status, template_id, intent_category').eq('client_id', client_id),
    supabase.from('sms_followup_queue').select('status').eq('client_id', client_id).eq('status', 'pending'),
    supabase.from('sms_templates').select('id, name, touch_number').eq('client_id', client_id),
    supabase.from('contact_offers').select('*, property_crm_contacts(first_name, last_name, county, tax_map_ids)').eq('client_id', client_id),
  ]);

  const smsStatusCounts = {}, contactStatusCounts = {};
  (contacts.data || []).forEach(c => {
    smsStatusCounts[c.sms_status || 'eligible'] = (smsStatusCounts[c.sms_status || 'eligible'] || 0) + 1;
    contactStatusCounts[c.status || 'New Lead']  = (contactStatusCounts[c.status || 'New Lead']  || 0) + 1;
  });

  const pMsgs = periodMessages.data || [];
  const pOut  = pMsgs.filter(m => m.direction === 'out');
  const pIn   = pMsgs.filter(m => m.direction === 'in');
  const intentCounts = {};
  pIn.forEach(m => { const k = m.intent_category || 'unknown'; intentCounts[k] = (intentCounts[k] || 0) + 1; });

  const allOut = (allMessages.data || []).filter(m => m.direction === 'out');
  const delivered = allOut.filter(m => m.status === 'delivered').length;
  const totalSent = allOut.length;
  const deliveryRate = totalSent > 0 ? Math.round((delivered / totalSent) * 100) : null;

  const allMsgs = allMessages.data || [];
  const templatePerf = (templates.data || []).map(t => {
    const sent = allMsgs.filter(m => m.template_id === t.id && m.direction === 'out').length;
    const replies = allMsgs.filter(m => m.template_id === t.id && m.direction === 'in').length;
    const interested = allMsgs.filter(m => m.template_id === t.id && m.direction === 'in' && m.intent_category === 'interested').length;
    const optOuts = allMsgs.filter(m => m.template_id === t.id && m.direction === 'in' && m.intent_category === 'opt_out').length;
    return { id: t.id, name: t.name, touchNumber: t.touch_number, sent, replies, replyRate: sent > 0 ? Math.round((replies/sent)*100) : null, interested, optOuts, optOutRate: sent > 0 ? Math.round((optOuts/sent)*100) : null };
  }).sort((a, b) => (a.touchNumber || 99) - (b.touchNumber || 99));

  // Offer stats — all offers from contact_offers table
  const allOffers = (contactsWithOffers.data || []).map(({ property_crm_contacts: pcc, ...o }) => {
    const c = pcc || {};
    return { ...o, contactId: o.contact_id, createdAt: o.created_at, contactName: `${c.first_name||''} ${c.last_name||''}`.trim(), county: c.county||'', taxMapIds: c.tax_map_ids||[] };
  });
  const periodOffers = period === 'alltime' ? allOffers : allOffers.filter(o => o.createdAt && o.createdAt >= periodStart);
  const offerByStatus = {};
  periodOffers.forEach(o => { const s = o.status || 'Pending'; offerByStatus[s] = (offerByStatus[s]||0)+1; });

  res.json({
    period, periodStart,
    sentThisPeriod:    pOut.length,
    repliesThisPeriod: pIn.length,
    replyRate:         pOut.length > 0 ? Math.round((pIn.length/pOut.length)*100) : null,
    intentBreakdown:   intentCounts,
    totalSent, deliveryRate,
    smsStatusCounts, contactStatusCounts,
    pendingFollowUps: (queue.data || []).length,
    totalContacts:    (contacts.data || []).length,
    templatePerformance: templatePerf,
    offerStats: {
      count:         new Set(periodOffers.map(o => o.contactId)).size,
      allTimeCount:  new Set(allOffers.map(o => o.contactId)).size,
      totalCount:    periodOffers.length,
      totalValue:    periodOffers.reduce((s,o) => s+(Number(o.amount)||0), 0),
      acceptedValue: periodOffers.filter(o => o.status==='Accepted').reduce((s,o) => s+(Number(o.amount)||0), 0),
      byStatus:      offerByStatus,
      recent:        [...periodOffers].sort((a,b) => new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,50),
      allTime:       allOffers,
    },
  });
});



// ── Offer CRUD ────────────────────────────────────────────────

// POST /api/contacts/:contactId/offers
router.post('/contacts/:contactId/offers', async (req, res) => {
  const { contactId } = req.params;
  const { amount, status, notes, clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { data, error } = await supabase
    .from('contact_offers')
    .insert({ id: Date.now(), contact_id: contactId, client_id: clientId, amount, status, notes })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /api/contacts/:contactId/offers/:offerId
router.put('/contacts/:contactId/offers/:offerId', async (req, res) => {
  const { contactId, offerId } = req.params;
  const { amount, status, notes, clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { data, error } = await supabase
    .from('contact_offers')
    .update({ amount, status, notes })
    .eq('id', offerId)
    .eq('contact_id', contactId)
    .eq('client_id', clientId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Offer not found' });
  res.json(data);
});

// DELETE /api/contacts/:contactId/offers/:offerId
router.delete('/contacts/:contactId/offers/:offerId', async (req, res) => {
  const { contactId, offerId } = req.params;
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id query param required' });

  const { data, error } = await supabase
    .from('contact_offers')
    .delete()
    .eq('id', offerId)
    .eq('contact_id', contactId)
    .eq('client_id', client_id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Offer not found' });
  res.json({ success: true });
});


// ── Email routes ──────────────────────────────────────────────
const { sendEmail, renderEmailTemplate, getAuthUrl, handleCallback, getTokenRecord } = require('./email');

// GET /api/email/auth-url?client_id=xxx  — get OAuth URL
router.get('/email/auth-url', (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  res.json({ url: getAuthUrl(client_id) });
});

// GET /api/email/status?client_id=xxx  — check if connected
router.get('/email/status', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const record = await getTokenRecord(client_id);
  res.json({ connected: !!record, email: record?.email || null });
});

// DELETE /api/email/disconnect?client_id=xxx
router.delete('/email/disconnect', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  await supabase.from('email_tokens').delete().eq('client_id', client_id);
  res.json({ success: true });
});

// GET /api/email/templates?client_id=xxx
router.get('/email/templates', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('client_id', client_id)
    .order('touch_number', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/email/templates
router.post('/email/templates', async (req, res) => {
  const { client_id, name, subject, body, touch_number } = req.body;
  if (!client_id || !name || !subject || !body) return res.status(400).json({ error: 'client_id, name, subject, body required' });
  const { data, error } = await supabase.from('email_templates').insert({
    client_id, name, subject, body,
    touch_number: touch_number || null,
    created_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /api/email/templates/:id
router.put('/email/templates/:id', async (req, res) => {
  const { name, subject, body, touch_number } = req.body;
  const { data, error } = await supabase.from('email_templates')
    .update({ name, subject, body, touch_number: touch_number || null })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/email/templates/:id
router.delete('/email/templates/:id', async (req, res) => {
  const { error } = await supabase.from('email_templates').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /api/email/send-batch  — manual send to selected contacts
router.post('/email/send-batch', async (req, res) => {
  const { client_id, contact_ids, template_id } = req.body;
  if (!client_id || !contact_ids?.length || !template_id) {
    return res.status(400).json({ error: 'client_id, contact_ids, template_id required' });
  }

  // Load template
  const { data: template, error: tErr } = await supabase
    .from('email_templates').select('*').eq('id', template_id).single();
  if (tErr || !template) return res.status(404).json({ error: 'Template not found' });

  // Load contacts
  const { data: contacts, error: cErr } = await supabase
    .from('property_crm_contacts')
    .select('id, first_name, last_name, email, phones, county, property_addresses, tax_map_ids, email_status')
    .in('id', contact_ids)
    .eq('client_id', client_id);
  if (cErr) return res.status(500).json({ error: cErr.message });

  // Filter out contacts with no email or already opted out
  const eligible = contacts.filter(c => c.email && c.email_status !== 'do_not_email');

  // Respond immediately, send in background
  res.json({ queued: eligible.length, skipped: contacts.length - eligible.length });

  // Send one at a time with 30-60s delay between
  for (let i = 0; i < eligible.length; i++) {
    const contact = eligible[i];
    const subject = renderEmailTemplate(template.subject, contact);
    const body    = renderEmailTemplate(template.body, contact);
    try {
      await sendEmail({ clientId: client_id, contactId: contact.id, to: contact.email, subject, body, templateId: template_id });
    } catch (e) {
      console.error(`Email failed for ${contact.id}:`, e.message);
    }
    // Random delay 30-60s between sends (skip after last)
    if (i < eligible.length - 1) {
      await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
    }
  }
});

// GET /api/email/messages?contact_id=xxx&client_id=xxx
router.get('/email/messages', async (req, res) => {
  const { contact_id, client_id } = req.query;
  if (!contact_id || !client_id) return res.status(400).json({ error: 'contact_id and client_id required' });
  const { data, error } = await supabase
    .from('email_messages')
    .select('subject, body, status, sent_at, template_id')
    .eq('contact_id', contact_id)
    .eq('client_id', client_id)
    .order('sent_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/email/send-one  — send a single email from contact detail
router.post('/email/send-one', async (req, res) => {
  const { client_id, contact_id, subject, body, template_id, force } = req.body;
  if (!client_id || !contact_id || !subject || !body) {
    return res.status(400).json({ error: 'client_id, contact_id, subject, body required' });
  }

  const { data: contact, error: cErr } = await supabase
    .from('property_crm_contacts')
    .select('id, first_name, last_name, email, phones, county, property_addresses, tax_map_ids, acreage, email_status')
    .eq('id', contact_id).single();
  if (cErr || !contact) return res.status(404).json({ error: 'Contact not found' });
  if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });
  if (contact.email_status === 'do_not_email') return res.status(403).json({ error: 'Contact is marked do not email' });

  // Warn if not verified, but allow manual override with force=true
  if (contact.email_status === 'eligible' && !force) {
    return res.status(422).json({ error: 'Email not verified. Send anyway?', unverified: true });
  }

  const renderedSubject = renderEmailTemplate(subject, contact);
  const renderedBody    = renderEmailTemplate(body, contact);

  const { success } = await sendEmail({
    clientId:   client_id,
    contactId:  contact_id,
    to:         contact.email,
    subject:    renderedSubject,
    body:       renderedBody,
    templateId: template_id || null,
  });

  res.json({ success });
});

// ── Email verification routes (Reoon) ─────────────────────────
const { submitBulkJob, getJobResult, updateContactStatuses, saveJobState, getJobState } = require('./reoon');

// POST /api/email/verify-start  — submit all client emails to Reoon
router.post('/email/verify-start', async (req, res) => {
  const { client_id, limit = 100 } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });

  // Check no job already running
  const existing = await getJobState(client_id);
  if (existing?.status === 'running') {
    return res.json({ alreadyRunning: true, job: existing });
  }

  // Fetch slightly more than limit to account for deduplication
  const { data: contacts, error } = await supabase
    .from('property_crm_contacts')
    .select('id, email')
    .eq('client_id', client_id)
    .eq('email_status', 'eligible')  // skip unknown, verified, do_not_email
    .not('email', 'is', null)
    .neq('email', '')
    .limit(limit + 10);

  if (error) return res.status(500).json({ error: error.message });

  const emails = [...new Set((contacts || []).map(c => c.email.toLowerCase().trim()).filter(Boolean))].slice(0, limit);
  if (!emails.length) return res.status(400).json({ error: 'No unverified contacts with email addresses found' });

  try {
    const taskId = await submitBulkJob(emails, `Taraform - ${new Date().toLocaleDateString()}`);
    const job = { taskId, status: 'running', total: emails.length, startedAt: new Date().toISOString() };
    await saveJobState(client_id, job);
    res.json({ started: true, taskId, total: emails.length });
    pollAndUpdate(client_id, taskId).catch(e => console.error('Reoon poll error:', e.message));
  } catch (e) {
    console.error('Reoon verify-start error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/verify-status?client_id=xxx  — check job progress
router.get('/email/verify-status', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const job = await getJobState(client_id);
  res.json(job || { status: 'idle' });
});

// POST /api/email/verify-reprocess?client_id=xxx — fetch results from Reoon and apply them
router.post('/email/verify-reprocess', async (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });

  const job = await getJobState(client_id);
  if (!job?.taskId) return res.status(400).json({ error: 'No task ID found — run verification first' });

  try {
    console.log(`[Reoon] Reprocessing task ${job.taskId} for ${client_id}`);
    const result = await getJobResult(job.taskId);
    console.log(`[Reoon] Task status: ${result.status}, results: ${result.results?.length || 0}`);

    if (!result.results?.length) {
      return res.status(400).json({ error: `Reoon task status: ${result.status} — no results available yet` });
    }

    const stats = await updateContactStatuses(result.results, client_id);
    await saveJobState(client_id, {
      ...job,
      status: 'completed',
      verified: stats.verified,
      blocked: stats.blocked,
      skipped: stats.skipped,
      completedAt: new Date().toISOString(),
    });

    console.log(`[Reoon] Reprocess complete — ${stats.verified} verified, ${stats.blocked} blocked, ${stats.skipped} skipped`);
    res.json({ success: true, ...stats });
  } catch (e) {
    console.error('[Reoon] Reprocess error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/email/verify-reset?client_id=xxx  — clear stuck job
router.delete('/email/verify-reset', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  await saveJobState(client_id, { status: 'idle' });
  res.json({ success: true });
});

// Background poll function
async function pollAndUpdate(clientId, taskId) {
  const MAX_POLLS = 60;
  for (let i = 0; i < MAX_POLLS; i++) {
    // First poll after 5s, then every 15s
    await new Promise(r => setTimeout(r, i === 0 ? 5000 : 15000));

    let result;
    try {
      result = await getJobResult(taskId);
    } catch (e) {
      console.error(`[Reoon] Poll ${i + 1} error:`, e.message);
      continue;
    }
    console.log(`[Reoon] Poll ${i + 1}: status=${result.status}, results=${result.results?.length || 0}`);

    const isComplete = result.status === 'completed';
    const isFailed   = ['failed', 'insufficient_credits', 'file_not_found', 'file_loading_error', 'error'].includes(result.status);

    // Process whatever results we have, even partial
    if (isComplete || isFailed) {
      if (result.results?.length) {
        const stats = await updateContactStatuses(result.results, clientId);
        console.log(`[Reoon] ${result.status} — ${stats.verified} verified, ${stats.blocked} blocked, ${stats.skipped} skipped`);
        await saveJobState(clientId, {
          taskId, status: 'completed',
          total: result.count_total, verified: stats.verified,
          blocked: stats.blocked, skipped: stats.skipped,
          completedAt: new Date().toISOString(),
        });
      } else {
        // Reoon completed but results array is empty — mark done anyway so UI stops spinning
        console.log(`[Reoon] ${result.status} with no results array — marking complete. count_total=${result.count_total}`);
        await saveJobState(clientId, {
          taskId, status: 'completed',
          total: result.count_total || 0, verified: 0, blocked: 0, skipped: result.count_total || 0,
          completedAt: new Date().toISOString(),
          note: 'No results returned by Reoon — credits may have been exhausted',
        });
      }
      return;
    }

    if (isFailed && !result.results?.length) {
      console.log(`[Reoon] Job failed with no results: ${result.status}`);
      await saveJobState(clientId, { taskId, status: 'failed', reason: result.status });
      return;
    }

    // Update progress
    await saveJobState(clientId, {
      taskId, status: 'running',
      total: result.count_total, checked: result.count_checked,
      startedAt: new Date().toISOString(),
    });
  }

  await saveJobState(clientId, { taskId, status: 'timeout' });
}

// ── GET /api/email/stats?client_id=xxx&period=xxx ─────────────
router.get('/email/stats', async (req, res) => {
  const { client_id, period = 'week' } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });

  const now = Date.now();
  const cutoffs = {
    today:   new Date(new Date().setHours(0,0,0,0)).toISOString(),
    week:    new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString(),
    month:   new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    alltime: new Date(0).toISOString(),
  };
  const since = cutoffs[period] || cutoffs.week;

  const [periodMsgs, allMsgs, statusCounts, autoSetting, recentMsgs] = await Promise.all([
    // Emails sent this period
    supabase.from('email_messages')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client_id)
      .eq('direction', 'out')
      .eq('status', 'sent')
      .gte('sent_at', since),

    // All-time sent
    supabase.from('email_messages')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client_id)
      .eq('direction', 'out')
      .eq('status', 'sent'),

    // Email status counts on contacts
    supabase.from('property_crm_contacts')
      .select('email_status')
      .eq('client_id', client_id)
      .not('email', 'is', null)
      .neq('email', ''),

    // Automation enabled setting
    supabase.from('sms_settings')
      .select('value')
      .eq('client_id', client_id)
      .eq('key', 'email_automation_enabled')
      .single(),

    // Recent sends with contact name
    supabase.from('email_messages')
      .select('subject, sent_at, contact_id')
      .eq('client_id', client_id)
      .eq('direction', 'out')
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(15),
  ]);

  // Count email statuses
  const counts = { verified: 0, do_not_email: 0, eligible: 0, unknown: 0 };
  (statusCounts.data || []).forEach(c => {
    const s = c.email_status || 'eligible';
    counts[s] = (counts[s] || 0) + 1;
  });

  // Enrich recent sends with contact names
  const contactIds = [...new Set((recentMsgs.data || []).map(m => m.contact_id).filter(Boolean))];
  let contactNames = {};
  if (contactIds.length > 0) {
    const { data: names } = await supabase
      .from('property_crm_contacts')
      .select('id, first_name, last_name')
      .in('id', contactIds);
    (names || []).forEach(c => {
      contactNames[c.id] = `${c.first_name || ''} ${c.last_name || ''}`.trim();
    });
  }

  const recent = (recentMsgs.data || []).map(m => ({
    ...m,
    contactName: contactNames[m.contact_id] || null,
  }));

  res.json({
    period,
    sentThisPeriod:  periodMsgs.count || 0,
    totalSent:       allMsgs.count    || 0,
    verifiedCount:   counts.verified,
    blockedCount:    counts.do_not_email,
    unverifiedCount: counts.eligible,
    unknownCount:    counts.unknown,
    autoEnabled:     autoSetting.data?.value === 'true',
    recent,
  });
});

// ── GET /api/clients/:id/users — list members ────────────────
router.get('/clients/:id/users', async (req, res) => {
  const user = await getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Verify caller is a member of this client
  const { data: membership, error: memErr } = await supabase
    .from('client_users')
    .select('role')
    .eq('client_id', req.params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (memErr) return res.status(500).json({ error: memErr.message });
  if (!membership) return res.status(403).json({ error: 'Forbidden' });

  const { data, error } = await supabase
    .from('client_users')
    .select('id, user_id, role, created_at')
    .eq('client_id', req.params.id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/clients/:id/users — add a member by email ──────
router.post('/clients/:id/users', async (req, res) => {
  const user = await getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Verify caller is a member of this client
  const { data: membership, error: memErr } = await supabase
    .from('client_users')
    .select('role')
    .eq('client_id', req.params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (memErr) return res.status(500).json({ error: memErr.message });
  if (!membership) return res.status(403).json({ error: 'Forbidden' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  // Look up user by email via Supabase admin API
  const { data: userList, error: lookupErr } = await supabase.auth.admin.listUsers();
  if (lookupErr) return res.status(500).json({ error: lookupErr.message });

  const target = userList.users.find(u => u.email === email);
  if (!target) return res.status(404).json({ error: 'No user found with that email' });

  const { data, error } = await supabase
    .from('client_users')
    .insert({ client_id: req.params.id, user_id: target.id, role: 'member' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/clients/:id/users/:userId — remove a member ──
router.delete('/clients/:id/users/:userId', async (req, res) => {
  const user = await getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Verify caller is an owner of this client
  const { data: membership, error: memErr } = await supabase
    .from('client_users')
    .select('role')
    .eq('client_id', req.params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (memErr) return res.status(500).json({ error: memErr.message });
  if (!membership || membership.role !== 'owner') return res.status(403).json({ error: 'Forbidden — owner role required' });

  const { error } = await supabase
    .from('client_users')
    .delete()
    .eq('client_id', req.params.id)
    .eq('user_id', req.params.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;