const cron     = require('node-cron');
const supabase = require('./supabase');
const { renderEmailTemplate, getTokenRecord, getValidAccessToken } = require('./email');
const { emailQueue } = require('./queues');

const EMAIL_BUSINESS_START = 8.5;
const EMAIL_BUSINESS_END   = 17.5;
const INTER_EMAIL_MIN_MS   = 3 * 60 * 1000;  // 3 min
const INTER_EMAIL_MAX_MS   = 8 * 60 * 1000;  // 8 min

function randomInterEmailDelay() {
  return Math.floor(INTER_EMAIL_MIN_MS + Math.random() * (INTER_EMAIL_MAX_MS - INTER_EMAIL_MIN_MS));
}

// Check if a contact has all fields used in a template
function hasRequiredFields(templateStr, contact) {
  const used = templateStr.match(/{{(\w+)}}/g) || [];
  const fieldMap = {
    acreage:         contact.acreage,
    propertyAddress: (contact.property_addresses || [])[0],
    propertyStreet:  (contact.property_addresses || [])[0],
    ownerAddress:    contact.owner_address,
    ownerStreet:     contact.owner_address,
    taxMapId:        (contact.tax_map_ids || [])[0],
    county:          contact.county,
  };
  for (const tag of used) {
    const key = tag.replace(/{{|}}/g, '');
    if (key in fieldMap && !fieldMap[key]) return false;
  }
  return true;
}

function isEmailBusinessHours() {
  const eastern = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const now     = new Date(eastern);
  const day     = now.getDay();
  const hours   = now.getHours() + now.getMinutes() / 60;
  return day >= 1 && day <= 5 && hours >= EMAIL_BUSINESS_START && hours < EMAIL_BUSINESS_END;
}

async function getEmailSetting(clientId, key) {
  const { data } = await supabase.from('sms_settings').select('value')
    .eq('key', key).eq('client_id', clientId).single();
  return data?.value ?? null;
}

// Count emails already sent today PLUS jobs already queued-but-unsent (status:'queued').
// This prevents over-committing the daily limit between cron ticks when BullMQ jobs
// have been enqueued but not yet processed by the worker.
async function getEmailsCommittedToday(clientId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [{ count: sent }, { count: queued }] = await Promise.all([
    supabase.from('email_messages')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).eq('direction', 'out').eq('status', 'sent')
      .gte('sent_at', today.toISOString()),
    supabase.from('email_followup_queue')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).eq('status', 'queued'),
  ]);
  return (sent || 0) + (queued || 0);
}

async function getEmailTemplate(clientId, touchNumber) {
  const { data } = await supabase.from('email_templates')
    .select('id, name, subject, body')
    .eq('client_id', clientId).eq('touch_number', touchNumber).limit(1).single();
  return data || null;
}

async function getDueFollowUps(clientId, limit) {
  const { data } = await supabase.from('email_followup_queue')
    .select('id, contact_id, touch_number')
    .eq('client_id', clientId).eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true }).limit(limit);
  return data || [];
}

async function getContact(contactId) {
  const { data } = await supabase.from('property_crm_contacts')
    .select('id, first_name, last_name, email, phones, county, property_addresses, owner_address, tax_map_ids, acreage, email_status')
    .eq('id', contactId).single();
  return data;
}

