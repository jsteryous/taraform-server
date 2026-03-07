const cron = require('node-cron');
const supabase = require('./supabase');
const { sendSMS, renderTemplate, randomDelay } = require('./sms');
const { scheduleFollowUps, getDueFollowUps, markFollowUpSent } = require('./followup');

const DAILY_LIMIT_PER_CLIENT = 50;
const BUSINESS_START         = 8;
const BUSINESS_END           = 17;

function isBusinessHours() {
  const now  = new Date();
  const day  = now.getDay();
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= BUSINESS_START && hour < BUSINESS_END;
}

// ── Fetch all clients ─────────────────────────────────────────
async function getAllClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, twilio_number');

  if (error) {
    console.error('Failed to fetch clients:', error.message);
    return [];
  }
  return data || [];
}

async function getNewContacts(clientId, limit) {
  const { data, error } = await supabase
    .from('property_crm_contacts')
    .select('id, first_name, last_name, phones, property_addresses, owner_address, county, sms_status, client_id')
    .eq('client_id', clientId)
    .eq('sms_status', 'eligible')
    .not('phones', 'is', null)
    .limit(limit);

  if (error) {
    console.error(`Failed to fetch new contacts for client ${clientId}:`, error.message);
    return [];
  }
  return (data || []).filter(c => c.phones?.length > 0);
}

async function getTemplate(clientId, touchNumber) {
  const { data, error } = await supabase
    .from('sms_templates')
    .select('id, body')
    .eq('client_id', clientId)
    .eq('touch_number', touchNumber)
    .eq('active', true)
    .limit(1)
    .single();

  if (error) {
    console.error(`Failed to fetch touch ${touchNumber} template for client ${clientId}:`, error.message);
    return null;
  }
  return data;
}

async function isAutomationPaused(clientId) {
  const { data } = await supabase
    .from('sms_settings')
    .select('value')
    .eq('key', 'automation_paused')
    .eq('client_id', clientId)
    .single();
  return data?.value === 'true';
}

// ── Run the daily job for a single client ─────────────────────
async function runClientJob(clientId, clientName, twilioNumber) {
  if (await isAutomationPaused(clientId)) {
    console.log(`[${clientName}] Automation paused — skipping`);
    return;
  }

  console.log(`[${clientName}] Running daily SMS job...`);
  let sentToday = 0;

  // Resolve which "from" number to use for this client
  const fromNumber = twilioNumber || process.env.TWILIO_PHONE_NUMBER;

  // Follow-ups first
  const followUps = await getDueFollowUps(clientId);
  console.log(`[${clientName}] ${followUps.length} follow-ups due today`);

  for (const item of followUps) {
    if (sentToday >= DAILY_LIMIT_PER_CLIENT) break;

    const contact  = item.property_crm_contacts;
    const phone    = contact.phones[0];
    const template = await getTemplate(clientId, item.touch_number);

    if (!template) {
      console.warn(`[${clientName}] No active template for touch ${item.touch_number} — skipping`);
      continue;
    }

    const body = renderTemplate(template.body, contact);
    await randomDelay();

    const { success } = await sendSMS({
      contactId:  contact.id,
      to:         phone,
      body,
      from:       fromNumber,
      templateId: template.id,
      clientId,
    });

    if (success) {
      await markFollowUpSent(item.id);
      sentToday++;
      console.log(`[${clientName}] Follow-up touch ${item.touch_number} → contact ${contact.id} (${sentToday}/${DAILY_LIMIT_PER_CLIENT})`);
    }
  }

  // Fill remaining slots with new contacts (Touch 1)
  const remaining = DAILY_LIMIT_PER_CLIENT - sentToday;
  if (remaining <= 0) {
    console.log(`[${clientName}] Daily limit reached from follow-ups alone`);
    return;
  }

  const newContacts    = await getNewContacts(clientId, remaining);
  const touch1Template = await getTemplate(clientId, 1);

  if (!touch1Template) {
    console.error(`[${clientName}] No active Touch 1 template — cannot send new outreach`);
    return;
  }

  console.log(`[${clientName}] Sending Touch 1 to ${newContacts.length} new contacts`);

  for (const contact of newContacts) {
    if (sentToday >= DAILY_LIMIT_PER_CLIENT) break;

    const phone = contact.phones[0];
    const body  = renderTemplate(touch1Template.body, contact);
    await randomDelay();

    const { success } = await sendSMS({
      contactId:  contact.id,
      to:         phone,
      body,
      from:       fromNumber,
      templateId: touch1Template.id,
      clientId,
    });

    if (success) {
      await scheduleFollowUps(contact.id, clientId, new Date());
      sentToday++;
      console.log(`[${clientName}] Touch 1 → ${contact.first_name} ${contact.last_name} (${sentToday}/${DAILY_LIMIT_PER_CLIENT})`);
    }
  }

  console.log(`[${clientName}] Job complete — ${sentToday} messages sent`);
}

// ── Main daily job — runs for every client ────────────────────
async function runDailyJob() {
  if (!isBusinessHours()) {
    console.log('Outside business hours — skipping send');
    return;
  }

  const clients = await getAllClients();

  if (!clients.length) {
    console.log('No clients found — nothing to do');
    return;
  }

  console.log(`Running daily job for ${clients.length} client(s)...`);

  for (const c of clients) {
    await runClientJob(c.id, c.name, c.twilio_number);
  }

  console.log('All client jobs complete');
}

cron.schedule('*/10 * * * *', () => {
  runDailyJob().catch(err => console.error('Scheduler error:', err));
});

console.log('Scheduler initialized — runs every 10 minutes, sends during business hours only');

module.exports = { runDailyJob };