// server.js — runs Procore Monitor as one Node web service (Railway, Render, etc.)
// Serves the built React app from /dist and the API from /api/*.
const path = require('path');
const express = require('express');

const app = express();
app.set('trust proxy', 1);           // Railway terminates HTTPS in front of the app
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const routes = {
  'auth': './api/auth',
  'callback': './api/callback',
  'session': './api/session',
  'logout': './api/logout',
  'status': './api/status',
  'rate-limit': './api/rate-limit',
  'rfis': './api/rfis',
  'rfi-detail': './api/rfi-detail',
  'submittals': './api/submittals',
  'change-events': './api/change-events',
  'change-orders': './api/change-orders',
  'co-diagnostics': './api/co-diagnostics',
};

for (const [name, file] of Object.entries(routes)) {
  const handler = require(file);
  app.all(`/api/${name}`, async (req, res) => {
    try { await handler(req, res); }
    catch (err) {
      console.error(`[server] /api/${name} crashed:`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
  });
}
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Built front end. Hashed files cache for a year; index.html never caches.
const dist = path.join(__dirname, 'dist');
app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(dist, { index: false, maxAge: 0 }));
app.use((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(dist, 'index.html'));
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Procore Monitor listening on ${port}`));
