const twilio = require('twilio');
const supabase = require('./supabase');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSMS({ contactId, to, body, templateId, clientId, from }) {
  let twilioSid = null;
  let status = 'failed';

  // Use per-client number if provided, fall back to env default
  const fromNumber = from || process.env.TWILIO_PHONE_NUMBER;

  try {
    const message = await client.messages.create({
      body,
      from: fromNumber,
      to,
      // Ask Twilio to POST delivery status back to your webhook
      statusCallback: `${process.env.SERVER_URL}/webhook/status`,
    });
    twilioSid = message.sid;
    status = 'sent';
    console.log(`SMS sent to ${to} from ${fromNumber} — SID: ${twilioSid}`);
  } catch (err) {
    console.error(`SMS failed to ${to}:`, err.message);
  }

  const { error: logError } = await supabase.from('sms_messages').insert({
    contact_id:  contactId,
    client_id:   clientId || null,
    direction:   'out',
    body,
    twilio_sid:  twilioSid,
    status,
    template_id: templateId || null,
    sent_at:     new Date().toISOString(),
  });

  if (logError) console.error('Failed to log outbound SMS:', logError.message);

  if (status === 'sent') {
    const { data: contact } = await supabase
      .from('property_crm_contacts')
      .select('sms_message_count')
      .eq('id', contactId)
      .single();

    await supabase
      .from('property_crm_contacts')
      .update({
        sms_status:        'contacted',
        last_sms_at:       new Date().toISOString(),
        sms_message_count: (contact?.sms_message_count || 0) + 1,
      })
      .eq('id', contactId);
  }

  return { success: status === 'sent', twilioSid };
}

function renderTemplate(body, contact) {
  let result = body
    .replace(/{{firstName}}/g,       contact.first_name              || '')
    .replace(/{{lastName}}/g,        contact.last_name               || '')
    .replace(/{{propertyAddress}}/g, (contact.property_addresses || [])[0] || '')
    .replace(/{{city}}/g,            extractCity(contact)            || '')
    .replace(/{{county}}/g,          contact.county                  || '');

  // Render custom fields
  const custom = contact.custom_fields || {};
  for (const [key, value] of Object.entries(custom)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value || '');
  }

  return result;
}

function extractCity(contact) {
  if (!contact.owner_address) return '';
  const parts = contact.owner_address.split(',');
  return parts.length >= 2 ? parts[1].trim() : '';
}

function randomDelay() {
  const ms = (Math.floor(Math.random() * 61) + 30) * 1000;
  return new Promise(resolve => setTimeout(resolve, ms));
}

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