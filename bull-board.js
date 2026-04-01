const { createBullBoard }  = require('@bull-board/api');
const { BullMQAdapter }    = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter }   = require('@bull-board/express');
const { emailQueue, smsQueue } = require('./queues');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullMQAdapter(emailQueue),
    new BullMQAdapter(smsQueue),
  ],
  serverAdapter,
});

// Basic-auth middleware — set BULL_BOARD_PASSWORD in Railway env vars
function bullBoardAuth(req, res, next) {
  const password = process.env.BULL_BOARD_PASSWORD;
  if (!password) return next(); // no password configured — open (dev only)

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
    return res.sendStatus(401);
  }

  const encoded  = header.slice('Basic '.length);
  const decoded  = Buffer.from(encoded, 'base64').toString('utf8');
  const provided = decoded.split(':').slice(1).join(':'); // handle colons in password

  if (provided !== password) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
    return res.sendStatus(401);
  }

  next();
}

module.exports = { serverAdapter, bullBoardAuth };
