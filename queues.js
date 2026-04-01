const { Queue } = require('bullmq');
const IORedis    = require('ioredis');

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL environment variable is required');
}

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
});

connection.on('error', err => console.error('Redis connection error:', err.message));
connection.on('connect', () => console.log('Redis connected'));

const emailQueue = new Queue('email-send', { connection });
const smsQueue   = new Queue('sms-send',   { connection });

module.exports = { emailQueue, smsQueue, connection };
