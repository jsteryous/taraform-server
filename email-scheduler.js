const cron    = require('node-cron');
const supabase = require('./supabase');
const { sendEmail, renderEmailTemplate, getTokenRecord } = require('./email');

const EMAIL_BUSINESS_START = 8.5;  // 8:30 AM
const EMAIL_BUSINESS_END   = 17.5; // 5:30 PM

function isEmailBusinessHours() {
  const now   = new Date();
  const day   = now.getDay();
  const hours = now.getHours() + now.getMinutes() / 60;
  return day >= 1 && day <= 5 && hours >= EMAIL_BUSINESS_START && hours < EMAIL_BUSINESS_END;
}

// Random delay between 5-15 minutes (spread throughout the day)
function emailDelay() {
  const ms = (5 + Math.random() * 10) * 60 * 1000;
  return new Promise(r => setTimeout(r, ms));
}

async function getEmailSetting(clientId, key) {
  const { data } = await supabase
    .from('sms_settings')
    .select('value')
    .eq('key', key)
    .eq('client_id', clientId)
    .single();
  return data?.value ?? null;
}

async function getEmailsSentToday(clientId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { count } = await supabase
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('direction', 'out')
    .eq('status', 'sent')
    .gte('sent_at', today.toISOString());
  return count || 0;
}

async function getEligibleEmailContacts(clientId, limit) {
  const { data, error } = await supabase
    .from('property_crm_contacts')
    .select('id, first_name, last_name, email, phones, county, property_addresses, tax_map_ids, email_status')
    .eq('client_id', clientId)
    .eq('email_status', 'eligible')
    .not('email', 'is', null)
    .neq('email', '')
    .limit(limit * 3); // fetch extra to filter nulls

  if (error) { console.error('Email contacts fetch error:', error.message); return []; }
  return (data || []).filter(c => c.email).slice(0, limit);
}

async function getEmailTemplate(clientId, touchNumber) {
  const { data, error } = await supabase
    .from('email_templates')
    .select('id, name, subject, body')
    .eq('client_id', clientId)
    .eq('touch_number', touchNumber)
    .limit(1)
    .single();
  if (error) return null;
  return data;
}

async function runEmailJob(clientId, clientName) {
  // Check if email automation is enabled
  const enabled = await getEmailSetting(clientId, 'email_automation_enabled');
  if (enabled !== 'true') {
    console.log(`[${clientName}] Email automation disabled — skipping`);
    return;
  }

  // Check token exists
  const token = await getTokenRecord(clientId);
  if (!token) {
    console.log(`[${clientName}] No Outlook token — skipping email job`);
    return;
  }

  // Get daily limit setting (default 25)
  const limitSetting = await getEmailSetting(clientId, 'email_daily_limit');
  const dailyLimit   = parseInt(limitSetting || '25', 10);

  // Check how many already sent today
  const sentToday = await getEmailsSentToday(clientId);
  const remaining = dailyLimit - sentToday;

  if (remaining <= 0) {
    console.log(`[${clientName}] Email daily limit reached (${sentToday}/${dailyLimit})`);
    return;
  }

  // Get touch 1 template
  const template = await getEmailTemplate(clientId, 1);
  if (!template) {
    console.log(`[${clientName}] No email touch 1 template — skipping`);
    return;
  }

  // Get eligible contacts
  const contacts = await getEligibleEmailContacts(clientId, remaining);
  if (!contacts.length) {
    console.log(`[${clientName}] No eligible email contacts`);
    return;
  }

  console.log(`[${clientName}] Sending ${contacts.length} emails (${sentToday} already sent today, limit ${dailyLimit})`);

  for (const contact of contacts) {
    const subject = renderEmailTemplate(template.subject, contact);
    const body    = renderEmailTemplate(template.body,    contact);

    try {
      const { success } = await sendEmail({
        clientId,
        contactId:  contact.id,
        to:         contact.email,
        subject,
        body,
        templateId: template.id,
      });
      if (success) {
        console.log(`[${clientName}] Email → ${contact.first_name} ${contact.last_name} <${contact.email}>`);
      }
    } catch (e) {
      console.error(`[${clientName}] Email failed for ${contact.id}:`, e.message);
    }

    // Random delay between sends — spread throughout day
    await emailDelay();
  }

  console.log(`[${clientName}] Email job complete`);
}

async function runAllEmailJobs() {
  if (!isEmailBusinessHours()) {
    return; // silent skip outside hours
  }

  const { data: clients } = await supabase.from('clients').select('id, name');
  if (!clients?.length) return;

  for (const c of clients) {
    await runEmailJob(c.id, c.name);
  }
}

// Run every 15 minutes — checks hours internally
cron.schedule('*/15 * * * *', () => {
  runAllEmailJobs().catch(err => console.error('Email scheduler error:', err));
});

console.log('Email scheduler initialized — runs every 15 min during business hours');

module.exports = { runAllEmailJobs };