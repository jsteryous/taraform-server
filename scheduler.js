const cron     = require('node-cron');
const supabase = require('./supabase');
const { sendSMS, renderTemplate, randomDelay } = require('./sms');
const { scheduleFollowUps, getDueFollowUps, markFollowUpSent } = require('./followup');

// Eastern time — always used regardless of server timezone
function getNowEastern() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isBusinessHoursFor(startHour, endHour) {
  const now  = getNowEastern();
  const day  = now.getDay();
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= startHour && hour < endHour;
}

// ── Load all settings for a client in one query ───────────────
async function getClientSettings(clientId) {
  const { data, error } = await supabase
    .from('sms_settings')
    .select('key, value')
    .eq('client_id', clientId);

  if (error || !data) return null;

  const map = {};
  data.forEach(row => { map[row.key] = row.value; });

  return {
    paused:     map['automation_paused'] === 'true',
    startHour:  parseInt(map['send_start_hour']  ?? '8'),
    endHour:    parseInt(map['send_end_hour']    ?? '17'),
    dailyLimit: parseInt(map['daily_limit']      ?? '50'),
  };
}

async function getAllClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, twilio_number');

  if (error) { console.error('Failed to fetch clients:', error.message); return []; }
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

  if (error) { console.error(`Failed to fetch contacts for client ${clientId}:`, error.message); return []; }
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

  if (error) { console.error(`No active touch ${touchNumber} template for client ${clientId}`); return null; }
  return data;
}

// ── Run job for a single client ───────────────────────────────
async function runClientJob(client) {
  const settings = await getClientSettings(client.id);

  if (!settings) {
    console.log(`[${client.name}] Could not load settings — skipping`);
    return;
  }

  if (settings.paused) {
    console.log(`[${client.name}] Paused — skipping`);
    return;
  }

  if (!isBusinessHoursFor(settings.startHour, settings.endHour)) {
    console.log(`[${client.name}] Outside send window (${settings.startHour}:00–${settings.endHour}:00 ET) — skipping`);
    return;
  }

  console.log(`[${client.name}] Running job (limit: ${settings.dailyLimit}/day, window: ${settings.startHour}–${settings.endHour} ET)`);

  const fromNumber = client.twilio_number || process.env.TWILIO_PHONE_NUMBER;
  let sentToday = 0;

  // ── Follow-ups first ────────────────────────────────────────
  const followUps = await getDueFollowUps(client.id);
  console.log(`[${client.name}] ${followUps.length} follow-ups due`);

  for (const item of followUps) {
    if (sentToday >= settings.dailyLimit) break;

    const contact  = item.property_crm_contacts;
    const template = await getTemplate(client.id, item.touch_number);
    if (!template) { console.warn(`[${client.name}] No active template for touch ${item.touch_number}`); continue; }

    const body = renderTemplate(template.body, contact);
    await randomDelay();

    const { success } = await sendSMS({
      contactId:  contact.id,
      to:         contact.phones[0],
      body,
      from:       fromNumber,
      templateId: template.id,
      clientId:   client.id,
    });

    if (success) {
      await markFollowUpSent(item.id);
      sentToday++;
      console.log(`[${client.name}] Follow-up touch ${item.touch_number} → ${contact.first_name} ${contact.last_name} (${sentToday}/${settings.dailyLimit})`);
    }
  }

  // ── New contacts (Touch 1) ───────────────────────────────────
  const remaining = settings.dailyLimit - sentToday;
  if (remaining <= 0) { console.log(`[${client.name}] Daily limit reached`); return; }

  const newContacts    = await getNewContacts(client.id, remaining);
  const touch1Template = await getTemplate(client.id, 1);

  if (!touch1Template) { console.error(`[${client.name}] No active Touch 1 template`); return; }

  console.log(`[${client.name}] Sending Touch 1 to ${newContacts.length} new contacts`);

  for (const contact of newContacts) {
    if (sentToday >= settings.dailyLimit) break;

    const body = renderTemplate(touch1Template.body, contact);
    await randomDelay();

    const { success } = await sendSMS({
      contactId:  contact.id,
      to:         contact.phones[0],
      body,
      from:       fromNumber,
      templateId: touch1Template.id,
      clientId:   client.id,
    });

    if (success) {
      await scheduleFollowUps(contact.id, client.id, new Date());
      sentToday++;
      console.log(`[${client.name}] Touch 1 → ${contact.first_name} ${contact.last_name} (${sentToday}/${settings.dailyLimit})`);
    }
  }

  console.log(`[${client.name}] Done — ${sentToday} sent`);
}

// ── Main job ──────────────────────────────────────────────────
async function runDailyJob() {
  const clients = await getAllClients();
  if (!clients.length) { console.log('No clients'); return; }

  console.log(`Scheduler tick — checking ${clients.length} client(s)`);
  for (const c of clients) {
    await runClientJob(c);
  }
}

cron.schedule('*/10 * * * *', () => {
  runDailyJob().catch(err => console.error('Scheduler error:', err));
});

console.log('Scheduler initialized — runs every 10 min, per-client windows in Eastern time');
module.exports = { runDailyJob };