// ── Poll Outlook inbox for replies ────────────────────────────
async function checkForReplies(clientId, clientName) {
  try {
    const accessToken = await getValidAccessToken(clientId);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=200&$select=from,receivedDateTime&$orderby=receivedDateTime desc`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return;
    const { value: messages } = await res.json();
    if (!messages?.length) return;

    const inboxEmails = new Set(
      messages.map(m => m.from?.emailAddress?.address?.toLowerCase()).filter(Boolean)
    );

    // Check both pending and queued rows — a queued job hasn't sent yet so we can still cancel
    const { data: active } = await supabase.from('email_followup_queue')
      .select('contact_id').eq('client_id', clientId).in('status', ['pending', 'queued']);
    if (!active?.length) return;

    const contactIds = [...new Set(active.map(p => p.contact_id))];
    const { data: contacts } = await supabase.from('property_crm_contacts')
      .select('id, email, first_name, last_name').in('id', contactIds);

    for (const contact of (contacts || [])) {
      if (inboxEmails.has(contact.email?.toLowerCase())) {
        console.log(`[${clientName}] Reply from ${contact.first_name} ${contact.last_name} — cancelling follow-ups`);
        await supabase.from('email_followup_queue')
          .update({ status: 'cancelled' })
          .eq('contact_id', contact.id).eq('client_id', clientId)
          .in('status', ['pending', 'queued']);
        await supabase.from('property_crm_contacts')
          .update({ email_status: 'replied', updated_at: new Date().toISOString() })
          .eq('id', contact.id);
      }
    }
  } catch (e) {
    console.error(`[${clientName}] Reply check error:`, e.message);
  }
}

// ── Get new verified contacts not yet emailed ─────────────────
async function getNewEmailContacts(clientId, limit) {
  const { data } = await supabase.from('property_crm_contacts')
    .select('id, first_name, last_name, email, phones, county, property_addresses, owner_address, tax_map_ids, acreage')
    .eq('client_id', clientId).eq('email_status', 'verified')
    .not('email', 'is', null).neq('email', '').limit(limit * 4);
  if (!data?.length) return [];

  // Exclude contacts already in the queue (any status) or already sent to
  const [{ data: queued }, { data: sent }] = await Promise.all([
    supabase.from('email_followup_queue').select('contact_id').eq('client_id', clientId),
    supabase.from('email_messages').select('contact_id').eq('client_id', clientId).eq('direction', 'out'),
  ]);
  const exclude = new Set([
    ...(queued || []).map(q => q.contact_id),
    ...(sent   || []).map(m => m.contact_id),
  ]);
  return data.filter(c => !exclude.has(c.id)).slice(0, limit);
}

const JOB_OPTIONS = {
  attempts: 3,
  backoff:  { type: 'exponential', delay: 5 * 60 * 1000 },
  removeOnComplete: { count: 500 },
  removeOnFail:     { count: 200 },
};

// ── Main job ──────────────────────────────────────────────────
async function runEmailJob(clientId, clientName) {
  const enabled = await getEmailSetting(clientId, 'email_automation_enabled');
  if (enabled !== 'true') return;

  const token = await getTokenRecord(clientId);
  if (!token) { console.log(`[${clientName}] No Outlook token`); return; }

  const dailyLimit = parseInt(await getEmailSetting(clientId, 'email_daily_limit') || '25', 10);
  const committed  = await getEmailsCommittedToday(clientId);
  let remaining    = dailyLimit - committed;
  if (remaining <= 0) { console.log(`[${clientName}] Daily limit reached (${committed}/${dailyLimit})`); return; }

  console.log(`[${clientName}] Email job — ${remaining} slots available, checking replies first`);

  // Step 1: Check for replies
  await checkForReplies(clientId, clientName);

  let enqueued = 0;
  let cumulativeDelay = 0;

  // Step 2: Enqueue due follow-ups
  const followUps = await getDueFollowUps(clientId, remaining);
  for (const item of followUps) {
    if (enqueued >= remaining) break;

    const contact = await getContact(item.contact_id);
    if (!contact?.email || ['replied', 'do_not_email'].includes(contact.email_status)) {
      await supabase.from('email_followup_queue').update({ status: 'skipped' }).eq('id', item.id);
      continue;
    }
    const template = await getEmailTemplate(clientId, item.touch_number);
    if (!template) {
      await supabase.from('email_followup_queue').update({ status: 'skipped' }).eq('id', item.id);
      continue;
    }
    if (!hasRequiredFields(template.subject + ' ' + template.body, contact)) {
      console.log(`[${clientName}] Skipping ${contact.first_name} — missing fields for Touch ${item.touch_number}`);
      await supabase.from('email_followup_queue').update({ status: 'skipped' }).eq('id', item.id);
      continue;
    }

    // Mark as 'queued' before adding to BullMQ so the next cron tick doesn't re-discover it
    await supabase.from('email_followup_queue').update({ status: 'queued' }).eq('id', item.id);

    await emailQueue.add('send-email', {
      clientId,
      contactId:   contact.id,
      to:          contact.email,
      subject:     renderEmailTemplate(template.subject, contact),
      body:        renderEmailTemplate(template.body,    contact),
      templateId:  template.id,
      touchNumber: item.touch_number,
      queueRowId:  item.id,
    }, { ...JOB_OPTIONS, delay: cumulativeDelay });

    console.log(`[${clientName}] Queued Touch ${item.touch_number} → ${contact.first_name} ${contact.last_name} (sends in ~${Math.round(cumulativeDelay / 60000)}min)`);
    cumulativeDelay += randomInterEmailDelay();
    enqueued++;
  }

  // Step 3: Enqueue Touch 1 to new verified contacts
  remaining -= enqueued;
  if (remaining <= 0) { console.log(`[${clientName}] Limit reached after follow-ups`); return; }

  const touch1 = await getEmailTemplate(clientId, 1);
  if (!touch1) { console.log(`[${clientName}] No Touch 1 template`); return; }

  const newContacts    = await getNewEmailContacts(clientId, remaining);
  const touch1Combined = touch1.subject + ' ' + touch1.body;

  for (const contact of newContacts) {
    if (enqueued >= remaining + enqueued) break; // reached the original remaining cap

    if (!hasRequiredFields(touch1Combined, contact)) {
      console.log(`[${clientName}] Skipping ${contact.first_name} ${contact.last_name} — missing fields`);
      continue;
    }

    // Insert a Touch 1 row as 'queued' immediately so this contact is excluded
    // from getNewEmailContacts on the next cron tick (any row in the queue excludes it)
    const { data: queueRow } = await supabase.from('email_followup_queue').insert({
      contact_id:    contact.id,
      client_id:     clientId,
      touch_number:  1,
      scheduled_for: new Date().toISOString(),
      status:        'queued',
    }).select('id').single();

    await emailQueue.add('send-email', {
      clientId,
      contactId:   contact.id,
      to:          contact.email,
      subject:     renderEmailTemplate(touch1.subject, contact),
      body:        renderEmailTemplate(touch1.body,    contact),
      templateId:  touch1.id,
      touchNumber: 1,
      queueRowId:  queueRow?.id ?? null,
    }, { ...JOB_OPTIONS, delay: cumulativeDelay });

    console.log(`[${clientName}] Queued Touch 1 → ${contact.first_name} ${contact.last_name} (sends in ~${Math.round(cumulativeDelay / 60000)}min)`);
    cumulativeDelay += randomInterEmailDelay();
    enqueued++;
  }

  console.log(`[${clientName}] Email job complete — ${enqueued} jobs queued`);
}

async function runAllEmailJobs() {
  if (!isEmailBusinessHours()) return;
  const { data: clients } = await supabase.from('clients').select('id, name');
  if (!clients?.length) return;
  for (const c of clients) await runEmailJob(c.id, c.name);
}

cron.schedule('*/15 * * * *', () => {
  runAllEmailJobs().catch(err => console.error('Email scheduler error:', err));
});

console.log('Email scheduler — discovery every 15 min, sending via BullMQ worker');

module.exports = { runAllEmailJobs };
