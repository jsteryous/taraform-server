const { Worker, DelayedError } = require('bullmq');
const Sentry   = require('@sentry/node');
const { connection } = require('./queues');
const { sendEmail } = require('./email');
const supabase = require('./supabase');

const MAX_TOUCHES          = 4;
const TOUCH_DELAY_DAYS     = 7;
const EMAIL_BUSINESS_START = 8.5;   // 8:30 AM Eastern

function isEmailBusinessHours() {
  const eastern = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day   = eastern.getDay();
  const hours = eastern.getHours() + eastern.getMinutes() / 60;
  return day >= 1 && day <= 5 && hours >= EMAIL_BUSINESS_START && hours < 17.5;
}

function msUntilNextBusinessHours() {
  const now     = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offset  = now.getTime() - eastern.getTime(); // Eastern wall-clock → UTC adjustment

  const day   = eastern.getDay();
  const hours = eastern.getHours() + eastern.getMinutes() / 60;

  const next = new Date(eastern);
  next.setHours(8, 30, 0, 0);

  if (!(day >= 1 && day <= 5 && hours < EMAIL_BUSINESS_START)) {
    next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1);
    }
    next.setHours(8, 30, 0, 0);
  }

  return (next.getTime() + offset) - now.getTime();
}

async function queueNextTouch(contactId, clientId, currentTouch) {
  const nextTouch = currentTouch + 1;
  if (nextTouch > MAX_TOUCHES) return;

  const { data: template } = await supabase
    .from('email_templates')
    .select('id')
    .eq('client_id', clientId)
    .eq('touch_number', nextTouch)
    .limit(1)
    .maybeSingle();
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

const worker = new Worker('email-send', async (job, token) => {
  if (!isEmailBusinessHours()) {
    const delay = msUntilNextBusinessHours();
    await job.moveToDelayed(Date.now() + delay, token);
    throw new DelayedError();
  }

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
});

worker.on('completed', (job) => {
  console.log(`[email-worker] Job ${job.id} completed — contact ${job.data.contactId} touch ${job.data.touchNumber}`);
});

worker.on('failed', (job, err) => {
  console.error(`[email-worker] Job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${err.message}`);
  if (job.attemptsMade >= job.opts.attempts) {
    Sentry.withScope(scope => {
      scope.setContext('job', {
        id:          job.id,
        contactId:   job.data.contactId,
        touchNumber: job.data.touchNumber,
        clientId:    job.data.clientId,
      });
      Sentry.captureException(err);
    });
  }
});

console.log('Email worker started — concurrency: 1, retries: 3 (exponential backoff)');
module.exports = { worker };
