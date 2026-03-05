require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // required for Twilio webhook POST

// ── Routes ───────────────────────────────────────────────────
app.use('/webhook', require('./webhook'));
app.use('/api',     require('./api'));

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Taraform SMS Engine', time: new Date().toISOString() });
});

// ── Start scheduler ──────────────────────────────────────────
require('./scheduler');

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Taraform server running on port ${PORT}`);
});