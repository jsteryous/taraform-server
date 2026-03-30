const cron    = require('node-cron');
const supabase = require('./supabase');
const { sendEmail, renderEmailTemplate, getTokenRecord, getValidAccessToken } = require('./email');

const EMAIL_BUSINESS_START = 8.5;
const EMAIL_BUSINESS_END   = 17.5;
const TOUCH_DELAY_DAYS     = 7;
const MAX_TOUCHES          = 4;

function isEmailBusinessHours() {
  const now   = new Date();
  const day   = now.getDay();
  const hours = now.getHours() + now.getMinutes() / 60;
  return day >= 1 && day <= 5 && hours >= EMAIL_BUSINESS_START && hours < EMAIL_BUSINESS_END;
}

function emailDelay() {
  return new Promise(r => setTimeout(r, (3 + Math.random() * 8) * 60 * 1000));
}

async function getEmailSetting(clientId, key) {
  const { data } = await supabase.from('sms_settings').select('value')
    .eq('key', key).eq('client_id', clientId).single();
  return data?.value ?? null;
}

async function getEmailsSentToday(clientId) {
  const today = new Date(); today.setHours(0,0,0,0);
  const { count } = await supabase.from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('direction', 'out').eq('status', 'sent')
    .gte('sent_at', today.toISOString());
  return count || 0;
}

async function getEmailTemplate(clientId, touchNumber) {
  const { data } = await supabase.from('email_templates')
    .select('id, name, subject, body')
    .eq('client_id', clientId).eq('touch_number', touchNumber).limit(1).single();
  return data || null;
}

async function queueNextTouch(contactId, clientId, currentTouch) {
  const nextTouch = currentTouch + 1;
  if (nextTouch > MAX_TOUCHES) return;
  const template = await getEmailTemplate(clientId, nextTouch);
  if (!template) return;
  const scheduledFor = new Date();
  scheduledFor.setDate(scheduledFor.getDate() + TOUCH_DELAY_DAYS);
  await supabase.from('email_followup_queue').insert({
    contact_id: contactId, client_id: clientId,
    touch_number: nextTouch, scheduled_for: scheduledFor.toISOString(), status: 'pending',
  });
}

async function cancelFollowUps(contactId, clientId) {
  await supabase.from('email_followup_queue')
    .update({ status: 'cancelled' })
    .eq('contact_id', contactId).eq('client_id', clientId).eq('status', 'pending');
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
    .select('id, first_name, last_name, email, phones, county, property_addresses, tax_map_ids, email_status')
    .eq('id', contactId).single();
  return data;
}

// ── Poll Outlook inbox for replies ────────────────────────────
async function checkForReplies(clientId, clientName) {
  try {
    const accessToken = await getValidAccessToken(clientId);
    const res = await fetch(
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=50&$select=from,receivedDateTime&$orderby=receivedDateTime desc',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return;
    const { value: messages } = await res.json();
    if (!messages?.length) return;

    const inboxEmails = new Set(
      messages.map(m => m.from?.emailAddress?.address?.toLowerCase()).filter(Boolean)
    );

    // Get contacts with pending follow-ups
    const { data: pending } = await supabase.from('email_followup_queue')
      .select('contact_id').eq('client_id', clientId).eq('status', 'pending');
    if (!pending?.length) return;

    const contactIds = [...new Set(pending.map(p => p.contact_id))];
    const { data: contacts } = await supabase.from('property_crm_contacts')
      .select('id, email, first_name, last_name').in('id', contactIds);

    for (const contact of (contacts || [])) {
      if (inboxEmails.has(contact.email?.toLowerCase())) {
        console.log(`[${clientName}] Reply from ${contact.first_name} ${contact.last_name} — cancelling follow-ups`);
        await cancelFollowUps(contact.id, clientId);
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
    .select('id, first_name, last_name, email, phones, county, property_addresses, tax_map_ids')
    .eq('client_id', clientId).eq('email_status', 'verified')
    .not('email', 'is', null).neq('email', '').limit(limit * 4);
  if (!data?.length) return [];

  // Exclude already emailed or queued
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

// ── Main job ──────────────────────────────────────────────────
async function runEmailJob(clientId, clientName) {
  const enabled = await getEmailSetting(clientId, 'email_automation_enabled');
  if (enabled !== 'true') return;

  const token = await getTokenRecord(clientId);
  if (!token) { console.log(`[${clientName}] No Outlook token`); return; }

  const dailyLimit = parseInt(await getEmailSetting(clientId, 'email_daily_limit') || '25', 10);
  const sentToday  = await getEmailsSentToday(clientId);
  let remaining    = dailyLimit - sentToday;
  if (remaining <= 0) { console.log(`[${clientName}] Daily email limit reached`); return; }

  console.log(`[${clientName}] Email job — ${remaining} slots, checking replies first`);

  // Step 1: Check for replies
  await checkForReplies(clientId, clientName);

  // Step 2: Send due follow-ups
  const followUps = await getDueFollowUps(clientId, remaining);
  for (const item of followUps) {
    if (remaining <= 0) break;
    const contact  = await getContact(item.contact_id);
    if (!contact?.email || ['replied','do_not_email'].includes(contact.email_status)) {
      await supabase.from('email_followup_queue').update({ status: 'skipped' }).eq('id', item.id);
      continue;
    }
    const template = await getEmailTemplate(clientId, item.touch_number);
    if (!template) {
      await supabase.from('email_followup_queue').update({ status: 'skipped' }).eq('id', item.id);
      continue;
    }
    try {
      const { success } = await sendEmail({
        clientId, contactId: contact.id, to: contact.email,
        subject: renderEmailTemplate(template.subject, contact),
        body:    renderEmailTemplate(template.body,    contact),
        templateId: template.id,
      });
      if (success) {
        await supabase.from('email_followup_queue').update({ status: 'sent' }).eq('id', item.id);
        await queueNextTouch(contact.id, clientId, item.touch_number);
        remaining--;
        console.log(`[${clientName}] Touch ${item.touch_number} → ${contact.first_name} ${contact.last_name}`);
        await emailDelay();
      }
    } catch (e) { console.error(`[${clientName}] Follow-up failed:`, e.message); }
  }

  // Step 3: Touch 1 to new contacts
  if (remaining <= 0) return;
  const touch1 = await getEmailTemplate(clientId, 1);
  if (!touch1) { console.log(`[${clientName}] No Touch 1 template`); return; }

  const newContacts = await getNewEmailContacts(clientId, remaining);
  for (const contact of newContacts) {
    if (remaining <= 0) break;
    try {
      const { success } = await sendEmail({
        clientId, contactId: contact.id, to: contact.email,
        subject: renderEmailTemplate(touch1.subject, contact),
        body:    renderEmailTemplate(touch1.body,    contact),
        templateId: touch1.id,
      });
      if (success) {
        await queueNextTouch(contact.id, clientId, 1);
        remaining--;
        console.log(`[${clientName}] Touch 1 → ${contact.first_name} ${contact.last_name}`);
        await emailDelay();
      }
    } catch (e) { console.error(`[${clientName}] Touch 1 failed:`, e.message); }
  }
  console.log(`[${clientName}] Email job complete`);
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

console.log('Email scheduler — 4 touches, 7-day gaps, reply detection via Outlook');

module.exports = { runAllEmailJobs };