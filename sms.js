const twilio = require('twilio');
const supabase = require('./supabase');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Send a single SMS and log it ─────────────────────────────
async function sendSMS({ contactId, to, body, templateId }) {
  let twilioSid = null;
  let status = 'failed';

  try {
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });

    twilioSid = message.sid;
    status = 'sent';
    console.log(`SMS sent to ${to} — SID: ${twilioSid}`);
  } catch (err) {
    console.error(`SMS failed to ${to}:`, err.message);
  }

  // Log to sms_messages regardless of success/failure
  const { error: logError } = await supabase.from('sms_messages').insert({
    contact_id:  contactId,
    direction:   'out',
    body,
    twilio_sid:  twilioSid,
    status,
    template_id: templateId || null,
    sent_at:     new Date().toISOString(),
  });

  if (logError) console.error('Failed to log outbound SMS:', logError.message);

  // Update contact stats
  if (status === 'sent') {
    await supabase
      .from('property_crm_contacts')
      .update({
        sms_status:        'contacted',
        last_sms_at:       new Date().toISOString(),
        sms_message_count: supabase.rpc('increment_sms_count', { contact_id: contactId }),
      })
      .eq('id', contactId);
  }

  return { success: status === 'sent', twilioSid };
}

// ── Substitute template variables ────────────────────────────
function renderTemplate(body, contact) {
  return body
    .replace(/{{firstName}}/g,       contact.firstName       || '')
    .replace(/{{lastName}}/g,        contact.lastName        || '')
    .replace(/{{propertyAddress}}/g, (contact.propertyAddresses || [])[0] || '')
    .replace(/{{city}}/g,            extractCity(contact)    || '')
    .replace(/{{county}}/g,          contact.county          || '');
}

function extractCity(contact) {
  // Try to pull city from ownerAddress "123 Main St, Greenville, SC 29601"
  if (!contact.ownerAddress) return '';
  const parts = contact.ownerAddress.split(',');
  return parts.length >= 2 ? parts[1].trim() : '';
}

// ── Random delay helper (30–90 seconds) ──────────────────────
function randomDelay() {
  const ms = (Math.floor(Math.random() * 61) + 30) * 1000; // 30,000–90,000ms
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Send an alert SMS to yourself ────────────────────────────
async function sendAlert(message) {
  try {
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   process.env.ALERT_PHONE_NUMBER,
    });
    console.log('Alert sent to owner');
  } catch (err) {
    console.error('Alert SMS failed:', err.message);
  }
}

module.exports = { sendSMS, renderTemplate, randomDelay, sendAlert };