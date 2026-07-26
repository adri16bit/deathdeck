/**
 * DEATHDECK — server enxuto (COMMS + album + lyrics + Spotify).
 * Cloud: Railway / Render (respeita PORT, sem localtunnel).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { mountCyberdeckRoutes } = require('./DEATHDECK/routes');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

function isCloud() {
  return (
    process.env.JS_LAB_CLOUD === '1' ||
    !!process.env.RAILWAY_ENVIRONMENT ||
    !!process.env.RAILWAY_PROJECT_ID ||
    !!process.env.RENDER ||
    !!process.env.FLY_APP_NAME
  );
}

function pickPort() {
  const fromEnv = Number(process.env.PORT || process.env.JS_LAB_PORT || 0);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  try {
    const prev = parseInt(String(fs.readFileSync(path.join(ROOT, 'runtime-port.txt'), 'utf8')).trim(), 10);
    if (Number.isFinite(prev) && prev > 0 && prev < 65536) return prev;
  } catch {
    /* ignore */
  }
  return 9756;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'deathdeck',
    cloud: isCloud(),
    spotifyEnv: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    time: new Date().toISOString(),
  });
});

mountCyberdeckRoutes(app);

app.use(express.static(PUBLIC, { extensions: ['html'] }));

app.get('/', (_req, res) => {
  res.redirect('/DEATHDECK/');
});

app.get('/DEATHDECK', (_req, res) => {
  res.redirect('/DEATHDECK/');
});

/* WBM embed · Adri16bit PC (build estático em public/pc) */
app.get('/pc', (_req, res) => {
  res.redirect(301, '/pc/');
});
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!req.path.startsWith('/pc/')) return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(PUBLIC, 'pc', 'index.html'), (err) => {
    if (err) next();
  });
});

const port = pickPort();
try {
  fs.writeFileSync(path.join(ROOT, 'runtime-port.txt'), String(port), 'utf8');
} catch {
  /* ignore */
}
const server = http.createServer(app);
server.listen(port, '0.0.0.0', () => {
  console.log(`DEATHDECK on :${port}  →  http://localhost:${port}/DEATHDECK/`);
  if (isCloud()) console.log('cloud mode · no localtunnel');
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
