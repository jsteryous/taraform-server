const cron = require('node-cron');
const supabase = require('./supabase');
const { sendSMS, renderTemplate, randomDelay } = require('./sms');
const { scheduleFollowUps, getDueFollowUps, markFollowUpSent } = require('./followup');

const DAILY_LIMIT    = 50;
const BUSINESS_START = 8;   // 8am
const BUSINESS_END   = 17;  // 5pm

// ── Is it currently within business hours? ───────────────────
function isBusinessHours() {
  const now = new Date();
  const day  = now.getDay();   // 0 = Sun, 6 = Sat
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= BUSINESS_START && hour < BUSINESS_END;
}

// ── Fetch new contacts eligible for Touch 1 ──────────────────
async function getNewContacts(limit) {
  const { data, error } = await supabase
    .from('property_crm_contacts')
    .select('id, firstName, lastName, phones, propertyAddresses, ownerAddress, county, sms_status')
    .eq('sms_status', 'eligible')
    .not('phones', 'is', null)
    .limit(limit);

  if (error) {
    console.error('Failed to fetch new contacts:', error.message);
    return [];
  }

  // Only contacts that have at least one phone number
  return (data || []).filter(c => c.phones?.length > 0);
}

// ── Fetch active Touch 1 template ────────────────────────────
async function getTemplate(touchNumber) {
  const { data, error } = await supabase
    .from('sms_templates')
    .select('id, body')
    .eq('touch_number', touchNumber)
    .eq('active', true)
    .limit(1)
    .single();

  if (error) {
    console.error(`Failed to fetch touch ${touchNumber} template:`, error.message);
    return null;
  }

  return data;
}

// ── Main daily send job ───────────────────────────────────────
async function runDailyJob() {
  if (!isBusinessHours()) {
    console.log('Outside business hours — skipping send');
    return;
  }

  console.log('Running daily SMS job...');

  let sentToday = 0;

  // ── Step 1: Send due follow-ups first ───────────────────────
  const followUps = await getDueFollowUps();
  console.log(`${followUps.length} follow-ups due today`);

  for (const item of followUps) {
    if (sentToday >= DAILY_LIMIT) break;

    const contact  = item.property_crm_contacts;
    const phone    = contact.phones[0];
    const template = await getTemplate(item.touch_number);

    if (!template) {
      console.warn(`No active template for touch ${item.touch_number} — skipping`);
      continue;
    }

    const body = renderTemplate(template.body, contact);

    await randomDelay();

    const { success } = await sendSMS({
      contactId:  contact.id,
      to:         phone,
      body,
      templateId: template.id,
    });

    if (success) {
      await markFollowUpSent(item.id);
      sentToday++;
      console.log(`Follow-up touch ${item.touch_number} sent to contact ${contact.id} (${sentToday}/${DAILY_LIMIT})`);
    }
  }

  // ── Step 2: Fill remaining slots with new contacts ──────────
  const remaining = DAILY_LIMIT - sentToday;
  if (remaining <= 0) {
    console.log('Daily limit reached from follow-ups alone');
    return;
  }

  const newContacts = await getNewContacts(remaining);
  const touch1Template = await getTemplate(1);

  if (!touch1Template) {
    console.error('No active Touch 1 template found — cannot send new outreach');
    return;
  }

  console.log(`Sending Touch 1 to ${newContacts.length} new contacts`);

  for (const contact of newContacts) {
    if (sentToday >= DAILY_LIMIT) break;

    const phone = contact.phones[0];
    const body  = renderTemplate(touch1Template.body, contact);

    await randomDelay();

    const { success } = await sendSMS({
      contactId:  contact.id,
      to:         phone,
      body,
      templateId: touch1Template.id,
    });

    if (success) {
      // Schedule the 7/30/180-day follow-up cadence
      await scheduleFollowUps(contact.id, new Date());
      sentToday++;
      console.log(`Touch 1 sent to ${contact.firstName} ${contact.lastName} (${sentToday}/${DAILY_LIMIT})`);
    }
  }

  console.log(`Daily job complete — ${sentToday} messages sent`);
}

// ── Cron: run every 10 minutes during business hours ─────────
// The randomDelay inside runDailyJob naturally spreads sends
// We track daily count via sms_message_count to avoid re-runs
cron.schedule('*/10 * * * *', () => {
  runDailyJob().catch(err => console.error('Scheduler error:', err));
});

console.log('Scheduler initialized — runs every 10 minutes, sends during business hours only');

module.exports = { runDailyJob };