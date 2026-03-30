const supabase = require('./supabase');

const MS_CLIENT_ID     = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const MS_TENANT_ID     = process.env.MS_TENANT_ID;
const MS_REDIRECT_URI  = process.env.MS_REDIRECT_URI || 'https://taraform-server-production.up.railway.app/auth/microsoft/callback';
const GRAPH_BASE       = 'https://graph.microsoft.com/v1.0';

// ── Token management ──────────────────────────────────────────

async function getTokenRecord(clientId) {
  const { data } = await supabase
    .from('email_tokens')
    .select('*')
    .eq('client_id', clientId)
    .single();
  return data;
}

async function refreshAccessToken(clientId, refreshToken) {
  const params = new URLSearchParams({
    client_id:     MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
    scope:         'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite offline_access',
  });

  const res  = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');

  await supabase.from('email_tokens').upsert({
    client_id:     clientId,
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'client_id' });

  return data.access_token;
}

async function getValidAccessToken(clientId) {
  const record = await getTokenRecord(clientId);
  if (!record) throw new Error('No email account connected for this client');
  const expiresAt = new Date(record.expires_at);
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    return await refreshAccessToken(clientId, record.refresh_token);
  }
  return record.access_token;
}

// ── Template rendering ────────────────────────────────────────

function renderEmailTemplate(template, contact) {
  const vars = {
    firstName:       contact.first_name  || '',
    lastName:        contact.last_name   || '',
    fullName:        `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
    county:          contact.county      || '',
    phone:           (contact.phones || [])[0] || '',
    email:           contact.email       || '',
    propertyAddress: (contact.property_addresses || [])[0] || '',
    taxMapId:        (contact.tax_map_ids || [])[0] || '',
  };
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`{{${k}}}`, 'gi'), v);
  }
  return out;
}

// ── Send one email ────────────────────────────────────────────

async function sendEmail({ clientId, contactId, to, subject, body, templateId }) {
  const accessToken = await getValidAccessToken(clientId);

  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });

  const success = res.status === 202;

  await supabase.from('email_messages').insert({
    contact_id:  contactId,
    client_id:   clientId,
    direction:   'out',
    subject,
    body,
    template_id: templateId || null,
    status:      success ? 'sent' : 'failed',
    sent_at:     new Date().toISOString(),
  });

  if (success) {
    await supabase.from('property_crm_contacts').update({
      email_status:  'contacted',
      last_email_at: new Date().toISOString(),
    }).eq('id', contactId);
  }

  return { success };
}

// ── OAuth helpers ─────────────────────────────────────────────

function getAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id:     MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  MS_REDIRECT_URI,
    scope:         'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite offline_access',
    state:         clientId,
    prompt:        'select_account',
  });
  return `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize?${params}`;
}

async function handleCallback(code, clientId) {
  const params = new URLSearchParams({
    client_id:     MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    code,
    redirect_uri:  MS_REDIRECT_URI,
    grant_type:    'authorization_code',
  });

  const res  = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Auth failed');

  // Decode email from id_token
  let email = null;
  try {
    const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64').toString());
    email = payload.preferred_username || payload.upn || null;
  } catch {}

  await supabase.from('email_tokens').upsert({
    client_id:     clientId,
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
    email,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'client_id' });

  return email;
}

module.exports = { sendEmail, renderEmailTemplate, getAuthUrl, handleCallback, getTokenRecord, getValidAccessToken };