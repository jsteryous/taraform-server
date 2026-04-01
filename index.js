require('dotenv').config();
const express = require('express');
const app = express();

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  // OAuth callback and Bull Board are accessed directly — skip CORS restriction
  if (req.path.startsWith('/auth/') || req.path.startsWith('/admin/')) return next();
  res.header('Access-Control-Allow-Origin', 'https://taraform.org');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Routes ────────────────────────────────────────────────────
app.use(           require('./auth'));   // Microsoft OAuth callback — must be before /api
app.use('/webhook', require('./webhook'));
app.use('/api',     require('./api'));

// ── Bull Board (/admin/queues) ────────────────────────────────
const { serverAdapter, bullBoardAuth } = require('./bull-board');
app.use('/admin/queues', bullBoardAuth, serverAdapter.getRouter());

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Taraform SMS Engine', time: new Date().toISOString() });
});

// ── Start schedulers & workers ────────────────────────────────
require('./scheduler');
require('./email-scheduler');
require('./email-worker');

// ── Start server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Taraform server running on port ${PORT}`);
});