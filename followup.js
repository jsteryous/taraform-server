const supabase = require('./supabase');

function addBusinessDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return result;
}

function toDateString(date) {
  return date.toISOString().split('T')[0];
}

async function scheduleFollowUps(contactId, clientId, sentAt = new Date()) {
  const { data: templates, error } = await supabase
    .from('sms_templates')
    .select('id, touch_number')
    .eq('client_id', clientId)
    .in('touch_number', [2, 3, 4])
    .eq('active', true);

  if (error) {
    console.error('Failed to fetch templates for follow-up scheduling:', error.message);
    return;
  }

  const byTouch = {};
  templates.forEach(t => { byTouch[t.touch_number] = t.id; });

  const touch1Date = new Date(sentAt);

  const queue = [
    {
      contact_id:    contactId,
      client_id:     clientId,
      touch_number:  2,
      scheduled_for: toDateString(addBusinessDays(touch1Date, 7)),
      template_id:   byTouch[2] || null,
      status:        'pending',
    },
    {
      contact_id:    contactId,
      client_id:     clientId,
      touch_number:  3,
      scheduled_for: toDateString(addBusinessDays(new Date(touch1Date.getTime() + 30 * 24 * 60 * 60 * 1000), 0)),
      template_id:   byTouch[3] || null,
      status:        'pending',
    },
    {
      contact_id:    contactId,
      client_id:     clientId,
      touch_number:  4,
      scheduled_for: toDateString(addBusinessDays(new Date(touch1Date.getTime() + 180 * 24 * 60 * 60 * 1000), 0)),
      template_id:   byTouch[4] || null,
      status:        'pending',
    },
  ];

  const { error: insertError } = await supabase
    .from('sms_followup_queue')
    .insert(queue);

  if (insertError) {
    console.error('Failed to schedule follow-ups:', insertError.message);
  } else {
    console.log(`Follow-ups scheduled for contact ${contactId} (client ${clientId}): days 7, 30, 180`);
  }
}

async function getDueFollowUps(clientId) {
  const today = toDateString(new Date());

  const query = supabase
    .from('sms_followup_queue')
    .select(`
      id,
      contact_id,
      touch_number,
      template_id,
      client_id,
      property_crm_contacts (
        id, first_name, last_name, phones,
        property_addresses, owner_address, county,
        sms_status, followup_paused, opt_out_at
      )
    `)
    .eq('status', 'pending')
    .lte('scheduled_for', today)
    .order('scheduled_for', { ascending: true });

  // Scope to a specific client if provided
  if (clientId) query.eq('client_id', clientId);

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch follow-up queue:', error.message);
    return [];
  }

  return (data || []).filter(item => {
    const c = item.property_crm_contacts;
    if (!c) return false;
    if (c.followup_paused) return false;
    if (c.opt_out_at) return false;
    if (c.sms_status === 'do_not_contact') return false;
    if (c.sms_status === 'not_interested') return false;
    return true;
  });
}

async function markFollowUpSent(queueId) {
  await supabase
    .from('sms_followup_queue')
    .update({ status: 'sent' })
    .eq('id', queueId);
}

module.exports = { scheduleFollowUps, getDueFollowUps, markFollowUpSent };