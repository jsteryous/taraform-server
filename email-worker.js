const { Worker } = require('bullmq');
const { connection } = require('./queues');
const { sendEmail } = require('./email');
const supabase = require('./supabase');

const MAX_TOUCHES      = 4;
const TOUCH_DELAY_DAYS = 7;

async function queueNextTouch(contactId, clientId, currentTouch) {
  const nextTouch = currentTouch + 1;
  if (nextTouch > MAX_TOUCHES) return;

  const { data: template } = await supabase
    .from('email_templates')
    .select('id')
    .eq('client_id', clientId)
    .eq('touch_number', nextTouch)
    .limit(1)
    .single();
  if (!template) return;

  const scheduledFor = new Date();
  scheduledFor.setDate(scheduledFor.getDate() + TOUCH_DELAY_DAYS);

  await supabase.from('email_followup_queue').insert({
    contact_id:    contactId,
    client_id:     clientId,
    touch_number:  nextTouch,
    scheduled_for: scheduledFor.toISOString(),
    status:        'pending',
  });
}

const worker = new Worker('email-send', async (job) => {
  const { clientId, contactId, to, subject, body, templateId, touchNumber, queueRowId } = job.data;

  const { success } = await sendEmail({ clientId, contactId, to, subject, body, templateId });

  if (success) {
    if (queueRowId) {
      await supabase.from('email_followup_queue')
        .update({ status: 'sent' })
        .eq('id', queueRowId);
    }
    await queueNextTouch(contactId, clientId, touchNumber);
  } else {
    // sendEmail already wrote a 'failed' row to email_messages; mark queue row for visibility
    if (queueRowId) {
      await supabase.from('email_followup_queue')
        .update({ status: 'failed' })
        .eq('id', queueRowId);
    }
    throw new Error(`sendEmail returned failure for contact ${contactId}`);
  }

  return { success };
}, {
  connection,
  concurrency: 1,
  defaultJobOptions: {
    attempts:  3,
    backoff: { type: 'exponential', delay: 5 * 60 * 1000 }, // 5 min → 10 min → 20 min
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 200 },
  },
});

worker.on('completed', (job) => {
  console.log(`[email-worker] Job ${job.id} completed — contact ${job.data.contactId} touch ${job.data.touchNumber}`);
});

worker.on('failed', (job, err) => {
  console.error(`[email-worker] Job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${err.message}`);
});

console.log('Email worker started — concurrency: 1, retries: 3 (exponential backoff)');
module.exports = { worker };
