/**
 * Letras via LRCLIB (original language, sync LRC + plain fallback).
 * Não traduz — EN/PT vem da fonte.
 */
const https = require('https');
const { URL } = require('url');

const UA = 'js-lab-deathdeck/1.0 (lyrics; +https://lrclib.net)';
const CACHE_MS = 1000 * 60 * 60 * 6;
const cache = new Map();

function httpsGetJson(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': UA,
        },
        timeout: 12000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c.toString('utf8');
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 0, data: null });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ status: 0, data: null, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, data: null, error: 'timeout' });
    });
    req.end();
  });
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLrcTags(s) {
  return String(s || '')
    /* tags de tempo [00:12.34] ou [00:12:34] */
    .replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
    /* enhanced LRC palavra a palavra <00:12.34> */
    .replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function parseLrc(lrc) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const text = String(lrc || '');
  const hits = [];
  let m;
  while ((m = re.exec(text))) {
    const mm = Number(m[1]) || 0;
    const ss = Number(m[2]) || 0;
    let frac = m[3] || '0';
    if (frac.length === 1) frac += '0';
    if (frac.length === 2) frac += '0';
    const ms = Number(frac.slice(0, 3)) || 0;
    hits.push({
      t: mm * 60 + ss + ms / 1000,
      index: m.index,
      end: m.index + m[0].length,
    });
  }
  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i];
    const next = hits[i + 1];
    let chunkEnd = next ? next.index : text.length;
    let chunk = text.slice(cur.end, chunkEnd);
    const nl = chunk.search(/\r?\n/);
    if (nl >= 0) chunk = chunk.slice(0, nl);
    const line = stripLrcTags(chunk);
    if (!line) continue;
    lines.push({ t: cur.t, text: line });
  }
  /* dedupe mesmo tempo + mesmo texto */
  const out = [];
  const seen = new Set();
  for (const row of lines.sort((a, b) => a.t - b.t)) {
    const key = `${row.t.toFixed(2)}|${row.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function plainFromLrcOrText(raw) {
  const s = String(raw || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!s) return '';
  if (/\[\d{1,2}:\d{2}/.test(s)) {
    const synced = parseLrc(s);
    if (synced.length) return synced.map((l) => l.text).join('\n');
  }
  return s
    .split('\n')
    .map((line) => stripLrcTags(line))
    .filter(Boolean)
    .join('\n');
}

function detectLang(text) {
  const s = String(text || '');
  if (!s.trim()) return 'und';
  const ptHints =
    /[áàâãéêíóôõúç]|(\b(não|voce|você|pra|pro|que|com|uma|meu|minha|amor|saudade|coração|voce|tá|tô)\b)/i;
  if (ptHints.test(s)) return 'PT';
  if (/[a-z]/i.test(s)) return 'EN';
  return 'und';
}

function scoreHit(hit, track, artist, duration) {
  const nt = norm(track);
  const na = norm(artist);
  const ht = norm(hit.trackName || hit.name);
  const ha = norm(hit.artistName);
  if (!nt || !ht) return -99;

  let score = 0;

  /* título: exige overlap real — senão é outra música */
  if (ht === nt) score += 12;
  else if (ht.startsWith(nt) || nt.startsWith(ht)) score += 8;
  else if (ht.includes(nt) || nt.includes(ht)) {
    const shorter = Math.min(ht.length, nt.length);
    const longer = Math.max(ht.length, nt.length);
    if (shorter >= 4 && shorter / longer >= 0.55) score += 5;
    else return -20;
  } else {
    const tTokens = nt.split(' ').filter((w) => w.length > 2);
    const hTokens = new Set(ht.split(' ').filter((w) => w.length > 2));
    if (!tTokens.length) return -20;
    const hitN = tTokens.filter((w) => hTokens.has(w)).length;
    const ratio = hitN / tTokens.length;
    if (ratio < 0.6) return -20;
    score += Math.round(ratio * 6);
  }

  if (na) {
    if (ha === na) score += 8;
    else if (ha.includes(na) || na.includes(ha)) score += 4;
    else {
      const aTokens = na.split(' ').filter((w) => w.length > 2);
      const hA = new Set(ha.split(' ').filter((w) => w.length > 2));
      const aHit = aTokens.filter((w) => hA.has(w)).length;
      if (aTokens.length && aHit / aTokens.length >= 0.5) score += 3;
      else score -= 4;
    }
  }

  const dur = Number(duration) || 0;
  const hd = Number(hit.duration) || 0;
  if (dur >= 20 && hd >= 20) {
    const diff = Math.abs(hd - dur);
    if (diff <= 2) score += 6;
    else if (diff <= 5) score += 3;
    else if (diff <= 12) score += 0;
    else if (diff > 25) score -= 10;
    else score -= 4;
  }

  if (hit.syncedLyrics) score += 3;
  else if (hit.plainLyrics) score += 1;
  if (hit.instrumental) score -= 2;
  return score;
}

function cacheKey({ track, artist, album, duration }) {
  return ['v3', norm(artist), norm(track), norm(album), Math.round(Number(duration) || 0)].join('|');
}

function packResult(hit) {
  if (!hit) return { ok: false, error: 'letra não encontrada' };
  if (hit.instrumental && !hit.syncedLyrics && !hit.plainLyrics) {
    return {
      ok: true,
      instrumental: true,
      synced: [],
      plain: '',
      lang: 'und',
      trackName: hit.trackName || hit.name || '',
      artistName: hit.artistName || '',
    };
  }
  const synced = parseLrc(hit.syncedLyrics || '');
  let plain = plainFromLrcOrText(hit.plainLyrics || '');
  if (!plain && synced.length) plain = synced.map((l) => l.text).join('\n');
  if (!synced.length && hit.syncedLyrics) {
    /* synced veio sujo — tenta de novo via plain helper */
    plain = plain || plainFromLrcOrText(hit.syncedLyrics);
  }
  if (!synced.length && !plain) {
    return { ok: false, error: 'letra não encontrada' };
  }
  const sample = synced.length
    ? synced
        .slice(0, 12)
        .map((l) => l.text)
        .join(' ')
    : plain.slice(0, 400);
  return {
    ok: true,
    instrumental: false,
    synced,
    plain,
    lang: detectLang(sample),
    trackName: hit.trackName || hit.name || '',
    artistName: hit.artistName || '',
    duration: Number(hit.duration) || 0,
  };
}

async function searchLyrics({ track, artist }) {
  const q = [artist, track].filter(Boolean).join(' ').trim();
  if (!q) return [];
  const url =
    'https://lrclib.net/api/search?' +
    new URLSearchParams({
      track_name: String(track || '').slice(0, 120),
      artist_name: String(artist || '').slice(0, 120),
      q: q.slice(0, 160),
    }).toString();
  const res = await httpsGetJson(url);
  if (!Array.isArray(res.data)) return [];
  return res.data;
}

async function getBySignature({ track, artist, album, duration }) {
  const dur = Math.round(Number(duration) || 0);
  if (!track || !artist || !album || !dur) return null;
  const url =
    'https://lrclib.net/api/get?' +
    new URLSearchParams({
      track_name: String(track).slice(0, 120),
      artist_name: String(artist).slice(0, 120),
      album_name: String(album).slice(0, 120),
      duration: String(dur),
    }).toString();
  const res = await httpsGetJson(url);
  if (res.status === 404 || !res.data || typeof res.data !== 'object') return null;
  return res.data;
}

async function fetchLyrics(query = {}) {
  const track = String(query.track || '').trim().slice(0, 120);
  const artist = String(query.artist || '').trim().slice(0, 120);
  const album = String(query.album || '').trim().slice(0, 120);
  const duration = Number(query.duration) || 0;

  if (!track) return { ok: false, error: 'track obrigatório' };

  const key = cacheKey({ track, artist, album, duration });
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;

  let hit = null;
  if (track && artist && album && duration >= 20) {
    hit = await getBySignature({ track, artist, album, duration });
  }

  if (!hit) {
    const list = await searchLyrics({ track, artist });
    if (list.length) {
      const ranked = list
        .map((h) => ({ h, score: scoreHit(h, track, artist, duration) }))
        .filter((x) => x.score >= 6)
        .sort((a, b) => b.score - a.score);
      hit = ranked[0]?.h || null;
      /* duration conhecida: prefere match próximo, mas só entre bons scores */
      if (hit && duration >= 20) {
        const close = ranked.find(
          (x) =>
            x.score >= 8 &&
            x.h.duration &&
            Math.abs(Number(x.h.duration) - duration) <= 4 &&
            (x.h.syncedLyrics || x.h.plainLyrics)
        );
        if (close) hit = close.h;
      }
    }
  }

  const result = packResult(hit);
  /* se o melhor hit ainda parece outra faixa, descarta */
  if (result.ok && hit && scoreHit(hit, track, artist, duration) < 6) {
    const rejected = { ok: false, error: 'letra não encontrada' };
    cache.set(key, { at: Date.now(), result: rejected });
    return rejected;
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

function mountLyricsRoutes(app) {
  app.get('/api/deck/lyrics', async (req, res) => {
    try {
      const track = String(req.query.track || '').trim();
      const artist = String(req.query.artist || '').trim();
      const album = String(req.query.album || '').trim();
      const duration = Number(req.query.duration) || 0;
      if (!track) {
        res.status(400).json({ ok: false, error: 'track obrigatório' });
        return;
      }
      if (track.length > 120 || artist.length > 120 || album.length > 120) {
        res.status(400).json({ ok: false, error: 'query longa demais' });
        return;
      }
      const result = await fetchLyrics({ track, artist, album, duration });
      if (!result.ok) {
        res.status(404).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || 'falha nas letras' });
    }
  });
}

module.exports = { fetchLyrics, parseLrc, stripLrcTags, detectLang, mountLyricsRoutes };
