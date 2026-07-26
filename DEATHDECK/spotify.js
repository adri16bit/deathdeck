/**
 * Spotify OAuth + search (client credentials) pro COMMS.
 *
 * Config (nesta ordem):
 * 1) process.env.SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REDIRECT_URI
 * 2) DEATHDECK/spotify.local.json
 *
 * Dashboard: https://developer.spotify.com/dashboard
 * Redirect ex.: http://localhost:PORT/api/deck/spotify/callback
 * Scopes: streaming, user-read-email, user-read-private,
 *         user-modify-playback-state, user-read-playback-state
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const LOCAL_JSON = path.join(__dirname, 'spotify.local.json');
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
].join(' ');

let appToken = { access: '', exp: 0 };
const pendingStates = new Map(); /* state -> { at } */

function loadSpotifyConfig() {
  const envId = String(process.env.SPOTIFY_CLIENT_ID || '').trim();
  const envSecret = String(process.env.SPOTIFY_CLIENT_SECRET || '').trim();
  const envRedirect = String(process.env.SPOTIFY_REDIRECT_URI || '').trim();
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, redirectUri: envRedirect };
  }
  if (fs.existsSync(LOCAL_JSON)) {
    try {
      const j = JSON.parse(fs.readFileSync(LOCAL_JSON, 'utf8'));
      const clientId = String(j.client_id || j.clientId || '').trim();
      const clientSecret = String(j.client_secret || j.clientSecret || '').trim();
      const redirectUri = String(j.redirect_uri || j.redirectUri || '').trim();
      if (clientId && clientSecret) {
        return { clientId, clientSecret, redirectUri };
      }
    } catch {
      /* ignore */
    }
  }
  return { clientId: '', clientSecret: '', redirectUri: '' };
}

function isConfigured() {
  const c = loadSpotifyConfig();
  if (!c.clientId || !c.clientSecret) return false;
  if (/^COLE_AQUI$/i.test(c.clientId) || /^COLE_AQUI$/i.test(c.clientSecret)) return false;
  if (c.clientId.length < 8 || c.clientSecret.length < 8) return false;
  return true;
}

function requestForm(url, form, headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = new URLSearchParams(form).toString();
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
          if (raw.length > 500000) {
            req.destroy();
            reject(new Error('resposta grande'));
          }
        });
        res.on('end', () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new Error('JSON inválido'));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = data?.error_description || data?.error || `HTTP ${res.statusCode}`;
            reject(new Error(String(msg)));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(body);
    req.end();
  });
}

function requestJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const payload = opts.body != null ? JSON.stringify(opts.body) : null;
    const headers = {
      Accept: 'application/json',
      ...(opts.headers || {}),
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
          if (raw.length > 1_000_000) {
            req.destroy();
            reject(new Error('resposta grande'));
          }
        });
        res.on('end', () => {
          let data = null;
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch {
              data = { raw: raw.slice(0, 200) };
            }
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = data?.error?.message || data?.error_description || data?.error || `HTTP ${res.statusCode}`;
            reject(new Error(String(msg)));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function getAppAccessToken() {
  if (appToken.access && Date.now() < appToken.exp - 30000) return appToken.access;
  const cfg = loadSpotifyConfig();
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('Spotify não configurado');
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const data = await requestForm(
    'https://accounts.spotify.com/api/token',
    { grant_type: 'client_credentials' },
    { Authorization: `Basic ${basic}` }
  );
  appToken = {
    access: String(data.access_token || ''),
    exp: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  if (!appToken.access) throw new Error('token app vazio');
  return appToken.access;
}

/**
 * @returns {Promise<{ id: string, uri: string, title: string, artists: string }|null>}
 */
async function searchSpotifyTrack(query) {
  const hits = await searchSpotifyTracks(query, { limit: 5 });
  return hits[0] || null;
}

/**
 * @returns {Promise<Array<{ id: string, uri: string, title: string, artists: string }>>}
 */
async function searchSpotifyTracks(query, opts = {}) {
  const q = String(query || '').trim().slice(0, 160);
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || 8));
  const exclude = new Set(
    (opts.excludeIds || []).map((x) => String(x || '').toLowerCase()).filter(Boolean)
  );
  if (!q || !isConfigured()) return [];
  const fromLink = await resolveSpotifyLink(q);
  if (fromLink?.uri) {
    if (exclude.has(String(fromLink.id).toLowerCase())) return [];
    return [fromLink];
  }
  try {
    const token = await getAppAccessToken();
    const url =
      'https://api.spotify.com/v1/search?' +
      new URLSearchParams({
        q,
        type: 'track',
        limit: String(limit),
        market: 'BR',
      }).toString();
    const data = await requestJson(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const out = [];
    for (const t of data?.tracks?.items || []) {
      const hit = trackFromApiItem(t);
      if (!hit) continue;
      if (exclude.has(String(hit.id).toLowerCase())) continue;
      out.push(hit);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Próxima faixa de rádio Spotify (artista / mix), evitando repetir ids. */
async function pickSpotifyRadioTrack(seed, opts = {}) {
  const mode = opts.mode === 'mix' ? 'mix' : 'artist';
  const seedQ = String(seed || '').trim().slice(0, 80);
  if (!seedQ) return null;
  const excludeIds = opts.excludeIds || [];
  const queries =
    mode === 'artist'
      ? [`artist:"${seedQ}"`, seedQ, `${seedQ} top tracks`]
      : [`${seedQ} mix`, `${seedQ} radio`, `${seedQ} songs`, seedQ];
  for (const q of queries) {
    const hits = await searchSpotifyTracks(q, { limit: 12, excludeIds });
    if (hits.length) {
      return hits[Math.floor(Math.random() * Math.min(hits.length, 6))];
    }
  }
  return null;
}

/** open.spotify.com/track/… · spotify:track:… · album · playlist */
function extractSpotifyRef(input) {
  const s = String(input || '');
  if (!s) return null;
  let m = s.match(/spotify:(track|album|playlist):([a-zA-Z0-9]{22})/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  m = s.match(
    /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([a-zA-Z0-9]{22})/i
  );
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  return null;
}

function trackFromApiItem(t) {
  const id = String(t?.id || '').trim();
  const uri = String(t?.uri || '').trim();
  if (!id || !uri.startsWith('spotify:track:')) return null;
  const artists = (t.artists || [])
    .map((a) => a?.name)
    .filter(Boolean)
    .join(', ');
  const title = artists
    ? `${artists} - ${t.name || 'track'}`.slice(0, 140)
    : String(t.name || 'track').slice(0, 140);
  return { id, uri, title, artists: artists.slice(0, 80) };
}

/**
 * Resolve link/URI do Spotify pra uma faixa tocável.
 * album/playlist → primeira faixa disponível.
 */
async function resolveSpotifyLink(input) {
  const ref = extractSpotifyRef(input);
  if (!ref || !isConfigured()) return null;
  try {
    const token = await getAppAccessToken();
    const auth = { Authorization: `Bearer ${token}` };
    if (ref.type === 'track') {
      const t = await requestJson(
        `https://api.spotify.com/v1/tracks/${encodeURIComponent(ref.id)}?market=BR`,
        { headers: auth }
      );
      return trackFromApiItem(t);
    }
    if (ref.type === 'album') {
      const data = await requestJson(
        `https://api.spotify.com/v1/albums/${encodeURIComponent(ref.id)}/tracks?limit=5&market=BR`,
        { headers: auth }
      );
      for (const item of data?.items || []) {
        if (!item?.id) continue;
        const full = await requestJson(
          `https://api.spotify.com/v1/tracks/${encodeURIComponent(item.id)}?market=BR`,
          { headers: auth }
        );
        const hit = trackFromApiItem(full);
        if (hit) return hit;
      }
      return null;
    }
    if (ref.type === 'playlist') {
      const data = await requestJson(
        `https://api.spotify.com/v1/playlists/${encodeURIComponent(ref.id)}/tracks?limit=15&market=BR`,
        { headers: auth }
      );
      for (const row of data?.items || []) {
        const hit = trackFromApiItem(row?.track);
        if (hit) return hit;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveRedirectUri(req, cfg) {
  if (cfg.redirectUri) return cfg.redirectUri;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}/api/deck/spotify/callback`;
}

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (!v?.at || now - v.at > 15 * 60 * 1000) pendingStates.delete(k);
  }
}

function mountSpotifyRoutes(app) {
  app.get('/api/deck/spotify/status', (_req, res) => {
    const cfg = loadSpotifyConfig();
    const configured = isConfigured();
    res.json({
      ok: true,
      configured,
      placeholder: /COLE_AQUI/i.test(cfg.clientId || '') || /COLE_AQUI/i.test(cfg.clientSecret || ''),
      clientId: configured && cfg.clientId ? cfg.clientId.slice(0, 6) + '…' : '',
    });
  });

  app.get('/api/deck/spotify/login', (req, res) => {
    const cfg = loadSpotifyConfig();
    if (!isConfigured()) {
      res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"/>
<title>Spotify setup</title>
<body style="font-family:monospace;background:#111;color:#f4f1ea;padding:2rem;line-height:1.5">
<p><strong>Spotify ainda não está configurado.</strong></p>
<p>Edita <code>DEATHDECK/spotify.local.json</code> e cola o <em>Client ID</em> e <em>Client Secret</em> do
<a href="https://developer.spotify.com/dashboard" style="color:#1db954">Spotify Dashboard</a>
(não deixa COLE_AQUI).</p>
<p>Redirect URI no app:</p>
<pre style="background:#1a1a1a;padding:0.75rem;overflow:auto">http://127.0.0.1:9756/api/deck/spotify/callback</pre>
<p><a href="/DEATHDECK/" style="color:#c9b896">← voltar ao deck</a></p>
</body>`);
      return;
    }
    pruneStates();
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, { at: Date.now() });
    const redirectUri = resolveRedirectUri(req, cfg);
    const url =
      'https://accounts.spotify.com/authorize?' +
      new URLSearchParams({
        client_id: cfg.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES,
        state,
        show_dialog: 'true',
      }).toString();
    res.redirect(url);
  });

  app.get('/api/deck/spotify/callback', async (req, res) => {
    const cfg = loadSpotifyConfig();
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const err = String(req.query.error || '');
    const redirectUri = resolveRedirectUri(req, cfg);

    const fail = (msg) => {
      res.status(400).type('html').send(`<!doctype html><meta charset="utf-8"/>
<title>Spotify</title>
<body style="font-family:monospace;background:#111;color:#f4f1ea;padding:2rem">
<p>falhou: ${String(msg).replace(/[<>&]/g, '')}</p>
<p><a href="/DEATHDECK/" style="color:#c9b896">voltar ao deck</a></p>
</body>`);
    };

    if (err) {
      fail(err);
      return;
    }
    if (!code || !state || !pendingStates.has(state)) {
      fail('state inválido — tenta conectar de novo');
      return;
    }
    pendingStates.delete(state);

    try {
      const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
      const data = await requestForm(
        'https://accounts.spotify.com/api/token',
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        },
        { Authorization: `Basic ${basic}` }
      );
      const access = String(data.access_token || '');
      const refresh = String(data.refresh_token || '');
      const expiresIn = Number(data.expires_in || 3600);
      if (!access || !refresh) {
        fail('token incompleto');
        return;
      }
      const payload = {
        access,
        refresh,
        exp: Date.now() + expiresIn * 1000,
      };
      res
        .status(200)
        .type('html')
        .send(`<!doctype html><meta charset="utf-8"/>
<title>Spotify ok</title>
<body style="font-family:monospace;background:#111;color:#f4f1ea;padding:2rem">
<p>spotify conectado · voltando…</p>
<script>
try {
  localStorage.setItem('voidwire-spotify-v1', ${JSON.stringify(JSON.stringify(payload))});
} catch (e) {}
location.replace('/DEATHDECK/?spotify=1');
</script>
</body>`);
    } catch (e) {
      fail(e.message || 'oauth falhou');
    }
  });

  app.post('/api/deck/spotify/refresh', async (req, res) => {
    const cfg = loadSpotifyConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      res.status(503).json({ ok: false, error: 'Spotify não configurado' });
      return;
    }
    const refresh = String(req.body?.refresh_token || req.body?.refresh || '').trim();
    if (!refresh) {
      res.status(400).json({ ok: false, error: 'refresh_token ausente' });
      return;
    }
    try {
      const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
      const data = await requestForm(
        'https://accounts.spotify.com/api/token',
        {
          grant_type: 'refresh_token',
          refresh_token: refresh,
        },
        { Authorization: `Basic ${basic}` }
      );
      res.json({
        ok: true,
        access_token: data.access_token,
        refresh_token: data.refresh_token || refresh,
        expires_in: data.expires_in || 3600,
      });
    } catch (e) {
      res.status(401).json({ ok: false, error: e.message || 'refresh falhou' });
    }
  });

  app.get('/api/deck/spotify/search', async (req, res) => {
    if (!isConfigured()) {
      res.status(503).json({ ok: false, error: 'Spotify não configurado' });
      return;
    }
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.status(400).json({ ok: false, error: 'q vazio' });
      return;
    }
    const hit = await searchSpotifyTrack(q);
    if (!hit) {
      res.json({ ok: false, error: 'nada achado' });
      return;
    }
    res.json({ ok: true, track: hit });
  });
}

module.exports = {
  mountSpotifyRoutes,
  searchSpotifyTrack,
  searchSpotifyTracks,
  pickSpotifyRadioTrack,
  resolveSpotifyLink,
  extractSpotifyRef,
  isConfigured,
  loadSpotifyConfig,
};
