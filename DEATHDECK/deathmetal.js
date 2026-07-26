/**
 * D>E>A>T>H>M>E>T>A>L — metadados + URLs de stream do Bandcamp oficial.
 * Tokens do Bandcamp expiram; sempre busca frescos na página do álbum.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ALBUM_PAGE = 'https://panchiko.bandcamp.com/album/d-e-a-t-h-m-e-t-a-l';
const ALBUM_ID = '272087637';
const CACHE_MS = 8 * 60 * 1000;

let cache = { at: 0, data: null };

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('muitos redirects'));
      return;
    }
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DeathDeck/1.0; +local tribute)',
          Accept: 'text/html,application/json,*/*',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).href;
          res.resume();
          fetchText(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => resolve(raw));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

function parseTrackinfo(html) {
  const decoded = decodeEntities(html);
  const m = decoded.match(/"trackinfo"\s*:\s*(\[[\s\S]*?\])\s*,\s*"playing_from"/);
  let json = m?.[1];
  if (!json) {
    const m2 = decoded.match(/"trackinfo":(\[[\s\S]*?\])/);
    json = m2?.[1];
  }
  if (!json) throw new Error('trackinfo não encontrado no Bandcamp');

  // corta no fim do array de forma segura
  let depth = 0;
  let end = -1;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end > 0) json = json.slice(0, end);

  const tracks = JSON.parse(json);
  return tracks
    .filter((t) => t && t.streaming && t.file && t.file['mp3-128'])
    .map((t, i) => ({
      num: t.track_num || i + 1,
      id: String(t.track_id || t.id),
      title: t.title,
      duration: Math.round(Number(t.duration) || 0),
      streamUrl: t.file['mp3-128'],
      bandcamp: t.title_link
        ? `https://panchiko.bandcamp.com${t.title_link}`
        : ALBUM_PAGE,
      rot: /_R>O>T|_R&gt;O&gt;T/i.test(t.title || ''),
    }));
}

async function loadAlbum(force = false) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }
  const html = await fetchText(ALBUM_PAGE);
  const tracks = parseTrackinfo(html);
  if (!tracks.length) throw new Error('nenhuma faixa streamável');
  const data = {
    ok: true,
    album: 'D>E>A>T>H>M>E>T>A>L',
    artist: 'Panchiko',
    bandcamp: ALBUM_PAGE,
    albumId: ALBUM_ID,
    cover: '/DEATHDECK/assets/album-deathmetal.jpg',
    tracks,
    fetchedAt: Date.now(),
  };
  cache = { at: Date.now(), data };
  return data;
}

function isAllowedStream(url) {
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      /\.bcbits\.com$/i.test(u.hostname) &&
      /\/stream\//i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

function proxyStream(req, res, targetUrl) {
  if (!isAllowedStream(targetUrl)) {
    res.status(400).json({ ok: false, error: 'URL de stream inválida' });
    return;
  }
  const mod = targetUrl.startsWith('https') ? https : http;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; DeathDeck/1.0)',
    Accept: '*/*',
    Referer: ALBUM_PAGE,
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = mod.get(targetUrl, { headers }, (up) => {
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
      up.resume();
      proxyStream(req, res, new URL(up.headers.location, targetUrl).href);
      return;
    }
    if (up.statusCode !== 200 && up.statusCode !== 206) {
      up.resume();
      if (!res.headersSent) res.status(502).json({ ok: false, error: `stream HTTP ${up.statusCode}` });
      return;
    }
    res.status(up.statusCode);
    const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
    pass.forEach((h) => {
      if (up.headers[h]) res.setHeader(h, up.headers[h]);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ ok: false, error: 'falha no stream' });
  });
  upstream.setTimeout(20000, () => {
    upstream.destroy();
    if (!res.headersSent) res.status(504).json({ ok: false, error: 'timeout stream' });
  });
  req.on('close', () => upstream.destroy());
}

function mountDeathmetalRoutes(app) {
  app.get('/api/deck/album/deathmetal', async (_req, res) => {
    try {
      const data = await loadAlbum();
      // não vaza URL assinada crua pro client se quisermos — mas precisamos do id;
      // o client pede stream via proxy por track id
      res.json({
        ok: true,
        album: data.album,
        artist: data.artist,
        bandcamp: data.bandcamp,
        cover: data.cover,
        tracks: data.tracks.map((t) => ({
          num: t.num,
          id: t.id,
          title: t.title,
          duration: t.duration,
          bandcamp: t.bandcamp,
          rot: t.rot,
          stream: `/api/deck/album/stream/${encodeURIComponent(t.id)}`,
        })),
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message || 'falha ao ler Bandcamp' });
    }
  });

  app.get('/api/deck/album/stream/:id', async (req, res) => {
    try {
      const data = await loadAlbum();
      const track = data.tracks.find((t) => t.id === String(req.params.id));
      if (!track?.streamUrl) {
        // força refresh caso token tenha morrido / id antigo
        const fresh = await loadAlbum(true);
        const t2 = fresh.tracks.find((t) => t.id === String(req.params.id));
        if (!t2?.streamUrl) {
          res.status(404).json({ ok: false, error: 'faixa não encontrada' });
          return;
        }
        proxyStream(req, res, t2.streamUrl);
        return;
      }
      proxyStream(req, res, track.streamUrl);
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ ok: false, error: err.message || 'stream fail' });
    }
  });
}

module.exports = { mountDeathmetalRoutes, loadAlbum };
