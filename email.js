const { google }  = require('googleapis');
const supabase    = require('./supabase');

const MS_CLIENT_ID     = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const MS_TENANT_ID     = process.env.MS_TENANT_ID;
const MS_REDIRECT_URI  = process.env.MS_REDIRECT_URI  || 'https://taraform-server-production.up.railway.app/auth/microsoft/callback';
const GRAPH_BASE       = 'https://graph.microsoft.com/v1.0';

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'https://taraform-server-production.up.railway.app/auth/google/callback';

function makeGoogleOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

// ── Token management ──────────────────────────────────────────

async function getTokenRecord(clientId) {
  const { data } = await supabase
    .from('email_tokens')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle();
  return data;
}

async function refreshAccessToken(clientId, refreshToken, provider) {
  if (provider === 'gmail') {
    const oauth2Client = makeGoogleOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();

    await supabase.from('email_tokens').upsert({
      client_id:     clientId,
      access_token:  credentials.access_token,
      refresh_token: credentials.refresh_token || refreshToken,
      expires_at:    new Date(credentials.expiry_date).toISOString(),
      provider:      'gmail',
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'client_id' });

    return credentials.access_token;
  }

  // Outlook / Microsoft
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
    provider:      'outlook',
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'client_id' });

  return data.access_token;
}

async function getValidAccessToken(clientId) {
  const record = await getTokenRecord(clientId);
  if (!record) throw new Error('No email account connected for this client');
  const expiresAt = new Date(record.expires_at);
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    return await refreshAccessToken(clientId, record.refresh_token, record.provider || 'outlook');
  }
  return record.access_token;
}

// ── Template rendering ────────────────────────────────────────

function renderEmailTemplate(template, contact) {
  const propAddr    = (contact.property_addresses || [])[0] || '';
  const propStreet  = propAddr.split(',')[0].trim();
  const ownerAddr   = (contact.owner_address || '');
  const ownerStreet = ownerAddr.split(',')[0].trim();

  const vars = {
    firstName:       contact.first_name  || '',
    lastName:        contact.last_name   || '',
    fullName:        `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
    county:          contact.county      || '',
    phone:           (contact.phones || [])[0] || '',
    email:           contact.email       || '',
    propertyAddress: propAddr,
    propertyStreet:  propStreet,
    ownerAddress:    ownerAddr,
    ownerStreet:     ownerStreet,
    taxMapId:        (contact.tax_map_ids || [])[0] || '',
    acreage:         contact.acreage     || '',
  };
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`{{${k}}}`, 'gi'), v);
  }
  return out;
}

// ── Send helpers ──────────────────────────────────────────────

async function sendViaGraph(accessToken, to, subject, body) {
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
  return res.status === 202;
}

async function sendViaGmail(accessToken, to, subject, body) {
  const oauth2Client = makeGoogleOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Gmail API requires RFC 2822 MIME message, base64url-encoded
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    body,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  });
  return res.status === 200;
}

// ── Send one email ────────────────────────────────────────────

async function sendEmail({ clientId, contactId, to, subject, body, templateId }) {
  const record = await getTokenRecord(clientId);
  if (!record) throw new Error('No email account connected for this client');

  const provider  = record.provider || 'outlook';
  const expiresAt = new Date(record.expires_at);
  const accessToken = expiresAt - Date.now() < 5 * 60 * 1000
    ? await refreshAccessToken(clientId, record.refresh_token, provider)
    : record.access_token;

  const success = provider === 'gmail'
    ? await sendViaGmail(accessToken, to, subject, body)
    : await sendViaGraph(accessToken, to, subject, body);

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

function getGmailAuthUrl(clientId) {
  const oauth2Client = makeGoogleOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',  // required to receive a refresh_token every time
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    state: clientId,
  });
}

function getOutlookAuthUrl(clientId) {
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

// Legacy helper — still used by existing /api/email/auth-url route
function getAuthUrl(clientId, provider = 'outlook') {
  return provider === 'gmail' ? getGmailAuthUrl(clientId) : getOutlookAuthUrl(clientId);
}

async function handleCallback(code, clientId, provider) {
  if (provider === 'gmail') {
    const oauth2Client = makeGoogleOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    let email = null;
    if (tokens.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString());
        email = payload.email || null;
      } catch {}
    }

    await supabase.from('email_tokens').upsert({
      client_id:     clientId,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    new Date(tokens.expiry_date).toISOString(),
      email,
      provider:      'gmail',
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'client_id' });

    return email;
  }

  // Outlook
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
    provider:      'outlook',
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'client_id' });

  return email;
}

module.exports = {
  sendEmail, renderEmailTemplate,
  getGmailAuthUrl, getOutlookAuthUrl, getAuthUrl,
  handleCallback, getTokenRecord, getValidAccessToken,
};
