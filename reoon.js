const supabase = require('./supabase');

const REOON_API_KEY = process.env.REOON_API_KEY || '69hPxm1jLKcwzWj3joFFYQ5FokOSyiwT';
const REOON_BASE    = 'https://emailverifier.reoon.com/api/v1';

// ── Submit bulk verification job ──────────────────────────────
async function submitBulkJob(emails, taskName) {
  const res = await fetch(`${REOON_BASE}/create-bulk-verification-task/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key:    REOON_API_KEY,
      name:   taskName.slice(0, 25), // max 25 chars
      emails: emails,
    }),
  });
  const data = await res.json();
  // Reoon returns 201 on success
  if (res.status !== 201 || !data.task_id) {
    throw new Error(data.reason || data.message || `Reoon error: ${res.status} — ${JSON.stringify(data)}`);
  }
  return data.task_id;
}

// ── Poll job status ───────────────────────────────────────────
async function getJobResult(taskId) {
  const res = await fetch(
    `${REOON_BASE}/get-result-bulk-verification-task/?key=${REOON_API_KEY}&task_id=${taskId}`
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.reason || data.message || 'Failed to get Reoon result');
  return data;
}

// ── Map Reoon status → email_status ──────────────────────────
function mapStatus(reoonStatus) {
  switch (reoonStatus) {
    case 'safe':
    case 'role':        return 'verified';
    case 'inbox_full':  return 'verified';   // mailbox exists, just full
    case 'catch_all':   return 'verified';   // risky but keep — let user decide
    case 'invalid':
    case 'spamtrap':
    case 'temporary':
    case 'disabled':    return 'do_not_email';
    case 'unknown':
    default:            return null;         // don't change — unknown gets refund from Reoon
  }
}

// ── Update contacts in Supabase ───────────────────────────────
async function updateContactStatuses(results, clientId) {
  let verified = 0, blocked = 0, skipped = 0;

  for (const item of results) {
    const emailStatus = mapStatus(item.status);
    if (!emailStatus) { skipped++; continue; }

    const { error } = await supabase
      .from('property_crm_contacts')
      .update({ email_status: emailStatus, updated_at: new Date().toISOString() })
      .eq('client_id', clientId)
      .ilike('email', item.email); // case-insensitive match

    if (!error) {
      if (emailStatus === 'verified') verified++;
      else blocked++;
    }
  }

  return { verified, blocked, skipped };
}

// ── Store job state in sms_settings ──────────────────────────
async function saveJobState(clientId, state) {
  await supabase.from('sms_settings').upsert({
    client_id: clientId,
    key:       'email_verification_job',
    value:     JSON.stringify(state),
  }, { onConflict: 'key,client_id' });
}

async function getJobState(clientId) {
  const { data } = await supabase
    .from('sms_settings')
    .select('value')
    .eq('client_id', clientId)
    .eq('key', 'email_verification_job')
    .single();
  return data?.value ? JSON.parse(data.value) : null;
}

module.exports = { submitBulkJob, getJobResult, updateContactStatuses, mapStatus, saveJobState, getJobState };