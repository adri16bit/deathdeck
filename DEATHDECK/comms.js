/**
 * COMMS â€” canal P2P (atÃ© 2 operadores) via salas em memÃ³ria.
 * Sem WebSocket: poll curto + presence.
 * Extras: reply, reactions, QR no client.
 *
 * Peers nÃ£o somem sÃ³ porque a aba foi pro background:
 * - online: heartbeat recente
 * - hold: reserva o assento por um tempo longo
 * - leave explÃ­cito: libera o assento de verdade
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { askCommsCdr, extractMusicPlayIntent, isAdriName, isBlehCmd } = require('../gemini');
const { loadAlbum } = require('./deathmetal');
const {
  searchSpotifyTrack,
  pickSpotifyRadioTrack,
  extractSpotifyRef,
  isConfigured: spotifyConfigured,
} = require('./spotify');

/** @type {Map<string, { code: string, created: number, updated: number, peers: Map<string, object>, messages: object[] }>} */
const rooms = new Map();

const MAX_PEERS = 10;
const DEFAULT_MAX_PEERS = 2;

function roomMaxPeers(room) {
  const n = Number(room?.maxPeers);
  if (!Number.isFinite(n)) return DEFAULT_MAX_PEERS;
  return Math.max(2, Math.min(MAX_PEERS, Math.round(n)));
}

function nextSeat(held) {
  const used = new Set(held.map((p) => p.seat));
  for (let i = 0; i < MAX_PEERS; i += 1) {
    const seat = String.fromCharCode(65 + i); // A..J
    if (!used.has(seat)) return seat;
  }
  return 'X';
}
const MAX_MSG = 100;
const CDR_PEER_ID = 'cdr';
const CDR_NAME = 'CD-R';
const MAX_IMAGE_CHARS = 1200000; /* foto comprimida */
/* 15MB binário ≈ ~20MB em base64; margem pro data-url */
const MAX_GIF_CHARS = 22_000_000;
const MAX_IMAGES_PER_MSG = 6;
const MAX_IMAGES_TOTAL_CHARS = 22_000_000;
/* ~3MB binário em base64 — ~2–3 min de opus/webm */
const MAX_VOICE_CHARS = 4_500_000;
const MAX_VOICE_MS = 1000 * 60 * 2;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const PEER_ONLINE_MS = 1000 * 45;
const PEER_HOLD_MS = 1000 * 60 * 45;
const ROOM_EMPTY_MS = 1000 * 60 * 60;
const ALLOWED_REACTS = new Set(['\u{1F608}', '\u{1F61B}', '\u{1F61D}', '\u{1F525}', '\u{1F44D}']); // 😈 😛 😝 🔥 👍
const STICKERS_PACK = path.join(__dirname, '../public/DEATHDECK/stickers/pack.json');
const STICKERS_DIR = path.join(__dirname, '../public/DEATHDECK/stickers');
const CUSTOM_DIR = path.join(STICKERS_DIR, 'custom');
const CUSTOM_PACK = path.join(STICKERS_DIR, 'custom.json');
const ROOMS_FILE = path.join(__dirname, 'comms-rooms.json');
const MAX_STICKER_CHARS = 2500000;
const MAX_ROOM_CUSTOM_STICKERS = 40;
const MAX_PERSISTED_CUSTOM = 120;
const MAX_AVATAR_CHARS = 120000;
const AVATAR_DIR = path.join(__dirname, '../public/DEATHDECK/avatars');

function ensureAvatarDir() {
  try {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function avatarFileName(code, peerId) {
  const safeCode = String(code || 'x')
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 8)
    .toUpperCase() || 'X';
  const safePeer =
    String(peerId || 'p')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 64) || 'p';
  return `${safeCode}-${safePeer}.jpg`;
}

function peerAvatarUrl(peer) {
  if (!peer?.avatarFile || !peer.avatarAt) return '';
  return `/DEATHDECK/avatars/${peer.avatarFile}?t=${Number(peer.avatarAt) || 0}`;
}

function serializeRoom(room) {
  // não grava base64 de imagem — só mantém o canal/peers vivos após restart
  const leanMsgs = (room.messages || [])
    .filter(
      (m) =>
        m?.sys ||
        (m?.text &&
          !m.image &&
          !(Array.isArray(m.images) && m.images.length) &&
          !m.stickerCustom?.data &&
          !m.voice)
    )
    .slice(-40)
    .map((m) => ({
      id: m.id,
      sys: !!m.sys,
      text: m.text || '',
      at: m.at,
      touch: m.touch || m.at,
      peerId: m.peerId,
      name: m.name,
      seat: m.seat,
      sticker: m.sticker || undefined,
      stickerCustom: m.stickerCustom?.file
        ? {
            id: m.stickerCustom.id,
            file: m.stickerCustom.file,
            kind: m.stickerCustom.kind,
            creator: m.stickerCustom.creator,
            description: m.stickerCustom.description,
          }
        : undefined,
      reply: m.reply || undefined,
      reactions: m.reactions || undefined,
      bot: m.bot ? true : undefined,
    }));
  const leanStickers = [...(room.customStickers || new Map()).entries()].map(([id, s]) => [
    id,
    {
      id: s.id,
      file: s.file || null,
      kind: s.kind || 'image',
      creator: s.creator || '',
      description: s.description || '',
    },
  ]);
  const leanPeers = [...(room.peers || new Map()).entries()].map(([id, p]) => {
    const next = { ...(p || {}) };
    delete next.avatar; /* base64 não persiste; arquivo em /avatars fica */
    return [id, next];
  });
  return {
    code: room.code,
    created: room.created,
    updated: room.updated,
    cdr: !!room.cdr,
    maxPeers: roomMaxPeers(room),
    peers: leanPeers,
    messages: leanMsgs,
    customStickers: leanStickers,
  };
}

function hydrateRoom(raw) {
  return {
    code: String(raw.code || '').toUpperCase(),
    created: Number(raw.created) || Date.now(),
    updated: Number(raw.updated) || Date.now(),
    cdr: !!raw.cdr,
    maxPeers: roomMaxPeers({ maxPeers: raw.maxPeers }),
    peers: new Map(Array.isArray(raw.peers) ? raw.peers : []),
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    customStickers: new Map(Array.isArray(raw.customStickers) ? raw.customStickers : []),
  };
}

function loadRoomsFromDisk() {
  try {
    const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    for (const raw of data.rooms || []) {
      if (!raw?.code) continue;
      rooms.set(String(raw.code).toUpperCase(), hydrateRoom(raw));
    }
  } catch {
    /* primeira vez / arquivo ausente */
  }
}

let roomsSaveTimer = null;
function scheduleSaveRooms() {
  clearTimeout(roomsSaveTimer);
  roomsSaveTimer = setTimeout(() => {
    try {
      const payload = {
        savedAt: Date.now(),
        rooms: [...rooms.values()].map(serializeRoom),
      };
      fs.writeFileSync(ROOMS_FILE, JSON.stringify(payload), 'utf8');
    } catch {
      /* disco cheio / permissão */
    }
  }, 350);
}

loadRoomsFromDisk();

function allowedStickers() {
  try {
    const pack = JSON.parse(fs.readFileSync(STICKERS_PACK, 'utf8'));
    return new Set(
      (pack.stickers || [])
        .map((s) => String(s.id || '').trim().toLowerCase())
        .filter((id) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(id))
    );
  } catch {
    return new Set();
  }
}

function readCustomPack() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOM_PACK, 'utf8'));
  } catch {
    return { stickers: [] };
  }
}

function writeCustomPack(pack) {
  fs.mkdirSync(CUSTOM_DIR, { recursive: true });
  fs.writeFileSync(CUSTOM_PACK, JSON.stringify(pack, null, 2), 'utf8');
}

function findPersistedSticker(id) {
  const want = String(id || '').trim();
  if (!want) return null;
  return (readCustomPack().stickers || []).find((s) => s.id === want) || null;
}

function sanitizeStickerMedia(raw) {
  const src = String(raw || '').replace(/\s+/g, '');
  if (!src || src.length > MAX_STICKER_CHARS) return null;
  if (
    !/^data:(image\/(jpeg|jpg|png|webp|gif)|video\/(webm|mp4));base64,[A-Za-z0-9+/=]+$/i.test(
      src
    )
  ) {
    return null;
  }
  return src;
}

function stickerKindFromData(data) {
  if (/^data:video\//i.test(data)) return 'video';
  if (/^data:image\/gif/i.test(data)) return 'gif';
  return 'image';
}

function extFromData(data) {
  if (/^data:image\/gif/i.test(data)) return 'gif';
  if (/^data:image\/png/i.test(data)) return 'png';
  if (/^data:image\/jpe?g/i.test(data)) return 'jpg';
  if (/^data:video\/mp4/i.test(data)) return 'mp4';
  if (/^data:video\/webm/i.test(data)) return 'webm';
  return 'webp';
}

function dataMimeExt(data) {
  const m = String(data || '').match(/^data:([^;]+);base64,/i);
  const mime = String(m?.[1] || '').toLowerCase();
  if (mime === 'image/gif') return { mime, ext: '.gif' };
  if (mime === 'image/png') return { mime, ext: '.png' };
  if (mime === 'image/jpeg' || mime === 'image/jpg') return { mime, ext: '.jpg' };
  if (mime === 'image/webp') return { mime, ext: '.webp' };
  if (mime === 'video/mp4') return { mime, ext: '.mp4' };
  if (mime === 'video/webm') return { mime, ext: '.webm' };
  return { mime: mime || 'application/octet-stream', ext: '.bin' };
}

/**
 * GIF / vídeo → WebP animado (loop). Se ffmpeg falhar, devolve null e grava o original.
 */
function convertStickerToAnimatedWebp(dataUrl) {
  const exe = findFfmpeg();
  if (!exe || !dataUrl) return null;
  const kind = stickerKindFromData(dataUrl);
  if (kind !== 'gif' && kind !== 'video') return null;
  if (/^data:image\/webp/i.test(dataUrl) && bufferLooksAnimatedWebp(
    Buffer.from(String(dataUrl).replace(/^data:[^;]+;base64,/i, ''), 'base64')
  )) {
    return null; /* já é webp animado */
  }

  const { ext } = dataMimeExt(dataUrl);
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(os.tmpdir(), 'js-lab-sticker-webp');
  const inFile = path.join(dir, `${id}${ext}`);
  const outFile = path.join(dir, `${id}.webp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const b64 = String(dataUrl).replace(/^data:[^;]+;base64,/i, '');
    fs.writeFileSync(inFile, Buffer.from(b64, 'base64'));
    const r = spawnSync(
      exe,
      [
        '-y',
        '-i',
        inFile,
        '-an',
        '-t',
        '5.1',
        '-vf',
        'fps=12,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos',
        '-c:v',
        'libwebp',
        '-lossless',
        '0',
        '-compression_level',
        '4',
        '-q:v',
        '70',
        '-loop',
        '0',
        '-preset',
        'default',
        outFile,
      ],
      { windowsHide: true, timeout: 45000, encoding: 'utf8' }
    );
    if (r.status !== 0 || !fs.existsSync(outFile)) return null;
    const st = fs.statSync(outFile);
    if (st.size < 64 || st.size > 2_800_000) return null;
    const outBuf = fs.readFileSync(outFile);
    if (!bufferLooksAnimatedWebp(outBuf) && kind === 'gif') {
      /* gif estático vira webp estático — ok */
    }
    return `data:image/webp;base64,${outBuf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(inFile);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* ignore */
    }
  }
}

/** Grava figurinha em disco — fica no deck pra sempre. GIF/vídeo viram WebP animado. */
function persistCustomSticker(entry) {
  fs.mkdirSync(CUSTOM_DIR, { recursive: true });
  let data = entry.data;
  let kind = entry.kind || stickerKindFromData(data);
  if (kind === 'gif' || kind === 'video') {
    const converted = convertStickerToAnimatedWebp(data);
    if (converted) {
      data = converted;
      kind = 'image';
    }
  }
  const ext = extFromData(data);
  const fileName = `${entry.id}.${ext}`;
  const rel = `custom/${fileName}`;
  const abs = path.join(CUSTOM_DIR, fileName);
  const b64 = data.replace(/^data:[^;]+;base64,/i, '');
  fs.writeFileSync(abs, Buffer.from(b64, 'base64'));

  const pack = readCustomPack();
  const meta = {
    id: entry.id,
    file: rel,
    kind,
    creator: entry.creator,
    description: entry.description,
    at: Date.now(),
  };
  pack.stickers = (pack.stickers || []).filter((s) => s.id !== entry.id);
  pack.stickers.push(meta);
  while (pack.stickers.length > MAX_PERSISTED_CUSTOM) {
    const old = pack.stickers.shift();
    if (old?.file) {
      try {
        fs.unlinkSync(path.join(STICKERS_DIR, old.file));
      } catch {
        /* ignore */
      }
    }
  }
  writeCustomPack(pack);
  return meta;
}

function leanSticker(meta) {
  if (!meta) return null;
  return {
    id: meta.id,
    file: meta.file || null,
    kind: meta.kind || 'image',
    creator: meta.creator || '',
    description: meta.description || '',
    // data sÃ³ se ainda nÃ£o tem arquivo (legado em memÃ³ria)
    ...(meta.data && !meta.file ? { data: meta.data } : {}),
  };
}

function resolveStickerCustom(room, body, peer) {
  const raw = body?.stickerCustom;
  if (!raw) return null;

  const refId = String(raw.id || raw.ref || '').trim();
  if (refId && !raw.data) {
    const found = room.customStickers?.get(refId);
    if (found) return leanSticker(found);
    const disk = findPersistedSticker(refId);
    if (disk) {
      const lean = leanSticker(disk);
      if (!room.customStickers) room.customStickers = new Map();
      room.customStickers.set(lean.id, lean);
      return lean;
    }
    return null;
  }

  const data = sanitizeStickerMedia(raw.data);
  if (!data) return null;
  const id = /^c[a-z0-9]{6,24}$/i.test(refId)
    ? refId
    : `c${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const entry = {
    id,
    data,
    kind: stickerKindFromData(data),
    creator:
      String(raw.creator || peer.name || 'anon')
        .trim()
        .slice(0, 24) || peer.name,
    description: String(raw.description || '')
      .trim()
      .slice(0, 80),
  };

  let persisted;
  try {
    persisted = persistCustomSticker(entry);
  } catch {
    return null;
  }
  const lean = leanSticker(persisted);
  if (!room.customStickers) room.customStickers = new Map();
  room.customStickers.set(lean.id, lean);
  while (room.customStickers.size > MAX_ROOM_CUSTOM_STICKERS) {
    const first = room.customStickers.keys().next().value;
    room.customStickers.delete(first);
  }
  return lean;
}

function sanitizeImage(raw) {
  const src = String(raw || '');
  if (!src) return null;
  const isGif = /^data:image\/gif;base64,/i.test(src);
  /* gif animado não comprime no canvas — até ~15MB */
  const cap = isGif ? MAX_GIF_CHARS : MAX_IMAGE_CHARS;
  if (src.length > cap) return null;
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(src)) return null;
  return src.replace(/\s+/g, '');
}

function sanitizeImages(body) {
  const out = [];
  const list = Array.isArray(body?.images) ? body.images : [];
  for (const item of list) {
    const img = sanitizeImage(item);
    if (img) out.push(img);
    if (out.length >= MAX_IMAGES_PER_MSG) break;
  }
  // compat: image Ãºnica
  if (!out.length && body?.image) {
    const one = sanitizeImage(body.image);
    if (one) out.push(one);
  }
  const total = out.reduce((n, s) => n + s.length, 0);
  if (total > MAX_IMAGES_TOTAL_CHARS) return null;
  return out;
}

function sanitizeVoice(raw) {
  const src = String(raw || '').replace(/\s+/g, '');
  if (!src) return null;
  if (src.length > MAX_VOICE_CHARS) return null;
  if (
    !/^data:audio\/(webm|ogg|mp4|mpeg|mp3|aac|wav|x-m4a|m4a|x-wav)(;[\w.=-]+)*;base64,[A-Za-z0-9+/=]+$/i.test(
      src
    )
  ) {
    return null;
  }
  return src;
}

function sanitizeVoiceMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_VOICE_MS, Math.round(n));
}

function sanitizeVoiceWave(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const v of raw.slice(0, 48)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out.push(Math.round(Math.max(0.08, Math.min(1, n)) * 1000) / 1000);
  }
  return out.length >= 8 ? out : null;
}

function cleanRooms() {
  const now = Date.now();
  let changed = false;
  for (const [code, room] of rooms) {
    for (const [id, peer] of room.peers) {
      if (now - peer.seen > PEER_HOLD_MS) {
        room.peers.delete(id);
        changed = true;
      }
    }
    const emptyTooLong = room.peers.size === 0 && now - room.updated > ROOM_EMPTY_MS;
    const expired = now - room.updated > ROOM_TTL_MS;
    if (emptyTooLong || expired) {
      rooms.delete(code);
      changed = true;
    }
  }
  if (changed) scheduleSaveRooms();
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) code += alphabet[bytes[i] % alphabet.length];
  if (rooms.has(code)) return makeCode();
  return code;
}

function heldPeers(room, now = Date.now()) {
  return [...room.peers.values()].filter((p) => now - p.seen <= PEER_HOLD_MS);
}

function buildCdrTranscript(room, limit = 80) {
  return (room.messages || [])
    .filter((m) => {
      if (m?.sys) return false;
      const text = String(m?.text || '').trim();
      const hasMedia =
        !!(
          m?.image ||
          (Array.isArray(m?.images) && m.images.length) ||
          m?.sticker ||
          m?.stickerCustom ||
          m?.voice
        );
      return !!(text || hasMedia);
    })
    .slice(-Math.max(4, limit))
    .map((m) => {
      const bits = [];
      const text = String(m?.text || '').trim();
      if (text) bits.push(text);
      const nImg = Array.isArray(m?.images) ? m.images.length : m?.image ? 1 : 0;
      if (nImg) bits.push(nImg > 1 ? `[${nImg} imagens]` : '[imagem]');
      if (m?.voice) bits.push('[áudio]');
      if (m?.sticker) bits.push(`[figurinha:${m.sticker}]`);
      if (m?.stickerCustom) {
        const d = String(m.stickerCustom.description || m.stickerCustom.id || 'custom').slice(0, 40);
        bits.push(`[figurinha:${d}]`);
      }
      const line = `${m.name || '?'}: ${bits.join(' ') || '(mídia)'}`;
      return line.slice(0, 280);
    })
    .join('\n');
}

function parseDataUrlMedia(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  const mimeType = m[1].trim().toLowerCase();
  const data = m[2].replace(/\s/g, '');
  if (!data || data.length > 5_500_000) return null;
  if (!/^(image\/(jpeg|jpg|png|webp|gif)|video\/(webm|mp4))$/i.test(mimeType)) return null;
  return { mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType, data };
}

function fileToInlineMedia(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return null;
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size < 32 || st.size > 4_000_000) return null;
    const ext = path.extname(absPath).toLowerCase();
    const mime =
      {
        '.webp': 'image/webp',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webm': 'video/webm',
        '.mp4': 'video/mp4',
      }[ext] || null;
    if (!mime) return null;
    return { mimeType: mime, data: fs.readFileSync(absPath).toString('base64') };
  } catch {
    return null;
  }
}

function stickerPathById(id) {
  const want = String(id || '').trim().toLowerCase();
  if (!want) return null;
  try {
    const pack = JSON.parse(fs.readFileSync(STICKERS_PACK, 'utf8'));
    const hit = (pack.stickers || []).find((s) => String(s.id || '').toLowerCase() === want);
    if (hit?.file) return path.join(STICKERS_DIR, hit.file);
  } catch {
    /* ignore */
  }
  const disk = findPersistedSticker(want);
  if (disk?.file) return path.join(STICKERS_DIR, disk.file);
  return null;
}

function pushVisionPart(out, part, cap) {
  if (!part || !Array.isArray(out) || out.length >= cap) return;
  if (out.some((x) => x.data === part.data)) return;
  out.push(part);
}

function collectVisionFromMsg(room, msg, out, cap = 4) {
  if (!msg || !out) return;
  const list = Array.isArray(msg.images) && msg.images.length ? msg.images : msg.image ? [msg.image] : [];
  for (const src of list) {
    pushVisionPart(out, parseDataUrlMedia(src), cap);
    if (out.length >= cap) return;
  }
  if (msg.sticker) {
    pushVisionPart(out, fileToInlineMedia(stickerPathById(msg.sticker)), cap);
    if (out.length >= cap) return;
  }
  const sc = msg.stickerCustom;
  if (sc) {
    if (sc.data) pushVisionPart(out, parseDataUrlMedia(sc.data), cap);
    else if (sc.file) pushVisionPart(out, fileToInlineMedia(path.join(STICKERS_DIR, sc.file)), cap);
    else if (sc.id) {
      const fromRoom = room?.customStickers?.get(sc.id);
      if (fromRoom?.data) pushVisionPart(out, parseDataUrlMedia(fromRoom.data), cap);
      else if (fromRoom?.file) {
        pushVisionPart(out, fileToInlineMedia(path.join(STICKERS_DIR, fromRoom.file)), cap);
      } else {
        pushVisionPart(out, fileToInlineMedia(stickerPathById(sc.id)), cap);
      }
    }
  }
}

function collectCdrVision(room, triggerMsg) {
  const media = [];
  collectVisionFromMsg(room, triggerMsg, media, 4);
  const replyId = triggerMsg?.reply?.id;
  if (replyId && media.length < 4) {
    const src = (room.messages || []).find((m) => m.id === replyId && !m.sys);
    if (src) collectVisionFromMsg(room, src, media, 4);
  }
  return media;
}

/** @type {string | null | undefined} */
let cachedFfmpeg;

function findFfmpeg() {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    cachedFfmpeg = process.env.FFMPEG_PATH;
    return cachedFfmpeg;
  }
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) {
      cachedFfmpeg = bundled;
      return cachedFfmpeg;
    }
  } catch {
    /* ignore */
  }
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    const line = String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.toLowerCase().includes('info:'));
    if (line && fs.existsSync(line)) {
      cachedFfmpeg = line;
      return cachedFfmpeg;
    }
  } catch {
    /* ignore */
  }
  const wingetGuess = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft',
    'WinGet',
    'Packages'
  );
  try {
    if (fs.existsSync(wingetGuess)) {
      const hit = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-ChildItem -Path '${wingetGuess.replace(/'/g, "''")}' -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 }
      );
      const p = String(hit.stdout || '').trim().split(/\r?\n/)[0];
      if (p && fs.existsSync(p)) {
        cachedFfmpeg = p;
        return cachedFfmpeg;
      }
    }
  } catch {
    /* ignore */
  }
  cachedFfmpeg = null;
  return null;
}

function bufferLooksAnimatedWebp(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return false;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return false;
  return buf.includes(Buffer.from('ANIM')) || buf.includes(Buffer.from('ANMF'));
}

function shouldExpandToVideo(part) {
  const mime = String(part?.mimeType || '').toLowerCase();
  if (mime === 'image/gif') return true;
  if (mime === 'image/webp' && part?.data) {
    try {
      return bufferLooksAnimatedWebp(Buffer.from(String(part.data), 'base64'));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Gemini trata GIF/WebP animado como frame parado.
 * Converte pra MP4 curto pra o CD-R ver o movimento (precisa de ffmpeg).
 */
function convertAnimatedToMp4(part) {
  const exe = findFfmpeg();
  if (!exe || !part?.data) return null;
  const mime = String(part.mimeType || '').toLowerCase();
  const ext = mime === 'image/gif' ? '.gif' : mime === 'image/webp' ? '.webp' : null;
  if (!ext) return null;

  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(os.tmpdir(), 'js-lab-cdr-vision');
  const inFile = path.join(dir, `${id}${ext}`);
  const outFile = path.join(dir, `${id}.mp4`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(inFile, Buffer.from(String(part.data), 'base64'));
    const r = spawnSync(
      exe,
      [
        '-y',
        '-i',
        inFile,
        '-vf',
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-t',
        '6',
        '-movflags',
        '+faststart',
        outFile,
      ],
      { windowsHide: true, timeout: 20000, encoding: 'utf8' }
    );
    if (r.status !== 0 || !fs.existsSync(outFile)) return null;
    const st = fs.statSync(outFile);
    if (st.size < 64 || st.size > 4_500_000) return null;
    return {
      mimeType: 'video/mp4',
      data: fs.readFileSync(outFile).toString('base64'),
      fromAnimated: true,
    };
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(inFile);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* ignore */
    }
  }
}

/** Prepara mídias: GIF/WebP animado → MP4 pra visão temporal. */
function prepareCdrVision(room, triggerMsg) {
  const raw = collectCdrVision(room, triggerMsg);
  const out = [];
  let animated = 0;
  for (const part of raw) {
    if (shouldExpandToVideo(part)) {
      const vid = convertAnimatedToMp4(part);
      if (vid) {
        out.push(vid);
        animated += 1;
        continue;
      }
    }
    out.push(part);
  }
  return { media: out, animated };
}

const PAPOI_STICKER_ID = 'monki-10';

function listPackStickersForCdr() {
  try {
    const pack = JSON.parse(fs.readFileSync(STICKERS_PACK, 'utf8'));
    const allowed = allowedStickers();
    return (pack.stickers || [])
      .map((s) => {
        const id = String(s.id || '')
          .trim()
          .toLowerCase();
        /* não passa "monki pack" pro modelo — ele evita esses ids e vicia em papoi */
        let description = String(s.description || '')
          .trim()
          .toLowerCase();
        if (!description || /monki|pack|webnosferatu/.test(description)) {
          description = id === PAPOI_STICKER_ID ? 'papoi' : '';
        }
        return { id, description: description.slice(0, 40) };
      })
      .filter((s) => s.id && allowed.has(s.id));
  } catch {
    return [];
  }
}

function rememberCdrSticker(room, id) {
  if (!room || !id) return;
  if (!Array.isArray(room.recentCdrStickers)) room.recentCdrStickers = [];
  room.recentCdrStickers.push(String(id).toLowerCase());
  if (room.recentCdrStickers.length > 10) {
    room.recentCdrStickers = room.recentCdrStickers.slice(-10);
  }
}

/**
 * Escolhe figurinha com variedade. Gemini tende a fixar em papoi —
 * o server decide o id final.
 */
function pickCdrSticker(room, stickers, preferred, opts = {}) {
  const allowPapoi = !!opts.allowPapoi;
  const ids = (stickers || [])
    .map((s) => String(s?.id || s || '').toLowerCase())
    .filter((id) => id && allowedStickers().has(id));
  if (!ids.length) return null;

  const recent = (room?.recentCdrStickers || []).map((x) => String(x).toLowerCase());
  const lastFew = new Set(recent.slice(-4));
  let pool = ids.filter((id) => !lastFew.has(id));
  if (!pool.length) pool = ids.slice();

  if (!allowPapoi) {
    const noPapoi = pool.filter((id) => id !== PAPOI_STICKER_ID);
    /* papoi só ~12% fora de /papoi — evita vício */
    if (noPapoi.length && Math.random() > 0.12) pool = noPapoi;
  }

  let pick = null;
  const pref = preferred ? String(preferred).toLowerCase() : '';
  /* Gemini vicia em papoi — na maioria das vezes o server sorteia */
  if (
    pref &&
    pool.includes(pref) &&
    (allowPapoi || pref !== PAPOI_STICKER_ID) &&
    Math.random() < 0.3
  ) {
    pick = pref;
  } else {
    pick = pool[Math.floor(Math.random() * pool.length)];
  }
  rememberCdrSticker(room, pick);
  return pick;
}

function parseCdrReplyBundle(reply, packIds) {
  const raw = String(reply || '').trim();
  if (!raw) return { text: '', stickerId: null, playSearch: null, playRadio: null };
  const lines = raw.split(/\r?\n/);
  let stickerId = null;
  let playSearch = null;
  let playRadio = null;
  const textLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    let radio = trimmed.match(/^PLAY_RADIO\s+(.+)$/i);
    if (!radio) radio = trimmed.match(/^PLAY_MIX\s+(.+)$/i);
    if (!radio) radio = trimmed.match(/^\[\[\s*play_radio\s*:\s*(.+?)\s*\]\]$/i);
    if (radio) {
      const seed = cleanMusicQuery(radio[1]);
      if (seed && !isWeakMusicQuery(seed)) {
        const mode = /^PLAY_MIX\b/i.test(trimmed) ? 'mix' : 'artist';
        /* "mix de X" no PLAY_RADIO também conta como mix */
        const forceMix = /\b(mix|r[aá]dio|playlist)\b/i.test(radio[1]);
        let seedClean = seed
          .replace(/^(?:mix|r[aá]dio|playlist)\s+(?:de\s+|da\s+|do\s+|com\s+)?/i, '')
          .trim();
        if (!seedClean || isWeakMusicQuery(seedClean)) seedClean = seed;
        playRadio = {
          seed: seedClean,
          mode: forceMix || mode === 'mix' ? 'mix' : 'artist',
        };
      }
      continue;
    }
    let play = trimmed.match(/^PLAY_SEARCH\s+(.+)$/i);
    if (!play) play = trimmed.match(/^\[\[\s*play_search\s*:\s*(.+?)\s*\]\]$/i);
    if (play) {
      const q = cleanMusicQuery(play[1]);
      if (q && !isWeakMusicQuery(q)) playSearch = q;
      continue;
    }
    let m = trimmed.match(/^STICKER\s+([a-z0-9][a-z0-9-]{0,40})\s*$/i);
    if (!m) m = trimmed.match(/^\[\[\s*sticker\s*:\s*([a-z0-9][a-z0-9-]{0,40})\s*\]\]$/i);
    if (!m) m = trimmed.match(/^figurinha\s+([a-z0-9][a-z0-9-]{0,40})\s*$/i);
    if (m && packIds?.has(m[1].toLowerCase())) {
      stickerId = m[1].toLowerCase();
      continue;
    }
    textLines.push(line);
  }
  let text = textLines.join('\n').trim();
  /* às vezes o modelo cola STICKER / PLAY_SEARCH no fim da mesma linha */
  if (!playSearch) {
    const tailPlay = text.match(/\sPLAY_SEARCH\s+(.+?)\s*$/i);
    if (tailPlay) {
      const q = cleanMusicQuery(tailPlay[1].replace(/\s+STICKER\s+\S+$/i, ''));
      if (q && !isWeakMusicQuery(q)) playSearch = q;
      text = text.slice(0, tailPlay.index).trim();
    }
  }
  if (!playRadio) {
    const tailRadio = text.match(/\sPLAY_(?:RADIO|MIX)\s+(.+?)\s*$/i);
    if (tailRadio) {
      const seed = cleanMusicQuery(tailRadio[1].replace(/\s+STICKER\s+\S+$/i, ''));
      if (seed && !isWeakMusicQuery(seed)) {
        playRadio = {
          seed,
          mode: /\bPLAY_MIX\b/i.test(tailRadio[0]) ? 'mix' : 'artist',
        };
      }
      text = text.slice(0, tailRadio.index).trim();
    }
  }
  if (!stickerId && packIds?.size) {
    const tail = text.match(/\sSTICKER\s+([a-z0-9][a-z0-9-]{0,40})\s*$/i);
    if (tail && packIds.has(tail[1].toLowerCase())) {
      stickerId = tail[1].toLowerCase();
      text = text.slice(0, tail.index).trim();
    }
  }
  /* limpa se o modelo vazou a linha técnica no texto */
  text = text
    .replace(/^PLAY_SEARCH\s+.+$/gim, '')
    .replace(/^PLAY_(?:RADIO|MIX)\s+.+$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, stickerId, playSearch, playRadio };
}

function cdrShouldAttachSticker(prompt, mediaCount, bleh) {
  /* ~60% das respostas com figurinha */
  if (bleh) return Math.random() < 0.6;
  if (!prompt && mediaCount > 0) return Math.random() < 0.6;
  return Math.random() < 0.6;
}

function cdrTypingDelayMs(prompt, mediaCount) {
  const len = String(prompt || '').length + (mediaCount ? 40 : 0);
  const base = 1600 + Math.min(2200, Math.floor(len * 28));
  const jitter = 400 + Math.floor(Math.random() * 900);
  return base + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePapoiText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\/+/, '');
}

/** qualquer menção a "papoi" = a figurinha lendária do deck */
function mentionsPapoi(text) {
  return /\bpapoi\b/i.test(normalizePapoiText(text));
}

/** /papoi, /papoi mano, /manda papoi… — pede a figurinha */
function isPapoiCmd(text) {
  const t = normalizePapoiText(text);
  if (!t) return false;
  if (t === 'papoi') return true;
  if (/^papoi\b/.test(t) && t.length <= 48) return true;
  if (/^(manda|envia|joga|solta|bora|quero)\s+(a\s+|essa\s+)?papoi\b/.test(t)) return true;
  return false;
}

function isPapoiStickerMsg(msg) {
  if (!msg) return false;
  if (String(msg.sticker || '').toLowerCase() === PAPOI_STICKER_ID) return true;
  const desc = String(msg.stickerCustom?.description || msg.stickerCustom?.id || '').toLowerCase();
  return /\bpapoi\b/.test(desc);
}

/** fallback curto se o Gemini falhar — nunca as falas longas de marketing */
const PAPOI_FALLBACKS = [
  'papoi kkk',
  'essa aí',
  'sempre',
  'kk presentinho',
  'ela mesmo',
  'obrigado por lembrar',
  'classic',
  'sim kkk',
  'a favorita',
  'não cansa',
];

function rememberPapoiLine(room, line) {
  if (!room) return;
  const t = String(line || '').trim();
  if (!t) return;
  if (!Array.isArray(room.recentPapoiLines)) room.recentPapoiLines = [];
  room.recentPapoiLines.push(t);
  if (room.recentPapoiLines.length > 10) {
    room.recentPapoiLines = room.recentPapoiLines.slice(-10);
  }
}

function pickPapoiFallback(room) {
  const recent = new Set((room?.recentPapoiLines || []).map((s) => String(s).toLowerCase()));
  const pool = PAPOI_FALLBACKS.filter((s) => !recent.has(s.toLowerCase()));
  const list = pool.length ? pool : PAPOI_FALLBACKS;
  return list[Math.floor(Math.random() * list.length)];
}

function papoiAvoidHint(room) {
  const recent = (room?.recentPapoiLines || []).slice(-6);
  if (!recent.length) {
    return (
      'Varie a reação. Evite clichê repetido (quiet luxury, +1000 aura, sigma behavior, "mogga", "lendária" em loop).'
    );
  }
  return (
    `NÃO repita nem parafraseie estas falas recentes suas sobre papoi:\n- ${recent.join('\n- ')}\n` +
    `Varie. Evite clichê (quiet luxury, +1000 aura, sigma behavior, "mogga" em loop).`
  );
}

function shouldCdrJoinPapoi(room, msg) {
  if (!room?.cdr || !msg || msg.sys || msg.cdr) return false;
  const text = String(msg.text || '').trim();
  if (text.startsWith('/')) return false;
  const mentioned = mentionsPapoi(text);
  const sticker = isPapoiStickerMsg(msg);
  if (!mentioned && !sticker) return false;
  const now = Date.now();
  if (room.lastPapoiChatAt && now - room.lastPapoiChatAt < 42000) return false;
  /* sticker sozinha: entra quase sempre; às vezes só observa */
  if (!mentioned && sticker && Math.random() < 0.22) return false;
  return true;
}

/** Nunca vazar nome de pack / id / publisher no chat. */
function scrubStickerPackLeak(text) {
  return String(text || '')
    .replace(/\bpack\s*monki\b/gi, 'figurinha')
    .replace(/\bmonki(?:-\d+)?\b/gi, 'figurinha')
    .replace(/\bwebnosferatu\b/gi, 'alguém')
    .replace(/\b(?:sticker\s*)?pack\b/gi, 'figurinha')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanMusicQuery(q) {
  const raw = String(q || '').trim();
  /* link Spotify/YouTube — não corta nem "limpa" demais */
  if (extractSpotifyRef(raw) || extractYoutubeId(raw) || /(?:youtube\.com|youtu\.be)\//i.test(raw)) {
    const url = raw.match(
      /https?:\/\/[^\s<>"']+|spotify:(?:track|album|playlist):[a-zA-Z0-9]{22}/i
    );
    return (url ? url[0] : raw).slice(0, 300);
  }
  return raw
    .replace(
      /^(?:aquela|essa|este|isto|o|a)\s+(?:m[uú]sica\s+)?(?:do\s+|da\s+|de\s+|dos\s+|das\s+)?/i,
      ''
    )
    .replace(/\s+(?:no\s+youtube|a[ií]|pfv|pf|por\s+favor|pra\s+mim|pro?\s+mim)\s*$/i, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function isWeakMusicQuery(q) {
  if (extractSpotifyRef(q)) return false;
  if (extractYoutubeId(q) || /(?:youtube\.com|youtu\.be)\//i.test(String(q || ''))) return false;
  const t = String(q || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!t || t.length < 2) return true;
  if (
    /^(uma|essa|aquela|ai|algo|qualquer|musica|faixa|som|isso|ela|ele|atual|mesma)(\s+ai|\s+musica|\s+faixa|\s+ai)?$/.test(
      t
    )
  ) {
    return true;
  }
  /* vibe solta ("um som maneiro", "qualquer coisa") — sem nome de faixa/artista */
  const stripped = t
    .replace(
      /\b(um|uma|uns|umas|o|a|os|as|de|do|da|dos|das|pra|para|pro|com|no|na|nos|nas|ai|ae|eh|pfv|pf|por|favor|me|mim|a|gente|nos|voce|vc|escolhe|toca|tocar|coloca|colocar|bota|botar|poe|play|musica|faixa|som|track|song|video|clipe|album)\b/g,
      ' '
    )
    .replace(
      /\b(maneiro|maneirinha|dahora|daora|legal|massa|top|bom|boa|bonito|bonita|foda|brabo|braba|fire|aleatorio|aleatoria|random|surpresa|qualquer|coisa|algo|alguma|gostoso|gostosa|daora|irado|irada)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped || stripped.length < 2) return true;
  return false;
}

/** Elogio/reação sem verbo de colocar/trocar — não dispara play. */
function isMusicCommentOnly(text) {
  const t = String(text || '')
    .trim()
    .replace(/^\/+/, '');
  if (!t) return false;
  if (
    /\b(coloca|bota|p[oô]e|toca|tocar|troca|muda|passa|play|busca|acha|quero\s+ouvir|bora\s+ouvir|vamo[s]?\s+ouvir|pode\s+tocar|pode\s+colocar)\b/i.test(
      t
    )
  ) {
    return false;
  }
  if (
    /^(?:é\s+|eh\s+|tipo\s+|nossa\s+|mano\s+|cara\s+)?(?:dahora|daora|dahora\s+essa|daora\s+essa|foda|foda\s+essa|boa|top|massa|lenda|clássico|classico|essa|isso|demais|amei|adorei|gosto|brabo|braba|fire|perfeita|perfeito|ótima|otima|linda|lindo)(?:\s+essa|\s+demais|\s+pra\s+caralho)?[\s,.!?k]*$/i.test(
      t
    )
  ) {
    return true;
  }
  if (t.length <= 48 && /\b(dahora|daora|clássico|classico|lenda|amei|top\b|massa\b)\b/i.test(t)) {
    return true;
  }
  return false;
}

function normalizeTrackKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*official[^)]*\)/gi, '')
    .replace(/\b(official|video|audio|lyrics|hd|mv|topic)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Evita re-tocar a mesma faixa quando o Gemini inventa PLAY_SEARCH no elogio. */
function queryMatchesListening(peer, query) {
  const L = peer?.listening;
  if (!L?.title) return false;
  const q = normalizeTrackKey(query);
  const title = normalizeTrackKey(L.title);
  if (!q || q.length < 3) return true;
  if (title.includes(q) || q.includes(title)) return true;
  const qTokens = q.split(' ').filter((w) => w.length > 2);
  const tTokens = new Set(title.split(' ').filter((w) => w.length > 2));
  if (qTokens.length >= 2) {
    const hit = qTokens.filter((w) => tTokens.has(w)).length;
    if (hit / qTokens.length >= 0.7) return true;
  }
  return false;
}

function looksLikeMusicRequest(text) {
  if (extractSpotifyRef(text)) return true;
  return /\b(m[uú]sica|musica|faixa|track|song|youtube|\byt\b|spotify|tocar|toca|coloca|bota|p[oô]e|troca|ouvir|escutar|play|passa|busca|acha|dj|som|album|[aá]lbum)\b/i.test(
    String(text || '')
  );
}

/**
 * Heurística rápida pra pedidos óbvios em PT.
 * @returns {string|null} query de busca
 */
function heuristicMusicQuery(text) {
  const t = String(text || '')
    .trim()
    .replace(/^cdr\s*[,:]?\s+/i, '')
    .replace(/^(?:por\s+favor|pfv|pf)\s+/i, '');
  if (!t) return null;

  if (extractSpotifyRef(t)) {
    return cleanMusicQuery(t);
  }

  const patterns = [
    /^(?:consegue\s+)?(?:pode\s+)?(?:me\s+)?(?:coloca|bota|p[oô]e|passa|toca|play|busca|acha)\s+(?:pra\s+mim\s+)?(?:a\s+m[uú]sica\s+)?(.+)$/i,
    /^(?:troca|muda)(?:\s+a\s+m[uú]sica)?(?:\s+(?:pra|para|por|pro))?\s+(.+)$/i,
    /^(?:quero\s+(?:ouvir|escutar)|bora\s+ouvir|vamo[s]?\s+ouvir)\s+(.+)$/i,
    /^(?:pode\s+)?(?:tocar|colocar|botar)\s+(.+)$/i,
    /^(?:p[oô]e|bota|coloca)\s+(?:pra\s+)?tocar\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const q = cleanMusicQuery(m[1]);
    if (q && !isWeakMusicQuery(q)) return q;
  }
  return null;
}

/**
 * @returns {Promise<{ play: boolean, query?: string, askWhich?: boolean }>}
 */
async function resolveMusicPlayIntent(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return { play: false };

  const hq = heuristicMusicQuery(text);
  if (hq) return { play: true, query: hq };

  /* pediu trocar/colocar sem nome claro */
  if (
    /^(?:troca|muda|coloca|bota|toca|play)(?:\s+a\s+m[uú]sica)?\s*[.!?…]*$/i.test(text) ||
    /^(?:troca|muda)\s+a\s+m[uú]sica\s*[.!?…]*$/i.test(text)
  ) {
    return { play: false, askWhich: true };
  }

  /* sempre pergunta o Gemini — papo solto conta */
  try {
    const intent = await extractMusicPlayIntent(text);
    if (intent?.play && intent.query && !isWeakMusicQuery(intent.query)) {
      return { play: true, query: cleanMusicQuery(intent.query) };
    }
  } catch {
    /* segue conversa normal */
  }
  return { play: false };
}

async function applyCdrMusicPlay(room, peer, query, opts = {}) {
  if (!peer || !query) return null;
  /* pedido single mata o rádio contínuo */
  if (!opts.keepRadio) peer.radio = null;
  const music = await runCdrToca(room, peer, query, opts);
  if (music?.play) {
    peer.pendingPlay = { ...music.play, at: Date.now() };
  }
  return music;
}

function clearPeerRadio(peer) {
  if (peer) peer.radio = null;
}

function rememberRadioPlay(peer, play) {
  if (!peer?.radio || !play) return;
  if (!Array.isArray(peer.radio.history)) peer.radio.history = [];
  const id =
    play.kind === 'spotify'
      ? String(play.id || play.uri || '')
      : String(play.videoId || '');
  if (id) peer.radio.history.push(id);
  if (peer.radio.history.length > 40) {
    peer.radio.history = peer.radio.history.slice(-40);
  }
}

async function buildRadioPlay(peer) {
  const radio = peer?.radio;
  if (!radio?.seed) return null;
  const excludeIds = radio.history || [];
  const mode = radio.mode === 'mix' ? 'mix' : 'artist';
  const forceYt = radio.prefer === 'yt' || wantsYoutubeOnly(radio.seed);
  let spot = null;
  if (!forceYt && spotifyConfigured()) {
    spot = await pickSpotifyRadioTrack(radio.seed, { mode, excludeIds });
  }
  let ytHit = null;
  const ytSeed =
    mode === 'artist' ? radio.seed : spot?.title || radio.seed;
  if (!spot?.uri) {
    ytHit = await pickYoutubeRadioTrack(ytSeed, { mode, excludeIds });
    if (!ytHit?.videoId) return null;
  } else {
    try {
      ytHit = await pickYoutubeRadioTrack(spot.title || ytSeed, {
        mode: 'mix',
        excludeIds,
      });
    } catch {
      ytHit = null;
    }
  }
  const title = spot?.title || ytHit?.title || radio.seed;
  if (spot?.uri) {
    return {
      kind: 'spotify',
      uri: spot.uri,
      id: spot.id,
      title,
      seek: 0,
      radio: true,
      ytFallback: ytHit?.videoId
        ? { kind: 'yt', videoId: ytHit.videoId, title: ytHit.title || title, seek: 0 }
        : null,
    };
  }
  return {
    kind: 'yt',
    videoId: ytHit.videoId,
    title,
    seek: 0,
    radio: true,
  };
}

async function applyRadioPlay(room, peer, play, opts = {}) {
  if (!peer || !play?.kind) return null;
  rememberRadioPlay(peer, play);
  peer.listening = leanListening({
    title: play.title,
    kind: play.kind,
    videoId: play.kind === 'yt' ? play.videoId : undefined,
    id: play.kind === 'spotify' ? play.id : undefined,
    uri: play.kind === 'spotify' ? play.uri : undefined,
    pos: 0,
    posAt: Date.now(),
  });
  peer.alongWith = null;
  peer.pendingPlay = { ...play, at: Date.now() };
  if (!opts.silent) {
    const via = playSourceLabel(play.kind);
    const tag = peer.radio?.mode === 'mix' ? 'mix' : 'rádio';
    pushSys(
      room,
      opts.first
        ? `${peer.name} ligou ${tag} · ${peer.radio.seed} · ${play.title}${via}`
        : `${peer.name} · próxima · ${play.title}${via}`
    );
  }
  scheduleSaveRooms();
  return play;
}

async function runCdrRadio(room, peer, seed, opts = {}) {
  const extraMsgs = [];
  const cleanSeed = cleanMusicQuery(seed);
  if (!peer || !cleanSeed || isWeakMusicQuery(cleanSeed)) {
    extraMsgs.push(sayAsCdrOrDeck(room, 'manda o nome da banda ou o clima do mix'));
    return { play: null, extraMsgs };
  }
  const mode = opts.mode === 'mix' ? 'mix' : 'artist';
  const prefer = wantsYoutubeOnly(String(seed || ''))
    ? 'yt'
    : opts.prefer || 'auto';
  peer.radio = {
    mode,
    seed: cleanSeed,
    prefer,
    history: [],
    startedAt: Date.now(),
  };
  if (!opts.skipIntro) {
    await sleep(400 + Math.floor(Math.random() * 500));
    extraMsgs.push(
      sayAsCdrOrDeck(
        room,
        mode === 'mix'
          ? `belezinha, mix de ${cleanSeed} — quando acabar eu passo a próxima`
          : `ok, só ${cleanSeed} no rádio — acaba uma, entra outra`
      )
    );
  }
  const play = await buildRadioPlay(peer);
  if (!play) {
    peer.radio = null;
    extraMsgs.push(
      sayAsCdrOrDeck(room, 'não achei faixa pra esse rádio kkk tenta outro nome')
    );
    return { play: null, extraMsgs };
  }
  await applyRadioPlay(room, peer, play, { first: true, silent: !!opts.skipSys });
  return { play, extraMsgs };
}

async function advancePeerRadio(room, peer) {
  if (!peer?.radio?.seed) return null;
  const play = await buildRadioPlay(peer);
  if (!play) {
    peer.radio = null;
    pushSys(room, `${peer.name} · rádio acabou as ideias`);
    return null;
  }
  await applyRadioPlay(room, peer, play, { first: false });
  return play;
}

function extractRadioIntent(text) {
  const t = String(text || '')
    .trim()
    .replace(/^\/\s*/, '');
  if (!t) return null;
  let m = t.match(
    /^(?:(?:por\s+favor|pfv|pf)\s+)?(?:(?:consegue|pode|quero|bora|vamo[s]?|faz|fazum|manda|liga|rola)\s+)?(?:(?:me\s+)?(?:coloca|bota|p[oô]e|toca|play)\s+)?(?:um\s+|uma\s+)?(?:mix|r[aá]dio|playlist)\s+(?:de\s+|da\s+|do\s+|com\s+|tipo\s+(?:do\s+)?(?:yt|youtube\s+)?)?(.+)$/i
  );
  if (m) {
    let seed = cleanMusicQuery(m[1]);
    seed = seed
      .replace(/^(?:mix|r[aá]dio|playlist)\s+(?:de\s+|da\s+|do\s+)?/i, '')
      .trim();
    if (seed && !isWeakMusicQuery(seed)) return { mode: 'mix', seed };
  }
  m = t.match(
    /^(?:coloca|bota|p[oô]e|toca|play)?\s*s[oó]\s+(?:m[uú]sica\s+)?(?:d[eoa]s?\s+|dessa\s+banda\s+)?(.+)$/i
  );
  if (m) {
    const seed = cleanMusicQuery(m[1]);
    if (seed && !isWeakMusicQuery(seed)) return { mode: 'artist', seed };
  }
  m = t.match(
    /^(?:s[oó]\s+m[uú]sica\s+(?:d[eoa]s?\s+)?|apenas\s+(?:m[uú]sica\s+)?(?:d[eoa]s?\s+)?)(.+)$/i
  );
  if (m) {
    const seed = cleanMusicQuery(m[1]);
    if (seed && !isWeakMusicQuery(seed)) return { mode: 'artist', seed };
  }
  /* "tipo mix do youtube", "um radiozinho de X" */
  m = t.match(
    /\b(?:mix|r[aá]diozinho|r[aá]dio|playlist)\s+(?:tipo\s+)?(?:do\s+)?(?:yt|youtube\s+)?(?:de\s+|da\s+|do\s+|com\s+)?(.{2,80})$/i
  );
  if (m && /\b(mix|r[aá]dio|playlist|s[oó]\s+m[uú]sica)\b/i.test(t)) {
    const seed = cleanMusicQuery(m[1]);
    if (seed && !isWeakMusicQuery(seed)) return { mode: 'mix', seed };
  }
  return null;
}

function takePendingPlay(peer) {
  if (!peer?.pendingPlay) return null;
  const pending = peer.pendingPlay;
  peer.pendingPlay = null;
  const at = Number(pending.at) || 0;
  if (at && Date.now() - at > 45000) return null;
  const play = { ...pending };
  delete play.at;
  if (!play.kind) return null;
  return play;
}

function pushCdrMessage(room, text, extra = {}) {
  const now = Date.now();
  const stickerRaw = String(extra.sticker || '')
    .trim()
    .toLowerCase();
  const sticker = stickerRaw && allowedStickers().has(stickerRaw) ? stickerRaw : null;
  const msg = {
    id: `cdr-${now}-${crypto.randomBytes(2).toString('hex')}`,
    peerId: CDR_PEER_ID,
    name: CDR_NAME,
    seat: 'CDR',
    bot: true,
    text: scrubStickerPackLeak(String(text || '').trim()).slice(0, 2000),
    at: now,
    touch: now,
    reactions: {},
  };
  if (sticker) {
    msg.sticker = sticker;
    msg.text = '';
  }
  if (extra.reply && extra.reply.id && !sticker) {
    msg.reply = {
      id: extra.reply.id,
      name: extra.reply.name || '?',
      text: String(extra.reply.text || '').slice(0, 140),
    };
  }
  if (extra.playAnnounce) {
    msg.playAnnounce = true;
    msg.playForPeer = String(extra.playForPeer || '').slice(0, 64);
    msg.playTitle = String(extra.playTitle || '').slice(0, 140);
    msg.playSource = extra.playSource === 'spotify' ? 'spotify' : 'yt';
  }
  room.messages.push(msg);
  if (room.messages.length > MAX_MSG) room.messages = room.messages.slice(-MAX_MSG);
  room.updated = now;
  scheduleSaveRooms();
  return msg;
}

async function pushCdrHumanReply(room, triggerMsg, who, text, stickerId, stickers) {
  const clean = String(text || '').trim();
  const sticker =
    stickerId && allowedStickers().has(String(stickerId).toLowerCase())
      ? String(stickerId).toLowerCase()
      : null;
  /* texto e figurinha SEMPRE em bolhas separadas; figurinha SEM reply/quote */
  if (clean) {
    pushCdrMessage(room, clean);
  }
  if (sticker) {
    if (clean) await sleep(700 + Math.floor(Math.random() * 900));
    pushCdrMessage(room, '', { sticker });
  }
}

async function replyAsCdr(room, triggerMsg, opts = {}) {
  const ambientPapoi = opts?.ambient === 'papoi';
  const raw = String(triggerMsg?.text || '').trim();
  const prompt = raw.replace(/^\/\s*/, '').trim();
  const prepared = prepareCdrVision(room, triggerMsg);
  const media = prepared.media;
  if (!ambientPapoi && !prompt && !media.length) {
    pushCdrMessage(room, 'manda texto depois do `/`, ou anexa imagem/figurinha — tipo `/oi` ou responde uma foto com `/o que é isso`');
    return;
  }
  const who = String(triggerMsg?.name || 'alguém').trim() || 'alguém';
  const bleh = !ambientPapoi && isAdriName(who) && isBlehCmd(prompt);
  const peer = findPeer(room, triggerMsg?.peerId);

  /* easter egg · /papoi → figurinha + reação natural (sem falas engessadas) */
  if (!ambientPapoi && prompt && isPapoiCmd(prompt) && !media.length) {
    room.lastPapoiChatAt = Date.now();
    await sleep(900 + Math.floor(Math.random() * 700));
    const canSticker = allowedStickers().has(PAPOI_STICKER_ID);
    if (canSticker) {
      pushCdrMessage(room, '', { sticker: PAPOI_STICKER_ID });
      await sleep(650 + Math.floor(Math.random() * 500));
    }
    const transcript = buildCdrTranscript(room, 28);
    const userPayload =
      `Canal COMMS — histórico recente:\n` +
      `${transcript || '(ainda sem mensagens)'}\n\n` +
      `${who} pediu a papoi (${raw || '/papoi'}).\n` +
      `papoi = a figurinha lendária/favorita do deck (você JÁ mandou a figurinha).\n` +
      `Agora manda UMA reação curta e humana no chat — como amigo no grupo, não propaganda.\n` +
      `Pode zoar quem pediu, concordar de leve, ou falar quase nada ("kkk", "ela").\n` +
      `${papoiAvoidHint(room)}\n` +
      `SEM PLAY_SEARCH. SEM linha STICKER (figurinha já foi).`;
    const result = await askCommsCdr(userPayload, [], { bleh: false, media: [], stickers: [], withSticker: false });
    let line = scrubStickerPackLeak(parseCdrReplyBundle(result?.reply || '', new Set()).text || '');
    if (!result?.ok || !line) line = pickPapoiFallback(room);
    pushCdrMessage(room, line);
    rememberPapoiLine(room, line);
    return;
  }

  /* menção / figurinha papoi sem / — entra no papo */
  if (ambientPapoi) {
    room.lastPapoiChatAt = Date.now();
    await sleep(1100 + Math.floor(Math.random() * 900));
    const transcript = buildCdrTranscript(room, 32);
    const viaSticker = isPapoiStickerMsg(triggerMsg) && !mentionsPapoi(prompt);
    const userPayload =
      `Canal COMMS — histórico recente:\n` +
      `${transcript || '(ainda sem mensagens)'}\n\n` +
      (viaSticker
        ? `${who} mandou a figurinha papoi (sem /).\n`
        : `${who} falou de papoi no chat (sem /):\n${prompt || '(…)'}\n`) +
      `papoi = a figurinha lendária/favorita do deck. Você ENTENDE que é sobre ela e ENTRA na conversa.\n` +
      `Resposta curta, natural, no clima do histórico. Não force hype de marketing.\n` +
      `${papoiAvoidHint(room)}\n` +
      `SEM PLAY_SEARCH. SEM linha STICKER (a menos que o papo peça de verdade — neste caso NÃO mande).`;
    const result = await askCommsCdr(userPayload, [], {
      bleh: false,
      media: prepareCdrVision(room, triggerMsg).media,
      stickers: [],
      withSticker: false,
    });
    let line = scrubStickerPackLeak(parseCdrReplyBundle(result?.reply || '', new Set()).text || '');
    if (!result?.ok || !line) line = pickPapoiFallback(room);
    pushCdrMessage(room, line);
    rememberPapoiLine(room, line);
    return;
  }

  /* link Spotify (open.spotify.com / spotify:track:…) → toca a faixa do link */
  if (!ambientPapoi && peer && !bleh && extractSpotifyRef(prompt || raw)) {
    await applyCdrMusicPlay(room, peer, prompt || raw, { skipIntro: false });
    return;
  }

  /* mix / rádio / só dessa banda */
  if (!ambientPapoi && peer && !bleh && prompt) {
    const radioIntent = extractRadioIntent(prompt);
    if (radioIntent) {
      const music = await runCdrRadio(room, peer, radioIntent.seed, {
        mode: radioIntent.mode,
        skipIntro: false,
      });
      for (const m of music.extraMsgs || []) {
        /* already pushed */
      }
      return;
    }
  }

  /* "coloca" / "toca" sozinho — pergunta qual, sem tratar como comando */
  if (
    prompt &&
    !bleh &&
    !media.length &&
    /^(?:troca|muda|coloca|bota|toca|play)(?:\s+a\s+m[uú]sica)?\s*[.!?…]*$/i.test(prompt)
  ) {
    await sleep(cdrTypingDelayMs(prompt, 0));
    pushCdrMessage(room, 'qual música? manda o nome ou artista');
    return;
  }

  const stickers = listPackStickersForCdr();
  const packIds = new Set(stickers.map((s) => s.id));
  const withSticker = cdrShouldAttachSticker(prompt, media.length, bleh) && stickers.length > 0;
  const animHint = prepared.animated
    ? `\nAtenção: ${prepared.animated} mídia(s) animada(s) (GIF/WebP) foram convertidas pra vídeo curto — descreve o MOVIMENTO/loop, não só um frame parado.`
    : '';
  const papoiHint = mentionsPapoi(prompt)
    ? `\nNota: "papoi" = a figurinha lendária/favorita do deck. Qualquer menção é SOBRE ELA — entra no papo, sem virar propaganda repetida. ${papoiAvoidHint(room)}`
    : '';

  await sleep(cdrTypingDelayMs(prompt, media.length));

  const transcript = buildCdrTranscript(room, 40);
  const nowPlaying = peer?.listening?.title
    ? `\nAgora tocando pra ${who}: ${peer.listening.title}. Elogio/comentário disso = SEM PLAY_SEARCH. Só PLAY_SEARCH se pedir OUTRA música ou trocar.`
    : `\nNinguém pediu play ainda pra ${who}. Só use PLAY_SEARCH se pedir pra tocar algo.`;
  let userPayload;
  if (bleh) {
    userPayload =
      `Canal COMMS — histórico recente:\n` +
      `${transcript || '(ainda sem mensagens de texto)'}\n\n` +
      `Adri mandou: /bleh\n\n` +
      `Reage COM MEDO agora. NÃO diga o motivo — nunca.`;
  } else if (media.length && !prompt) {
    userPayload =
      `Canal COMMS — histórico recente:\n` +
      `${transcript || '(ainda sem mensagens)'}\n\n` +
      `${who} mandou / com ${media.length} mídia(s) (imagem/figurinha/gif/vídeo).\n` +
      `Olha a(s) mídia(s) anexada(s) e reage em uma mensagem de chat` +
      (withSticker ? `, terminando com STICKER id.` : `.`) +
      animHint +
      papoiHint;
  } else if (media.length) {
    userPayload =
      `Canal COMMS — histórico recente:\n` +
      `${transcript || '(ainda sem mensagens)'}\n\n` +
      `${who} pediu com /:\n${prompt}\n\n` +
      `Há ${media.length} mídia(s) anexada(s). Olha e responde direto a ${who}` +
      (withSticker ? `, e termina com STICKER id.` : `.`) +
      nowPlaying +
      animHint +
      papoiHint;
  } else {
    userPayload =
      `Canal COMMS — histórico recente:\n` +
      `${transcript || '(ainda sem mensagens de texto)'}\n\n` +
      `${who} pediu com /:\n${prompt}\n\n` +
      `Responde direto a ${who}, em uma mensagem de chat.` +
      nowPlaying +
      ` Se pediu música (mesmo vibe solta tipo "coloca um som maneiro"), escolhe UMA faixa concreta e usa PLAY_SEARCH com artista + nome — NUNCA busque a frase do pedido.` +
      ` Se pediu MIX / rádio / "só música dessa banda": PLAY_RADIO <artista ou clima> (o sistema toca e passa pra próxima sozinho).` +
      (withSticker ? ` STICKER id no fim se for figurinha.` : ``) +
      papoiHint;
  }
  const result = await askCommsCdr(userPayload, [], {
    bleh,
    media,
    stickers,
    withSticker,
  });
  if (!result?.ok) {
    pushCdrMessage(room, result?.error || 'chiado no link — tenta de novo');
    return;
  }
  const bundle = parseCdrReplyBundle(result.reply, packIds);

  if (bundle.playRadio?.seed && peer) {
    if (bundle.text) pushCdrMessage(room, bundle.text);
    else {
      pushCdrMessage(
        room,
        bundle.playRadio.mode === 'mix'
          ? `belezinha, mix de ${bundle.playRadio.seed} — passo a próxima sozinho`
          : `ok, rádio ${bundle.playRadio.seed} — acaba uma, entra outra`
      );
    }
    const music = await runCdrRadio(room, peer, bundle.playRadio.seed, {
      mode: bundle.playRadio.mode,
      skipIntro: true,
      skipSys: false,
    });
    if (!music?.play) {
      /* runCdrRadio já avisou; limpa pending morto */
      if (peer.pendingPlay) peer.pendingPlay = null;
    }
    return;
  }

  /* Gemini mandou PLAY_SEARCH mas o pedido era mix/rádio → sobe pra rádio */
  const radioFromPrompt = extractRadioIntent(prompt);
  if (radioFromPrompt && peer) {
    if (bundle.text) pushCdrMessage(room, bundle.text);
    await runCdrRadio(room, peer, radioFromPrompt.seed, {
      mode: radioFromPrompt.mode,
      skipIntro: true,
      skipSys: false,
    });
    return;
  }

  let playQuery = bundle.playSearch || null;
  if (playQuery && isMusicCommentOnly(prompt)) playQuery = null;
  if (playQuery && isWeakMusicQuery(playQuery)) playQuery = null;
  if (playQuery && queryMatchesListening(peer, playQuery)) playQuery = null;

  /* fallback: Gemini esqueceu PLAY_SEARCH — só se parecer pedido real (não elogio) */
  if (
    !playQuery &&
    !bleh &&
    prompt &&
    peer &&
    looksLikeMusicRequest(prompt) &&
    !isMusicCommentOnly(prompt)
  ) {
    try {
      const intent = await extractMusicPlayIntent(prompt);
      if (intent?.play && intent.query && !isWeakMusicQuery(intent.query)) {
        const q = cleanMusicQuery(intent.query);
        if (q && !queryMatchesListening(peer, q)) playQuery = q;
      } else if (
        /^(?:troca|muda|coloca|bota|toca|play)(?:\s+a\s+m[uú]sica)?\s*[.!?…]*$/i.test(prompt)
      ) {
        if (bundle.text) {
          await pushCdrHumanReply(
            room,
            triggerMsg,
            who,
            bundle.text,
            withSticker
              ? pickCdrSticker(room, stickers, bundle.stickerId, {
                  allowPapoi: mentionsPapoi(prompt),
                })
              : null,
            stickers
          );
        } else {
          pushCdrMessage(room, 'qual música? manda o nome ou artista');
        }
        return;
      }
    } catch {
      /* ignore */
    }
  }

  if (playQuery && peer) {
    const chatText =
      bundle.text ||
      `belezinha ${who.split(/\s/)[0]}, deixa eu achar isso…`;
    pushCdrMessage(room, chatText);
    await applyCdrMusicPlay(room, peer, playQuery, { skipIntro: true });
    if (withSticker && (bundle.stickerId || stickers?.length)) {
      await sleep(500 + Math.floor(Math.random() * 600));
      const sticker = pickCdrSticker(room, stickers, bundle.stickerId, {
        allowPapoi: mentionsPapoi(prompt),
      });
      if (sticker) pushCdrMessage(room, '', { sticker });
    }
    return;
  }

  if (withSticker) {
    const sticker = pickCdrSticker(room, stickers, bundle.stickerId, {
      allowPapoi: mentionsPapoi(prompt),
    });
    await pushCdrHumanReply(room, triggerMsg, who, bundle.text, sticker, stickers);
  } else {
    /* Gemini às vezes manda STICKER mesmo sem pedido — ignora pra não spammar */
    pushCdrMessage(room, bundle.text || result.reply);
  }
  if (mentionsPapoi(prompt) && bundle.text) rememberPapoiLine(room, bundle.text);
}

function scheduleCdrReply(room, triggerMsg, opts = {}) {
  if (!room?.cdr) return;
  const text = String(triggerMsg?.text || '').trim();
  const hasMedia =
    !!(
      triggerMsg?.image ||
      (Array.isArray(triggerMsg?.images) && triggerMsg.images.length) ||
      triggerMsg?.sticker ||
      triggerMsg?.stickerCustom
    );
  const ambient = opts?.ambient || null;
  const spotLink = !!extractSpotifyRef(text);
  /* /texto, link Spotify, ambient papoi, ou / respondendo mídia */
  if (!ambient && !text.startsWith('/') && !spotLink) return;
  if (isMusicSlash(text)) return;
  const prompt = text.replace(/^\/\s*/, '').trim();
  if (!ambient && !prompt && !hasMedia && !triggerMsg?.reply) return;

  if (room.cdrBusy) {
    room.cdrQueued = { msg: triggerMsg, opts };
    return;
  }
  room.cdrBusy = true;
  (async () => {
    try {
      await replyAsCdr(room, triggerMsg, opts);
    } catch (err) {
      pushCdrMessage(room, err?.message || 'link do CD-R caiu');
    } finally {
      room.cdrBusy = false;
      const next = room.cdrQueued;
      room.cdrQueued = null;
      if (next?.msg) scheduleCdrReply(room, next.msg, next.opts || {});
      else if (next && !next.msg) scheduleCdrReply(room, next);
    }
  })();
}

function extractYoutubeId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m = s.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,15})/i
  );
  if (m) return m[1];
  /* ID solto (11 chars) — não aceitar "kkkkkkkkkkk" / spam de letra repetida */
  if (/^[A-Za-z0-9_-]{11}$/.test(s) && !/^(.)\1{10}$/i.test(s)) return s;
  return null;
}

function isMusicSlash(text) {
  const t = String(text || '').trim();
  if (/^\/comando(s)?\b/i.test(t) || /^\/help\b/i.test(t)) return true;
  if (/^\/music\b/i.test(t)) return true;
  if (/^\/mix\b/i.test(t) || /^\/radio\b/i.test(t) || /^\/r[aá]dio\b/i.test(t)) return true;
  if (/^\/stop\b/i.test(t)) return true;
  if (/^\/resume\b/i.test(t) || /^\/play\b/i.test(t)) return true;
  if (/^\/yt\b/i.test(t)) return true;
  if (/^\/junto\b/i.test(t) || /^\/join\b/i.test(t) || /^\/ouvir\b/i.test(t)) return true;
  const bare = t.replace(/^\//, '').trim();
  /* URL do YouTube — com ou sem / na frente */
  if (/(?:youtube\.com|youtu\.be)\//i.test(bare)) {
    return !!extractYoutubeId(bare);
  }
  /* ID solto só conta se veio com / — ex: /dQw4w9WgXcQ (não "kkkkkkkkkkk" no chat) */
  if (/^\/[A-Za-z0-9_-]{11}$/.test(t)) {
    return !!extractYoutubeId(t.slice(1));
  }
  return false;
}

function normTrackKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&gt;/g, '>')
    .replace(/[^a-z0-9>]+/g, '');
}

function findAlbumTrack(tracks, query) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (/^\d{1,2}$/.test(q)) {
    const n = Number(q);
    return tracks.find((t) => Number(t.num) === n) || tracks[n - 1] || null;
  }
  const nq = normTrackKey(q);
  const list = tracks || [];
  let hit = list.find((t) => normTrackKey(t.title) === nq);
  if (hit) return hit;
  hit = list.find((t) => normTrackKey(t.title).includes(nq));
  if (hit) return hit;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (
    list.find((t) => {
      const title = String(t.title || '').toLowerCase();
      return words.every((w) => title.includes(w));
    }) || null
  );
}

function fetchJsonHttps(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { 'User-Agent': 'DeathDeck/1.0', Accept: 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
          if (body.length > 200000) {
            req.destroy();
            reject(new Error('resposta grande'));
          }
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

function postJsonHttps(url, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(payload || {});
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
          if (raw.length > 2_000_000) {
            req.destroy();
            reject(new Error('resposta grande'));
          }
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(body);
    req.end();
  });
}

function pickFirstInnertubeVideo(data) {
  const list = pickInnertubeVideos(data, 1);
  return list[0] || null;
}

function pickInnertubeVideos(data, limit = 8) {
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  const out = [];
  const sections =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer
      ?.contents ||
    data?.contents?.sectionListRenderer?.contents ||
    [];
  for (const section of sections) {
    const items = section?.itemSectionRenderer?.contents || [];
    for (const item of items) {
      const v = item?.videoRenderer || item?.compactVideoRenderer;
      if (!v?.videoId) continue;
      const title =
        v.title?.runs?.map((r) => r.text).join('') ||
        v.title?.simpleText ||
        'YouTube';
      const uploader =
        v.ownerText?.runs?.[0]?.text ||
        v.shortBylineText?.runs?.[0]?.text ||
        '';
      out.push({
        videoId: String(v.videoId),
        title: String(title).slice(0, 140),
        uploader: String(uploader).slice(0, 80),
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

async function searchYoutubeInnertube(query) {
  const list = await searchYoutubeInnertubeMany(query, 1);
  return list[0] || null;
}

async function searchYoutubeInnertubeMany(query, limit = 8) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return [];
  const url =
    'https://www.youtube.com/youtubei/v1/search?prettyPrint=false&key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  const data = await postJsonHttps(url, {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20250222.10.00',
        hl: 'pt',
        gl: 'BR',
      },
    },
    query: q,
  });
  return pickInnertubeVideos(data, limit);
}

async function youtubeTitle(videoId) {
  try {
    const url =
      'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const data = await fetchJsonHttps(url);
    return String(data?.title || '').trim().slice(0, 120) || `YouTube ${videoId}`;
  } catch {
    return `YouTube ${videoId}`;
  }
}

function videoIdFromPipedItem(hit) {
  if (!hit || typeof hit !== 'object') return null;
  let id = hit.videoId || hit.id || null;
  if (id && /^[A-Za-z0-9_-]{6,15}$/.test(String(id))) return String(id);
  const url = String(hit.url || hit.webpage_url || '');
  if (!url) return null;
  return (
    extractYoutubeId(url) ||
    extractYoutubeId(`https://www.youtube.com${url.startsWith('/') ? url : `/${url}`}`)
  );
}

/**
 * Busca vídeo no YouTube (Innertube → API key → Piped → Invidious).
 * @returns {Promise<{ videoId: string, title: string, uploader?: string }|null>}
 */
async function searchYoutubeVideo(query) {
  const list = await searchYoutubeVideos(query, { limit: 1 });
  return list[0] || null;
}

/**
 * @returns {Promise<Array<{ videoId: string, title: string, uploader?: string }>>}
 */
async function searchYoutubeVideos(query, opts = {}) {
  const q = String(query || '').trim().slice(0, 120);
  const limit = Math.max(1, Math.min(15, Number(opts.limit) || 8));
  const exclude = new Set(
    (opts.excludeIds || []).map((x) => String(x || '')).filter(Boolean)
  );
  if (!q) return [];

  const pushFiltered = (hits) => {
    const out = [];
    for (const hit of hits || []) {
      if (!hit?.videoId || exclude.has(String(hit.videoId))) continue;
      out.push(hit);
      if (out.length >= limit) break;
    }
    return out;
  };

  try {
    const hits = await searchYoutubeInnertubeMany(q, Math.max(limit + 4, 10));
    const filtered = pushFiltered(hits);
    if (filtered.length) return filtered;
  } catch {
    /* fallback */
  }

  const ytKey = String(process.env.YOUTUBE_API_KEY || '').trim();
  if (ytKey) {
    try {
      const url =
        'https://www.googleapis.com/youtube/v3/search?' +
        new URLSearchParams({
          part: 'snippet',
          type: 'video',
          maxResults: String(Math.min(15, limit + 4)),
          q,
          key: ytKey,
        }).toString();
      const data = await fetchJsonHttps(url, 9000);
      const hits = (data?.items || [])
        .map((item) => ({
          videoId: String(item?.id?.videoId || ''),
          title: String(item?.snippet?.title || 'YouTube').slice(0, 140),
          uploader: String(item?.snippet?.channelTitle || '').slice(0, 80),
        }))
        .filter((h) => h.videoId);
      const filtered = pushFiltered(hits);
      if (filtered.length) return filtered;
    } catch {
      /* fallback */
    }
  }

  const pipedHosts = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.nosebs.ru',
    'https://api.piped.private.coffee',
  ];
  for (const host of pipedHosts) {
    try {
      const data = await fetchJsonHttps(
        `${host}/search?q=${encodeURIComponent(q)}&filter=videos`,
        8000
      );
      const list = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
          ? data
          : [];
      const hits = [];
      for (const hit of list) {
        if (hit?.type && hit.type !== 'stream' && hit.type !== 'video') continue;
        const videoId = videoIdFromPipedItem(hit);
        if (!videoId) continue;
        hits.push({
          videoId,
          title: String(hit.title || 'YouTube').slice(0, 140),
          uploader: String(hit.uploaderName || hit.uploader || '').slice(0, 80),
        });
      }
      const filtered = pushFiltered(hits);
      if (filtered.length) return filtered;
    } catch {
      /* next */
    }
  }

  const inviHosts = [
    'https://invidious.nerdvpn.de',
    'https://inv.nadeko.net',
    'https://yewtu.be',
  ];
  for (const host of inviHosts) {
    try {
      const data = await fetchJsonHttps(
        `${host}/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
        8000
      );
      const list = Array.isArray(data) ? data : [];
      const hits = [];
      for (const hit of list) {
        if (hit?.type && hit.type !== 'video') continue;
        const videoId = String(hit.videoId || hit.videoID || '').trim();
        if (!/^[A-Za-z0-9_-]{6,15}$/.test(videoId)) continue;
        hits.push({
          videoId,
          title: String(hit.title || 'YouTube').slice(0, 140),
          uploader: String(hit.author || hit.uploader || '').slice(0, 80),
        });
      }
      const filtered = pushFiltered(hits);
      if (filtered.length) return filtered;
    } catch {
      /* next */
    }
  }

  return [];
}

async function pickYoutubeRadioTrack(seed, opts = {}) {
  const mode = opts.mode === 'mix' ? 'mix' : 'artist';
  const seedQ = String(seed || '').trim().slice(0, 80);
  if (!seedQ) return null;
  const excludeIds = opts.excludeIds || [];
  const queries =
    mode === 'artist'
      ? [`${seedQ} topic`, `${seedQ} official audio`, `${seedQ} music`]
      : [`${seedQ} mix`, `${seedQ} playlist`, `${seedQ} songs`, seedQ];
  for (const q of queries) {
    const hits = await searchYoutubeVideos(q, { limit: 10, excludeIds });
    if (hits.length) {
      return hits[Math.floor(Math.random() * Math.min(hits.length, 5))];
    }
  }
  return null;
}

function sayAsCdrOrDeck(room, text, extra = {}) {
  if (room.cdr) return pushCdrMessage(room, text, extra);
  return pushDeckNote(room, text, extra);
}

function playSourceLabel(kind) {
  return kind === 'spotify' ? ' (Spotify)' : ' (YouTube)';
}

function rewritePlayAnnounceText(text, kind) {
  let t = String(text || '');
  const via = playSourceLabel(kind);
  if (/\((?:Spotify|YouTube)\)/i.test(t)) {
    t = t.replace(/\s*\((?:Spotify|YouTube)\)/gi, via);
  } else if (/^essa aqui ·/i.test(t.trim())) {
    t = t.replace(/^(essa aqui ·[^\n]+)/i, `$1${via}`);
  }
  if (kind === 'yt') {
    t = t.replace(/\n?\(precisa ter Spotify Premium[^\n]*\)\s*/gi, '\n').trimEnd();
  } else if (kind === 'spotify' && !/\(precisa ter Spotify Premium/i.test(t)) {
    t = `${t.trimEnd()}\n(precisa ter Spotify Premium + conectar no canal)`;
  }
  return t.trim();
}

/** Quando o client toca YT de verdade (sem login / erro / free), corrige o anúncio do CD-R. */
function syncPlayAnnounceFromListening(room, peer, listening) {
  if (!room || !peer || !listening?.title) return false;
  const kind =
    listening.kind === 'spotify'
      ? 'spotify'
      : listening.kind === 'yt' || listening.videoId
        ? 'yt'
        : null;
  if (!kind) return false;
  const title = String(listening.title || '').toLowerCase();
  for (let i = room.messages.length - 1; i >= 0 && i >= room.messages.length - 16; i -= 1) {
    const m = room.messages[i];
    if (!m || m.sys || !(m.bot || m.peerId === CDR_PEER_ID || m.peerId === 'deck')) continue;
    const tagged = !!m.playAnnounce && (!m.playForPeer || m.playForPeer === peer.id);
    const looksLike =
      /essa aqui ·/i.test(String(m.text || '')) &&
      (!title || String(m.text || '').toLowerCase().includes(title.slice(0, 24)));
    if (!tagged && !looksLike) continue;
    if (m.playSource === kind) {
      const nextText = rewritePlayAnnounceText(m.text, kind);
      if (nextText === m.text) return false;
      m.text = nextText;
      m.touch = Date.now();
      room.updated = m.touch;
      scheduleSaveRooms();
      return true;
    }
    const nextText = rewritePlayAnnounceText(m.text, kind);
    if (nextText === m.text && m.playSource === kind) return false;
    m.text = nextText;
    m.playAnnounce = true;
    m.playForPeer = peer.id;
    m.playSource = kind;
    m.playTitle = listening.title;
    m.touch = Date.now();
    room.updated = m.touch;
    scheduleSaveRooms();
    return true;
  }
  return false;
}

function wantsYoutubeOnly(query) {
  const q = String(query || '');
  if (extractYoutubeId(q)) return true;
  return /\b(youtube|youtu\.be|\byt\b|no\s+yt|do\s+youtube|via\s+youtube|pelo\s+youtube|busca\s+no\s+youtube)\b/i.test(
    q
  );
}

async function runCdrToca(room, peer, query, opts = {}) {
  const extraMsgs = [];
  const q = String(query || '').trim();
  const skipIntro = !!opts.skipIntro;
  if (!q) {
    extraMsgs.push(
      sayAsCdrOrDeck(
        room,
        'manda o nome da música (ou artista + faixa) que eu busco'
      )
    );
    return { play: null, extraMsgs };
  }

  const wasBusy = !!room.cdrBusy;
  if (room.cdr) room.cdrBusy = true;
  try {
    if (!skipIntro) {
      await sleep(350 + Math.floor(Math.random() * 450));
      extraMsgs.push(
        sayAsCdrOrDeck(
          room,
          `ok ${peer.name.split(/\s/)[0]}, deixa eu achar uma…`
        )
      );
    } else {
      await sleep(200 + Math.floor(Math.random() * 280));
    }

    const forceYt = !!opts.forceYt || wantsYoutubeOnly(q);
    const spotRef = extractSpotifyRef(q);
    const searchQ = spotRef
      ? q
      : q
          .replace(/\b(no|do|via|pelo|pro|pra)\s+(youtube|yt)\b/gi, '')
          .replace(/\b(youtube|youtu\.be|\byt\b)\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim() || q;

    let spot = null;
    if (!forceYt && spotifyConfigured()) {
      spot = await searchSpotifyTrack(spotRef ? q : searchQ);
    }

    const ytSearchQ = spot?.title || (spotRef ? '' : searchQ);
    let ytHit = null;
    if (!spot?.uri) {
      ytHit = ytSearchQ ? await searchYoutubeVideo(ytSearchQ) : null;
      if (!ytHit?.videoId) {
        await sleep(400);
        extraMsgs.push(
          sayAsCdrOrDeck(
            room,
            spotRef
              ? 'não rolou abrir esse link do Spotify kkk confere se é faixa/álbum/playlist público'
              : 'não vou conseguir achar com isso kkk tenta outro nome ou artista + música'
          )
        );
        return { play: null, extraMsgs };
      }
    } else {
      /* fallback YT se o peer não tiver Spotify conectado */
      try {
        ytHit = ytSearchQ ? await searchYoutubeVideo(ytSearchQ) : null;
      } catch {
        ytHit = null;
      }
    }

    let title = spot?.title || ytHit?.title || searchQ;
    if (!spot && ytHit?.videoId) {
      try {
        const oembed = await youtubeTitle(ytHit.videoId);
        if (oembed && !/^YouTube /i.test(oembed)) title = oembed;
      } catch {
        /* keep */
      }
    }

    const play = spot?.uri
      ? {
          kind: 'spotify',
          uri: spot.uri,
          id: spot.id,
          title,
          seek: 0,
          ytFallback: ytHit?.videoId
            ? { kind: 'yt', videoId: ytHit.videoId, title: ytHit.title || title, seek: 0 }
            : null,
        }
      : { kind: 'yt', videoId: ytHit.videoId, title, seek: 0 };

    peer.listening = leanListening({
      title,
      kind: play.kind,
      videoId: play.kind === 'yt' ? play.videoId : undefined,
      id: play.kind === 'spotify' ? play.id : undefined,
      uri: play.kind === 'spotify' ? play.uri : undefined,
      pos: 0,
      posAt: Date.now(),
    });
    peer.alongWith = null;

    await sleep(500 + Math.floor(Math.random() * 500));
    const via = playSourceLabel(play.kind);
    extraMsgs.push(
      sayAsCdrOrDeck(
        room,
        `essa aqui · ${title}${via}\n` +
          `toquei só pra você. se o outro quiser ouvir,\n` +
          `[[JOIN:${peer.id}]]` +
          (play.kind === 'spotify'
            ? '\n(precisa ter Spotify Premium + conectar no canal)'
            : ''),
        {
          playAnnounce: true,
          playForPeer: peer.id,
          playTitle: title,
          playSource: play.kind === 'spotify' ? 'spotify' : 'yt',
        }
      )
    );
    extraMsgs.push(pushSys(room, `${peer.name} tá ouvindo · ${title}`));

    return {
      play,
      extraMsgs,
    };
  } finally {
    if (room.cdr) room.cdrBusy = wasBusy;
  }
}

function pushSys(room, text) {
  const now = Date.now();
  const msg = {
    id: `sys-${now}-${crypto.randomBytes(2).toString('hex')}`,
    sys: true,
    text: String(text || '').slice(0, 1800),
    at: now,
    touch: now,
  };
  room.messages.push(msg);
  if (room.messages.length > MAX_MSG) room.messages = room.messages.slice(-MAX_MSG);
  room.updated = now;
  return msg;
}

function pushDeckNote(room, text, extra = {}) {
  const now = Date.now();
  const msg = {
    id: `deck-${now}-${crypto.randomBytes(2).toString('hex')}`,
    peerId: 'deck',
    name: 'PLAY',
    seat: 'DECK',
    bot: true,
    text: String(text || '').slice(0, 1800),
    at: now,
    touch: now,
    reactions: {},
    ...extra,
  };
  room.messages.push(msg);
  if (room.messages.length > MAX_MSG) room.messages = room.messages.slice(-MAX_MSG);
  room.updated = now;
  return msg;
}

function sanitizeAvatar(raw) {
  if (raw === null || raw === '') return null;
  const data = String(raw || '').trim();
  if (!data) return null;
  if (data.length > MAX_AVATAR_CHARS) return undefined;
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(data)) {
    return undefined;
  }
  return data.replace(/\s+/g, '');
}

function applyPeerAvatar(peer, raw, roomCode) {
  if (!peer || raw === undefined) return false;
  const next = sanitizeAvatar(raw);
  if (next === undefined) return false;
  if (next === null) {
    if (!peer.avatarFile && !peer.avatar && !peer.avatarAt) return false;
    if (peer.avatarFile) {
      try {
        fs.unlinkSync(path.join(AVATAR_DIR, peer.avatarFile));
      } catch {
        /* ignore */
      }
    }
    peer.avatar = null;
    peer.avatarFile = null;
    peer.avatarAt = 0;
    return true;
  }
  ensureAvatarDir();
  const file = avatarFileName(roomCode || 'X', peer.id);
  const abs = path.join(AVATAR_DIR, file);
  try {
    const b64 = next.replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '');
    fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
  } catch {
    /* fallback: mantém em memória se disco falhar */
    if (peer.avatar === next) return false;
    peer.avatar = next;
    peer.avatarFile = null;
    peer.avatarAt = Date.now();
    return true;
  }
  peer.avatar = null;
  peer.avatarFile = file;
  peer.avatarAt = Date.now();
  return true;
}

function leanListening(listening) {
  if (!listening || !listening.title) return null;
  const kindHint = String(listening.kind || '')
    .trim()
    .toLowerCase();
  /* kind explícito do client manda — senão YT com uri antigo virava "Spotify" */
  if (kindHint === 'yt' || kindHint === 'youtube') {
    const out = {
      title: String(listening.title).slice(0, 140),
      kind: 'yt',
      id: listening.id ? String(listening.id).slice(0, 32) : undefined,
      videoId: listening.videoId ? String(listening.videoId).slice(0, 16) : undefined,
    };
    if (typeof listening.pos === 'number' && Number.isFinite(listening.pos)) {
      out.pos = Math.max(0, Math.min(Number(listening.pos), 86400));
    }
    if (typeof listening.posAt === 'number' && Number.isFinite(listening.posAt)) {
      out.posAt = Math.round(listening.posAt);
    }
    return out;
  }
  if (
    kindHint === 'spotify' ||
    (!kindHint && String(listening.uri || '').startsWith('spotify:'))
  ) {
    const out = {
      title: String(listening.title).slice(0, 140),
      kind: 'spotify',
      id: listening.id ? String(listening.id).slice(0, 32) : undefined,
      uri: listening.uri
        ? String(listening.uri).slice(0, 64)
        : listening.id
          ? `spotify:track:${String(listening.id).slice(0, 32)}`
          : undefined,
    };
    if (typeof listening.pos === 'number' && Number.isFinite(listening.pos)) {
      out.pos = Math.max(0, Math.min(Number(listening.pos), 86400));
    }
    if (typeof listening.posAt === 'number' && Number.isFinite(listening.posAt)) {
      out.posAt = Math.round(listening.posAt);
    }
    return out;
  }
  const hasYt = !!(listening.videoId || kindHint === 'yt');
  const out = {
    title: String(listening.title).slice(0, 140),
    kind: hasYt ? 'yt' : 'album',
    id: listening.id ? String(listening.id).slice(0, 32) : undefined,
    videoId: listening.videoId ? String(listening.videoId).slice(0, 16) : undefined,
  };
  if (typeof listening.pos === 'number' && Number.isFinite(listening.pos)) {
    out.pos = Math.max(0, Math.min(Number(listening.pos), 86400));
  }
  if (typeof listening.posAt === 'number' && Number.isFinite(listening.posAt)) {
    out.posAt = Math.round(listening.posAt);
  }
  return out;
}

/** Posição estimada agora (pos + tempo desde posAt). */
function estimatedSeek(L, now = Date.now()) {
  if (!L) return 0;
  const pos = typeof L.pos === 'number' && Number.isFinite(L.pos) ? L.pos : 0;
  const at = typeof L.posAt === 'number' && Number.isFinite(L.posAt) ? L.posAt : 0;
  if (!at) return Math.max(0, pos);
  const elapsed = Math.max(0, (now - at) / 1000);
  return Math.max(0, pos + elapsed);
}

/**
 * Monta o payload de play a partir do listening de um peer.
 * @returns {Promise<object|null>}
 */
async function playPayloadFromListening(L) {
  if (!L?.title) return null;
  const seek = estimatedSeek(L);
  if (L.kind === 'spotify' && (L.uri || L.id)) {
    let ytFallback = null;
    try {
      const ytHit = await searchYoutubeVideo(L.title);
      if (ytHit?.videoId) {
        ytFallback = {
          kind: 'yt',
          videoId: ytHit.videoId,
          title: ytHit.title || L.title,
          seek,
        };
      }
    } catch {
      /* ignore */
    }
    return {
      kind: 'spotify',
      uri: L.uri || `spotify:track:${L.id}`,
      id: L.id,
      title: L.title,
      seek,
      ytFallback,
    };
  }
  if (L.kind === 'yt' && L.videoId) {
    return { kind: 'yt', videoId: L.videoId, title: L.title, seek };
  }
  if (L.kind === 'album' && L.id) {
    let duration = 0;
    let artist = 'Panchiko';
    let albumName = 'D>E>A>T>H>M>E>T>A>L';
    try {
      const album = await loadAlbum();
      artist = album.artist || artist;
      albumName = album.album || albumName;
      const track = (album.tracks || []).find((t) => t.id === String(L.id));
      if (track) duration = Number(track.duration) || 0;
    } catch {
      /* ignore */
    }
    return {
      kind: 'album',
      id: L.id,
      title: L.title,
      artist,
      album: albumName,
      duration,
      stream: `/api/deck/album/stream/${encodeURIComponent(L.id)}`,
      seek,
    };
  }
  /* album sem id: tenta achar pelo título */
  if (L.kind === 'album' && L.title) {
    try {
      const album = await loadAlbum();
      const track = findAlbumTrack(album.tracks || [], L.title);
      if (track) {
        return {
          kind: 'album',
          id: track.id,
          title: track.title,
          artist: album.artist || 'Panchiko',
          album: album.album || 'D>E>A>T>H>M>E>T>A>L',
          duration: Number(track.duration) || 0,
          stream: `/api/deck/album/stream/${encodeURIComponent(track.id)}`,
          seek,
        };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function sameTrack(a, b) {
  if (!a?.title || !b?.title) return false;
  if (a.kind === 'spotify' && b.kind === 'spotify') {
    if (a.uri && b.uri) return a.uri === b.uri;
    if (a.id && b.id) return a.id === b.id;
    return String(a.title).toLowerCase() === String(b.title).toLowerCase();
  }
  if (a.kind === 'yt' && b.kind === 'yt') {
    return !!(a.videoId && b.videoId && a.videoId === b.videoId);
  }
  if (a.kind === 'album' && b.kind === 'album') {
    if (a.id && b.id) return a.id === b.id;
    return String(a.title).toLowerCase() === String(b.title).toLowerCase();
  }
  return false;
}

/**
 * @returns {Promise<{ play: object|null, extraMsgs: object[] }>}
 */
async function runMusicCommand(room, peer, text) {
  const raw = String(text || '').trim();
  const extraMsgs = [];

  if (/^\/comando(s)?\b/i.test(raw) || /^\/help\b/i.test(raw)) {
    const withCdr = !!room.cdr;
    const commands = [
      { cmd: '/comando', label: 'lista todos os comandos' },
      { cmd: '/music', label: 'lista as faixas do álbum' },
      { cmd: '/music nome', label: 'toca uma faixa (ex: /music laputa)' },
      { cmd: '/yt link', label: 'toca um vídeo do YouTube' },
      { cmd: '/mix artista', label: 'rádio/mix contínuo (próxima sozinha)' },
      { cmd: '/radio banda', label: 'só músicas dessa banda em loop' },
      { cmd: '/stop', label: 'pausa a música (host para todo mundo)' },
      { cmd: '/resume', label: 'retoma a última música' },
      { cmd: '/play', label: 'alias do /resume' },
      { cmd: '/junto', label: 'se junta no play da outra pessoa' },
      { cmd: '/join', label: 'alias do /junto' },
      { cmd: '/ouvir', label: 'alias do /junto' },
    ];
    if (withCdr) {
      commands.push({
        cmd: '/oi',
        label: 'fala com o CD-R (qualquer /texto)',
      });
    }
    const lines = commands.map((c) => `${c.cmd} — ${c.label}`).join('\n');
    const cdrHint = withCdr
      ? '\n\nmúsica com o CD-R: manda / e pede no papo — tipo "coloca creep" ou "bota duster". ele busca o que você pedir.'
      : '';
    extraMsgs.push(
      pushDeckNote(room, `COMANDOS\n${lines}${cdrHint}`, {
        commands: {
          title: 'COMANDOS',
          items: commands,
        },
      })
    );
    return { play: null, extraMsgs };
  }

  if (/^\/stop\b/i.test(raw) || /^\/music\s+stop\b/i.test(raw)) {
    const saved = leanListening(peer.listening);
    if (saved) peer.lastListening = saved;
    peer.listening = null;
    peer.alongWith = null;
    clearPeerRadio(peer);
    let followers = 0;
    if (saved) {
      for (const p of heldPeers(room)) {
        if (p.id === peer.id) continue;
        if (!sameTrack(p.listening, saved)) continue;
        p.lastListening = leanListening(p.listening) || saved;
        p.listening = null;
        p.alongWith = null;
        followers += 1;
      }
    }
    room.playSync = {
      kind: 'stop',
      by: peer.id,
      track: saved,
      at: Date.now(),
    };
    extraMsgs.push(
      pushSys(
        room,
        followers
          ? `${peer.name} pausou pra todo mundo`
          : `${peer.name} pausou a música`
      )
    );
    return { play: { kind: 'stop', sync: true }, extraMsgs };
  }

  if (/^\/resume\b/i.test(raw) || /^\/play\b/i.test(raw)) {
    const L = leanListening(peer.lastListening) || leanListening(peer.listening);
    if (!L?.title) {
      extraMsgs.push(pushDeckNote(room, 'nada pra retomar · /music nome ou /yt link'));
      return { play: null, extraMsgs };
    }
    const play = await playPayloadFromListening(L);
    if (!play) {
      extraMsgs.push(pushDeckNote(room, 'não rolou retomar'));
      return { play: null, extraMsgs };
    }
    const now = Date.now();
    const seek = typeof play.seek === 'number' ? play.seek : 0;
    peer.listening = leanListening({ ...L, pos: seek, posAt: now });
    peer.lastListening = leanListening(L);
    let followers = 0;
    for (const p of heldPeers(room)) {
      if (p.id === peer.id) continue;
      if (!(sameTrack(p.lastListening, L) || sameTrack(p.listening, L))) continue;
      p.listening = leanListening({ ...L, pos: seek, posAt: now });
      p.lastListening = leanListening(L);
      followers += 1;
    }
    room.playSync = {
      kind: 'resume',
      by: peer.id,
      play: { ...play, resume: true, seek },
      track: L,
      at: now,
    };
    extraMsgs.push(
      pushSys(
        room,
        followers
          ? `${peer.name} retomou pra todo mundo · ${L.title}`
          : `${peer.name} retomou · ${L.title}`
      )
    );
    return { play: { ...play, resume: true }, extraMsgs };
  }

  if (/^\/junto\b/i.test(raw) || /^\/join\b/i.test(raw) || /^\/ouvir\b/i.test(raw)) {
    const others = heldPeers(room).filter((p) => p.id !== peer.id && p.listening?.title);
    if (!others.length) {
      extraMsgs.push(pushDeckNote(room, 'ninguém tá tocando agora · manda /music ou /yt'));
      return { play: null, extraMsgs };
    }
    const from = others[0];
    const play = await playPayloadFromListening(from.listening);
    if (!play) {
      extraMsgs.push(pushDeckNote(room, 'não rolou entrar no play'));
      return { play: null, extraMsgs };
    }
    const seek = estimatedSeek(from.listening);
    play.seek = seek;
    peer.listening = leanListening({
      ...from.listening,
      pos: seek,
      posAt: Date.now(),
    });
    peer.alongWith = from.id;
    extraMsgs.push(pushSys(room, `${peer.name} se juntou ao play de ${from.name} · ${from.listening.title}`));
    return { play, extraMsgs };
  }

  if (/^\/music\b/i.test(raw)) {
    const arg = raw.replace(/^\/music\b/i, '').trim();
    let album;
    try {
      album = await loadAlbum();
    } catch (err) {
      extraMsgs.push(pushDeckNote(room, `playlist offline · ${err.message || 'falha'}`));
      return { play: null, extraMsgs };
    }
    const tracks = album.tracks || [];
    if (!arg) {
      const tracksPayload = tracks.map((t) => {
        const title = String(t.title || '').trim();
        const cmd = `/music ${title}`;
        return {
          num: t.num,
          title,
          cmd,
        };
      });
      const lines = tracksPayload
        .map((t) => `${String(t.num).padStart(2, '0')} · ${t.title}`)
        .join('\n');
      extraMsgs.push(
        pushDeckNote(room, `PLAY · ${album.album}\n${lines}\n\n/comando · /yt link · /stop · /resume`, {
          playlist: {
            album: album.album || 'album',
            tracks: tracksPayload,
          },
        })
      );
      return { play: null, extraMsgs };
    }
    const track = findAlbumTrack(tracks, arg);
    if (!track) {
      extraMsgs.push(pushDeckNote(room, `não achei "${arg}" · manda /music pra ver a lista`));
      return { play: null, extraMsgs };
    }
    peer.listening = leanListening({
      title: track.title,
      kind: 'album',
      id: track.id,
      pos: 0,
      posAt: Date.now(),
    });
    peer.alongWith = null;
    extraMsgs.push(pushSys(room, `${peer.name} tá ouvindo · ${track.title}`));
    return {
      play: {
        kind: 'album',
        id: track.id,
        title: track.title,
        artist: album.artist || 'Panchiko',
        album: album.album || 'D>E>A>T>H>M>E>T>A>L',
        duration: Number(track.duration) || 0,
        stream: `/api/deck/album/stream/${encodeURIComponent(track.id)}`,
        seek: 0,
      },
      extraMsgs,
    };
  }

  if (/^\/mix\b/i.test(raw) || /^\/radio\b/i.test(raw) || /^\/r[aá]dio\b/i.test(raw)) {
    const arg = raw
      .replace(/^\/(?:mix|radio|rádio)\b/i, '')
      .trim();
    if (!arg) {
      extraMsgs.push(
        pushDeckNote(
          room,
          'usa assim · /mix cocteau twins · /radio panchiko\n(quando acabar, passa pra próxima sozinho · /stop pra parar)'
        )
      );
      return { play: null, extraMsgs };
    }
    const mode = /^\/mix\b/i.test(raw) ? 'mix' : 'artist';
    const music = await runCdrRadio(room, peer, arg, {
      mode,
      skipIntro: true,
      skipSys: false,
    });
    return { play: music.play || null, extraMsgs: music.extraMsgs || extraMsgs };
  }

  let videoId = null;
  if (/^\/yt\b/i.test(raw)) {
    videoId = extractYoutubeId(raw.replace(/^\/yt\b/i, '').trim());
  } else {
    videoId = extractYoutubeId(raw.replace(/^\//, '').trim());
  }
  if (!videoId) {
    extraMsgs.push(pushDeckNote(room, 'link do YouTube inválido'));
    return { play: null, extraMsgs };
  }
  const title = await youtubeTitle(videoId);
  peer.listening = leanListening({ title, kind: 'yt', videoId, pos: 0, posAt: Date.now() });
  peer.alongWith = null;
  extraMsgs.push(pushSys(room, `${peer.name} tá ouvindo · ${title}`));
  return {
    play: { kind: 'yt', videoId, title, seek: 0 },
    extraMsgs,
  };
}

function publicRoom(room) {
  const now = Date.now();
  const peers = heldPeers(room, now).map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    online: now - p.seen <= PEER_ONLINE_MS,
    typing: !!(p.typingUntil && p.typingUntil > now),
    recording: !!(p.recordingUntil && p.recordingUntil > now),
    listening: leanListening(p.listening),
    alongWith: p.alongWith || null,
    avatarAt: p.avatarAt && (p.avatarFile || p.avatar) ? Number(p.avatarAt) || 0 : 0,
    avatarUrl: peerAvatarUrl(p) || null,
  }));
  if (room.cdr) {
    peers.push({
      id: CDR_PEER_ID,
      name: CDR_NAME,
      seat: 'CDR',
      bot: true,
      online: true,
      typing: !!room.cdrBusy,
    });
  }
  return {
    code: room.code,
    cdr: !!room.cdr,
    cdrTyping: !!(room.cdr && room.cdrBusy),
    peers,
    slots: { used: heldPeers(room, now).length, max: roomMaxPeers(room) },
    maxPeers: roomMaxPeers(room),
    messages: room.messages.slice(-80),
    wallpaper: room.wallpaper
      ? {
          at: room.wallpaper.at || 0,
          by: room.wallpaper.by || '',
          name: room.wallpaper.name || '',
          wallX: room.wallpaper.wallX ?? 50,
          wallY: room.wallpaper.wallY ?? 50,
          wallZoom: room.wallpaper.wallZoom ?? 1,
        }
      : null,
    visual: room.visual
      ? {
          at: room.visual.at || 0,
          by: room.visual.by || '',
          name: room.visual.name || '',
          theme: room.visual.theme || 'paper',
          bubbleMe: room.visual.bubbleMe || 'classic',
          bubbleThem: room.visual.bubbleThem || 'classic',
          wallX: room.visual.wallX ?? 50,
          wallY: room.visual.wallY ?? 50,
          wallZoom: room.visual.wallZoom ?? 1,
          hasWall: !!room.visual.wallpaper,
        }
      : null,
    playSync:
      room.playSync && now - room.playSync.at < 20000
        ? {
            kind: room.playSync.kind,
            by: room.playSync.by,
            at: room.playSync.at,
            play: room.playSync.play || null,
            track: leanListening(room.playSync.track),
          }
        : null,
    call: leanCall(room, now),
  };
}

function leanCall(room, now = Date.now()) {
  const c = room.call;
  if (!c) return null;
  if (c.status === 'ended') return null;
  if (c.status === 'ringing' && now - c.at > 45000) {
    room.call = null;
    return null;
  }
  if (c.status === 'active' && now - (c.activeAt || c.at) > 1000 * 60 * 90) {
    room.call = null;
    return null;
  }
  const muteMap = c.mute && typeof c.mute === 'object' ? c.mute : {};
  const people = (c.joined || []).map((id) => {
    const p = room.peers.get(id);
    const url = peerAvatarUrl(p);
    return {
      id,
      name: p?.name || (id === c.from ? c.fromName : 'ghost'),
      muted: !!muteMap[id],
      host: id === c.from,
      avatarAt: p?.avatarAt && (p?.avatarFile || p?.avatar) ? Number(p.avatarAt) || 0 : 0,
      avatarUrl: url || null,
      /* fallback se o arquivo não existiu (memória) */
      avatar: !url && p?.avatar ? p.avatar : null,
    };
  });
  return {
    id: c.id,
    from: c.from,
    fromName: c.fromName,
    status: c.status,
    at: c.at,
    activeAt: c.activeAt || null,
    joined: [...(c.joined || [])],
    people,
  };
}

function callPeopleLabel(room) {
  const c = room.call;
  if (!c?.joined?.length) return '';
  const names = c.joined.map((id) => {
    const p = room.peers.get(id);
    return p?.name || (id === c.from ? c.fromName : 'ghost');
  });
  if (names.length === 1) return `${names[0]} está na ligação`;
  if (names.length === 2) return `${names[0]} e ${names[1]} estão na ligação`;
  const last = names[names.length - 1];
  const head = names.slice(0, -1).join(', ');
  return `${head} e ${last} estão na ligação`;
}

function takeCallSignals(room, peerId) {
  if (!room.call?.signals?.length) return [];
  const keep = [];
  const out = [];
  for (const s of room.call.signals) {
    if (s.to === peerId) out.push(s);
    else keep.push(s);
  }
  room.call.signals = keep.slice(-120);
  /* processa offer/answer antes do ICE no client */
  out.sort((a, b) => {
    const rank = (t) => (t === 'offer' || t === 'answer' ? 0 : 1);
    return rank(a.type) - rank(b.type) || a.at - b.at;
  });
  return out.map((s) => ({
    id: s.id,
    from: s.from,
    to: s.to,
    type: s.type,
    payload: s.payload,
    at: s.at,
  }));
}

function endRoomCall(room, byName) {
  if (!room.call) return;
  room.call = null;
  if (byName) pushSys(room, `${byName} encerrou a ligação`);
  room.updated = Date.now();
}

function getRoom(code) {
  cleanRooms();
  return rooms.get(String(code || '').toUpperCase());
}

function msgStamp(m) {
  return Math.max(Number(m.at) || 0, Number(m.touch) || 0);
}

function findPeer(room, peerId) {
  return room.peers.get(String(peerId || ''));
}

function mountCommsRoutes(app) {
  setInterval(() => {
    cleanRooms();
    scheduleSaveRooms();
  }, 30000);

  app.post('/api/deck/comms/create', (req, res) => {
    cleanRooms();
    const name = String(req.body?.name || 'OP-1').trim().slice(0, 24) || 'OP-1';
    const peerId = String(req.body?.peerId || crypto.randomBytes(8).toString('hex'));
    const cdr = req.body?.cdr !== false && req.body?.cdr !== 0 && req.body?.cdr !== '0';
    const maxPeers = roomMaxPeers({ maxPeers: req.body?.maxPeers });
    const code = makeCode();
    const now = Date.now();
    const room = {
      code,
      created: now,
      updated: now,
      cdr: !!cdr,
      maxPeers,
      peers: new Map(),
      messages: [],
      customStickers: new Map(),
    };
    room.peers.set(peerId, { id: peerId, name, seat: 'A', seen: now, typingUntil: 0, recordingUntil: 0 });
    applyPeerAvatar(room.peers.get(peerId), req.body?.avatar, code);
    room.messages.push({
      id: `sys-${now}`,
      sys: true,
      text: cdr
        ? `${name} abriu o canal ${code} · até ${maxPeers} · CD-R no ar (fala com /mensagem)`
        : `${name} abriu o canal ${code} · até ${maxPeers} pessoas`,
      at: now,
      touch: now,
    });
    rooms.set(code, room);
    scheduleSaveRooms();
    res.json({ ok: true, peerId, name, seat: 'A', ...publicRoom(room) });
  });

  app.post('/api/deck/comms/join', (req, res) => {
    const code = String(req.body?.code || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    const name = String(req.body?.name || 'OP-2').trim().slice(0, 24) || 'OP-2';
    const peerId = String(req.body?.peerId || crypto.randomBytes(8).toString('hex'));
    const room = getRoom(code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal não encontrado.' });
      return;
    }

    const now = Date.now();
    const cap = roomMaxPeers(room);
    let peer = room.peers.get(peerId);
    if (!peer) {
      const held = heldPeers(room, now);
      if (held.length >= cap) {
        res.status(409).json({ ok: false, error: `Canal cheio (máx. ${cap} pessoas).` });
        return;
      }
      const seat = nextSeat(held);
      peer = { id: peerId, name, seat, seen: now, typingUntil: 0, recordingUntil: 0 };
      room.peers.set(peerId, peer);
      applyPeerAvatar(peer, req.body?.avatar, code);
      room.messages.push({
        id: `sys-${now}`,
        sys: true,
        text: `${name} entrou no canal`,
        at: now,
        touch: now,
      });
      if (room.messages.length > MAX_MSG) room.messages = room.messages.slice(-MAX_MSG);
    } else {
      peer.name = name;
      peer.seen = now;
      applyPeerAvatar(peer, req.body?.avatar, code);
    }
    room.updated = now;
    scheduleSaveRooms();
    res.json({ ok: true, peerId, name: peer.name, seat: peer.seat, ...publicRoom(room) });
  });

  app.post('/api/deck/comms/:code/presence', async (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peerId = String(req.body?.peerId || '');
    let peer = findPeer(room, peerId);
    // heartbeat atrasado (aba no background): remonta o peer se ainda houver vaga
    if (!peer && peerId) {
      const held = heldPeers(room);
      const cap = roomMaxPeers(room);
      if (held.length < cap) {
        const name = String(req.body?.name || 'ghost').trim().slice(0, 24) || 'ghost';
        const seat = nextSeat(held);
        peer = { id: peerId, name, seat, seen: Date.now(), typingUntil: 0, recordingUntil: 0 };
        room.peers.set(peerId, peer);
        applyPeerAvatar(peer, req.body?.avatar, room.code);
        const now = Date.now();
        room.messages.push({
          id: `sys-${now}-back`,
          sys: true,
          text: `${name} voltou ao canal`,
          at: now,
          touch: now,
        });
        scheduleSaveRooms();
      }
    }
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    peer.seen = Date.now();
    if (req.body?.name) peer.name = String(req.body.name).trim().slice(0, 24) || peer.name;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'avatar')) {
      applyPeerAvatar(peer, req.body.avatar, room.code);
    }
    if (typeof req.body?.typing === 'boolean') {
      peer.typingUntil = req.body.typing ? Date.now() + 3500 : 0;
      if (req.body.typing) peer.recordingUntil = 0;
    }
    if (typeof req.body?.recording === 'boolean') {
      peer.recordingUntil = req.body.recording ? Date.now() + 4500 : 0;
      if (req.body.recording) peer.typingUntil = 0;
    }
    if (
      typeof req.body?.callMuted === 'boolean' &&
      room.call &&
      Array.isArray(room.call.joined) &&
      room.call.joined.includes(peer.id)
    ) {
      if (!room.call.mute || typeof room.call.mute !== 'object') room.call.mute = {};
      room.call.mute[peer.id] = !!req.body.callMuted;
    }
    if (req.body?.listening === null) {
      peer.listening = null;
      peer.alongWith = null;
    } else if (req.body?.listening && typeof req.body.listening === 'object') {
      const next = leanListening(req.body.listening);
      if (req.body.alongWith) {
        peer.alongWith = String(req.body.alongWith).slice(0, 64);
      } else if (!sameTrack(peer.listening, next)) {
        peer.alongWith = null;
      }
      peer.listening = next;
      if (next) syncPlayAnnounceFromListening(room, peer, next);
    }
    if (req.body?.trackEnded && peer.radio?.seed) {
      try {
        await advancePeerRadio(room, peer);
      } catch {
        /* ignore */
      }
    }
    if (req.body?.radio === null) {
      clearPeerRadio(peer);
    }
    room.updated = peer.seen;
    const after = Number(req.body?.after || 0);
    const messages = room.messages.filter((m) => msgStamp(m) > after);
    const pendingPlay = takePendingPlay(peer);
    const callSignals = takeCallSignals(room, peer.id);
    res.json({
      ok: true,
      ...publicRoom(room),
      messages,
      serverTime: peer.seen,
      pendingPlay: pendingPlay || null,
      callSignals,
    });
  });

  /** Entra no play de outro peer (ouvir juntos) */
  app.post('/api/deck/comms/:code/listen-along', async (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Você não está neste canal.', rejoin: true });
      return;
    }
    const fromId = String(req.body?.fromPeerId || '');
    const from = findPeer(room, fromId);
    if (!from || from.id === peer.id) {
      res.status(400).json({ ok: false, error: 'escolhe alguém que tá tocando' });
      return;
    }
    if (!from.listening?.title) {
      res.status(400).json({ ok: false, error: 'essa pessoa não tá tocando agora' });
      return;
    }
    const play = await playPayloadFromListening(from.listening);
    if (!play) {
      res.status(400).json({ ok: false, error: 'não rolou montar o play' });
      return;
    }
    /* sincroniza no tempo atual do host */
    const seek = estimatedSeek(from.listening);
    play.seek = seek;
    const already =
      peer.listening &&
      peer.listening.title === from.listening.title &&
      ((peer.listening.videoId && peer.listening.videoId === from.listening.videoId) ||
        (peer.listening.id && peer.listening.id === from.listening.id));
    peer.listening = leanListening({
      ...from.listening,
      pos: seek,
      posAt: Date.now(),
    });
    peer.alongWith = from.id;
    peer.seen = Date.now();
    room.updated = peer.seen;
    if (!already) {
      pushSys(room, `${peer.name} se juntou ao play de ${from.name} · ${from.listening.title}`);
    }
    scheduleSaveRooms();
    res.json({ ok: true, play, alongWith: from.id, ...publicRoom(room) });
  });

  app.post('/api/deck/comms/:code/message', async (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'VocÃª nÃ£o estÃ¡ neste canal.', rejoin: true });
      return;
    }
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    const images = sanitizeImages(req.body);
    const voice = sanitizeVoice(req.body?.voice);
    const voiceMs = voice ? sanitizeVoiceMs(req.body?.voiceMs) : 0;
    const voiceWave = voice ? sanitizeVoiceWave(req.body?.voiceWave) : null;
    const stickerRaw = String(req.body?.sticker || '').trim().toLowerCase();
    const sticker = allowedStickers().has(stickerRaw) ? stickerRaw : null;
    const stickerCustom = resolveStickerCustom(room, req.body, peer);

    if (images === null) {
      res.status(400).json({ ok: false, error: 'Imagens grandes demais (gif até 15MB; máx. 6 por mensagem).' });
      return;
    }
    if (req.body?.stickerCustom && !stickerCustom) {
      res.status(400).json({
        ok: false,
        error: 'Figurinha invÃ¡lida (imagem/gif/vÃ­deo â‰¤5s, arquivo mais leve).',
      });
      return;
    }
    if (req.body?.voice && !voice) {
      res.status(400).json({
        ok: false,
        error: 'Áudio inválido ou grande demais (máx. ~2 min).',
      });
      return;
    }
    if (!text && !images.length && !sticker && !stickerCustom && !voice) {
      res.status(400).json({ ok: false, error: 'Mensagem vazia.' });
      return;
    }
    if ((Array.isArray(req.body?.images) && req.body.images.length && !images.length) || (req.body?.image && !images.length)) {
      res.status(400).json({ ok: false, error: 'Imagem inválida ou grande demais (gif até 15MB).' });
      return;
    }

    let reply = null;
    const replyId = String(req.body?.replyTo || '').trim();
    if (replyId) {
      const src = room.messages.find((m) => m.id === replyId && !m.sys);
      if (src) {
        const mediaCount = Array.isArray(src.images) ? src.images.length : src.image ? 1 : 0;
        reply = {
          id: src.id,
          name: src.name,
          text: String(
            src.text ||
              (src.voice
                ? '🎤 áudio'
                : mediaCount > 1
                  ? `🖼 ${mediaCount} imagens`
                  : mediaCount
                    ? '🖼 imagem'
                    : src.sticker || src.stickerCustom
                      ? 'sticker'
                      : '')
          ).slice(0, 140),
        };
      }
    }

    const now = Date.now();
    peer.seen = now;
    peer.typingUntil = 0;
    room.updated = now;
    const msg = {
      id: `m${now}-${crypto.randomBytes(2).toString('hex')}`,
      peerId: peer.id,
      name: peer.name,
      seat: peer.seat,
      text: text || '',
      at: now,
      touch: now,
      reply,
      reactions: {},
    };
    if (images.length) {
      msg.images = images;
      // compat com clients antigos
      msg.image = images[0];
    }
    if (voice) {
      msg.voice = voice;
      if (voiceMs) msg.voiceMs = voiceMs;
      if (voiceWave) msg.voiceWave = voiceWave;
    }
    if (sticker) msg.sticker = sticker;
    if (stickerCustom) msg.stickerCustom = stickerCustom;
    room.messages.push(msg);
    if (room.messages.length > MAX_MSG) room.messages = room.messages.slice(-MAX_MSG);

    let play = null;
    if (text && isMusicSlash(text)) {
      try {
        const music = await runMusicCommand(room, peer, text);
        play = music.play || null;
        /* play já vai no response — não deixar o poll aplicar de novo */
        if (play && peer.pendingPlay) peer.pendingPlay = null;
      } catch (err) {
        pushSys(room, err?.message || 'falha no play');
      }
      scheduleSaveRooms();
      res.json({ ok: true, message: msg, play, ...publicRoom(room) });
      return;
    }

    scheduleSaveRooms();
    scheduleCdrReply(room, msg);
    if (shouldCdrJoinPapoi(room, msg)) {
      scheduleCdrReply(room, msg, { ambient: 'papoi' });
    }
    res.json({ ok: true, message: msg, ...publicRoom(room) });
  });

  app.post('/api/deck/comms/:code/react', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer invÃ¡lido.', rejoin: true });
      return;
    }
    const msgId = String(req.body?.msgId || '');
    const emoji = String(req.body?.emoji || '');
    if (!ALLOWED_REACTS.has(emoji)) {
      res.status(400).json({ ok: false, error: 'ReaÃ§Ã£o invÃ¡lida.' });
      return;
    }
    const msg = room.messages.find((m) => m.id === msgId && !m.sys);
    if (!msg) {
      res.status(404).json({ ok: false, error: 'Mensagem nÃ£o encontrada.' });
      return;
    }
    if (!msg.reactions || typeof msg.reactions !== 'object') msg.reactions = {};
    const list = Array.isArray(msg.reactions[emoji]) ? msg.reactions[emoji] : [];
    const idx = list.indexOf(peer.id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(peer.id);
    if (list.length) msg.reactions[emoji] = list;
    else delete msg.reactions[emoji];

    const now = Date.now();
    msg.touch = now;
    peer.seen = now;
    room.updated = now;
    scheduleSaveRooms();
    res.json({ ok: true, message: msg, ...publicRoom(room) });
  });

  app.post('/api/deck/comms/:code/face-like', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    const targetId = String(req.body?.targetPeerId || '').slice(0, 64);
    if (!targetId || targetId === peer.id) {
      res.status(400).json({ ok: false, error: 'escolhe a foto de outra pessoa' });
      return;
    }
    const target = findPeer(room, targetId);
    if (!target || target.bot) {
      res.status(404).json({ ok: false, error: 'pessoa não tá no canal' });
      return;
    }
    const isSuper = !!req.body?.super;
    const now = Date.now();
    if (!room.faceLikeAt || typeof room.faceLikeAt !== 'object') room.faceLikeAt = {};
    const key = `${isSuper ? 'S' : 'N'}:${peer.id}>${target.id}`;
    const last = Number(room.faceLikeAt[key]) || 0;
    const cool = isSuper ? 45000 : 12000;
    if (now - last < cool) {
      res.status(429).json({
        ok: false,
        error: isSuper ? 'calma · SUPER maneira já foi' : 'calma · já elogiou essa foto agora',
      });
      return;
    }
    room.faceLikeAt[key] = now;
    peer.seen = now;
    room.updated = now;
    const who = String(peer.name || 'ghost').trim().slice(0, 24) || 'ghost';
    const whom = String(target.name || 'ghost').trim().slice(0, 24) || 'ghost';
    pushSys(
      room,
      isSuper
        ? `${who} achou a foto de ${whom} SUPER MANEIRA :P`
        : `${who} achou a foto de ${whom} maneira :P`
    );
    scheduleSaveRooms();
    res.json({ ok: true, super: isSuper, ...publicRoom(room) });
  });

  app.post('/api/deck/comms/:code/leave', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.json({ ok: true });
      return;
    }
    const peerId = String(req.body?.peerId || '');
    const peer = room.peers.get(peerId);
    if (peer) {
      /* quem tava no sync com quem saiu vira host solo (música não para) */
      for (const p of room.peers.values()) {
        if (p.id !== peer.id && p.alongWith === peer.id) {
          p.alongWith = null;
        }
      }
      if (room.call?.joined?.includes(peerId)) {
        room.call.joined = room.call.joined.filter((id) => id !== peerId);
        if (room.call.from === peerId || room.call.joined.length === 0) {
          endRoomCall(room, peer.name);
        }
      }
      room.peers.delete(peerId);
      const now = Date.now();
      room.updated = now;
      room.messages.push({
        id: `sys-${now}`,
        sys: true,
        text: `${peer.name} saiu do canal`,
        at: now,
        touch: now,
      });
      scheduleSaveRooms();
    }
    res.json({ ok: true });
  });

  /** Ligação de voz do canal (WebRTC · sinalização via poll) */
  app.post('/api/deck/comms/:code/call/start', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    const humans = heldPeers(room).filter((p) => !p.bot && p.seat !== 'CDR');
    if (humans.length < 2) {
      res.status(400).json({ ok: false, error: 'precisa de pelo menos 2 pessoas no canal' });
      return;
    }
    const now = Date.now();
    if (room.call && room.call.status !== 'ended') {
      res.json({ ok: true, call: leanCall(room, now), ...publicRoom(room) });
      return;
    }
    room.call = {
      id: `c${now}-${crypto.randomBytes(2).toString('hex')}`,
      from: peer.id,
      fromName: peer.name,
      status: 'ringing',
      at: now,
      activeAt: null,
      joined: [peer.id],
      mute: { [peer.id]: false },
      signals: [],
    };
    peer.seen = now;
    room.updated = now;
    pushSys(room, `${peer.name} iniciou uma ligação de voz`);
    scheduleSaveRooms();
    res.json({ ok: true, call: leanCall(room, now), ...publicRoom(room) });
  });

  app.post('/api/deck/comms/:code/call/answer', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    if (!room.call || room.call.status === 'ended') {
      res.status(400).json({ ok: false, error: 'nenhuma ligação ativa' });
      return;
    }
    const now = Date.now();
    const wasIn = room.call.joined.includes(peer.id);
    if (!wasIn) room.call.joined.push(peer.id);
    if (!room.call.mute || typeof room.call.mute !== 'object') room.call.mute = {};
    if (!(peer.id in room.call.mute)) room.call.mute[peer.id] = false;
    if (room.call.status === 'ringing') {
      room.call.status = 'active';
      room.call.activeAt = now;
    }
    peer.seen = now;
    room.updated = now;
    if (!wasIn) {
      pushSys(room, `${peer.name} entrou na ligação`);
      const who = callPeopleLabel(room);
      if (who) pushSys(room, who);
    }
    scheduleSaveRooms();
    res.json({ ok: true, call: leanCall(room, now), ...publicRoom(room) });
  });

  app.post('/api/deck/comms/:code/call/kick', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    if (!room.call || room.call.status === 'ended') {
      res.status(400).json({ ok: false, error: 'nenhuma ligação ativa' });
      return;
    }
    if (room.call.from !== peer.id) {
      res.status(403).json({ ok: false, error: 'só quem criou a call pode remover' });
      return;
    }
    const targetId = String(req.body?.targetId || '');
    if (!targetId || targetId === peer.id) {
      res.status(400).json({ ok: false, error: 'pessoa inválida' });
      return;
    }
    if (!room.call.joined.includes(targetId)) {
      res.json({ ok: true, call: leanCall(room), ...publicRoom(room) });
      return;
    }
    const target = findPeer(room, targetId);
    const targetName = target?.name || 'alguém';
    const now = Date.now();
    room.call.joined = room.call.joined.filter((id) => id !== targetId);
    if (room.call.mute && typeof room.call.mute === 'object') delete room.call.mute[targetId];
    room.call.signals = (room.call.signals || []).filter(
      (s) => s.from !== targetId && s.to !== targetId
    );
    peer.seen = now;
    room.updated = now;
    pushSys(room, `${peer.name} removeu ${targetName} da ligação`);
    if (room.call.joined.length < 1) {
      endRoomCall(room, peer.name);
    } else {
      const who = callPeopleLabel(room);
      if (who) pushSys(room, who);
    }
    scheduleSaveRooms();
    res.json({ ok: true, call: leanCall(room, now), ...publicRoom(room) });
  });

  app.post('/api/deck/comms/:code/call/hangup', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.json({ ok: true });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    if (!room.call) {
      res.json({ ok: true, call: null, ...publicRoom(room) });
      return;
    }
    const now = Date.now();
    const wasIn = (room.call.joined || []).includes(peer.id);
    room.call.joined = (room.call.joined || []).filter((id) => id !== peer.id);
    const alone = room.call.joined.length < 1;
    const hostLeft = room.call.from === peer.id;
    /* recusar sem entrar: não mata a call dos outros */
    if (!wasIn && room.call.status === 'ringing' && !hostLeft) {
      peer.seen = now;
      res.json({ ok: true, call: leanCall(room, now), ...publicRoom(room) });
      return;
    }
    if (room.call?.mute && typeof room.call.mute === 'object') {
      delete room.call.mute[peer.id];
    }
    if (alone || hostLeft) {
      endRoomCall(room, peer.name);
    } else {
      pushSys(room, `${peer.name} saiu da ligação`);
      const who = callPeopleLabel(room);
      if (who) pushSys(room, who);
      room.updated = now;
    }
    peer.seen = now;
    scheduleSaveRooms();
    res.json({ ok: true, call: leanCall(room, now), ...publicRoom(room) });
  });

  /** Mute só do próprio peer na call (status pra lista — não é mute global) */
  app.post('/api/deck/comms/:code/call/mute', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    if (!room.call || room.call.status === 'ended') {
      res.status(400).json({ ok: false, error: 'nenhuma ligação ativa' });
      return;
    }
    if (!Array.isArray(room.call.joined) || !room.call.joined.includes(peer.id)) {
      res.status(400).json({ ok: false, error: 'você não está na ligação' });
      return;
    }
    if (!room.call.mute || typeof room.call.mute !== 'object') room.call.mute = {};
    room.call.mute[peer.id] = !!req.body?.muted;
    peer.seen = Date.now();
    room.updated = peer.seen;
    res.json({ ok: true, call: leanCall(room), ...publicRoom(room) });
  });

  app.post('/api/deck/comms/:code/call/signal', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    if (!room.call || room.call.status === 'ended') {
      res.status(400).json({ ok: false, error: 'nenhuma ligação ativa' });
      return;
    }
    const to = String(req.body?.to || '');
    const type = String(req.body?.type || '');
    if (!to || !findPeer(room, to)) {
      res.status(400).json({ ok: false, error: 'destino inválido' });
      return;
    }
    if (!['offer', 'answer', 'ice'].includes(type)) {
      res.status(400).json({ ok: false, error: 'sinal inválido' });
      return;
    }
    const payload = req.body?.payload;
    if (payload == null) {
      res.status(400).json({ ok: false, error: 'payload vazio' });
      return;
    }
    const raw = JSON.stringify(payload);
    if (raw.length > 120000) {
      res.status(400).json({ ok: false, error: 'sinal grande demais' });
      return;
    }
    const now = Date.now();
    if (!Array.isArray(room.call.signals)) room.call.signals = [];
    room.call.signals.push({
      id: `s${now}-${crypto.randomBytes(2).toString('hex')}`,
      from: peer.id,
      to,
      type,
      payload,
      at: now,
    });
    /* nunca dropa offer/answer — poll lento + ICE trickle matava áudio de um lado */
    if (room.call.signals.length > 160) {
      const important = room.call.signals.filter((s) => s.type === 'offer' || s.type === 'answer');
      const ice = room.call.signals.filter((s) => s.type === 'ice').slice(-100);
      room.call.signals = [...important, ...ice].slice(-160);
    }
    peer.seen = now;
    room.updated = now;
    res.json({ ok: true });
  });

  app.get('/api/deck/comms/:code', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal nÃ£o encontrado.' });
      return;
    }
    res.json({ ok: true, ...publicRoom(room) });
  });

  /** Visual compartilhado do canal (tema + balões + papel de parede) */
  const VISUAL_BASE_BUBBLES = new Set(['classic', 'soft', 'candy', 'ghost']);
  const VISUAL_ROSE_BUBBLES = new Set(['petal', 'blush', 'bow', 'heart']);
  const VISUAL_BUBBLES = new Set([...VISUAL_BASE_BUBBLES, ...VISUAL_ROSE_BUBBLES]);
  const VISUAL_THEMES = new Set(['paper', 'ocean', 'rose', 'dusk', 'night']);
  const ROSE_BUBBLE_DEFAULT = 'petal';
  const clampVisual = (n, min, max, fallback) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  };
  const pickVisualBubble = (id, fallback = 'classic') =>
    VISUAL_BUBBLES.has(id) ? id : fallback;
  const pickVisualTheme = (id, fallback = 'paper') =>
    VISUAL_THEMES.has(id) ? id : fallback;
  const isWallLockedTheme = (theme) => theme === 'paper' || theme === 'rose';
  const coerceBubblesForTheme = (theme, bubbleMe, bubbleThem) => {
    if (theme === 'paper') return { bubbleMe: 'classic', bubbleThem: 'classic' };
    if (theme === 'rose') {
      return {
        bubbleMe: VISUAL_ROSE_BUBBLES.has(bubbleMe) ? bubbleMe : ROSE_BUBBLE_DEFAULT,
        bubbleThem: VISUAL_ROSE_BUBBLES.has(bubbleThem) ? bubbleThem : ROSE_BUBBLE_DEFAULT,
      };
    }
    return {
      bubbleMe: VISUAL_BASE_BUBBLES.has(bubbleMe) ? bubbleMe : 'classic',
      bubbleThem: VISUAL_BASE_BUBBLES.has(bubbleThem) ? bubbleThem : 'classic',
    };
  };

  app.get('/api/deck/comms/:code/visual', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    if (!room.visual) {
      res.json({ ok: true, visual: null });
      return;
    }
    res.json({
      ok: true,
      visual: {
        by: room.visual.by || '',
        name: room.visual.name || '',
        at: room.visual.at || 0,
        theme: room.visual.theme || 'paper',
        bubbleMe: room.visual.bubbleMe || 'classic',
        bubbleThem: room.visual.bubbleThem || 'classic',
        wallX: room.visual.wallX ?? 50,
        wallY: room.visual.wallY ?? 50,
        wallZoom: room.visual.wallZoom ?? 1,
        wallpaper: room.visual.wallpaper || null,
      },
    });
  });

  app.post('/api/deck/comms/:code/visual', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    if (req.body?.visual === null) {
      room.visual = null;
      room.wallpaper = null;
      room.updated = Date.now();
      pushSys(room, `${peer.name} resetou o visual do canal`);
      res.json({ ok: true, visual: null, ...publicRoom(room) });
      return;
    }

    let wallpaper = null;
    const raw = req.body?.wallpaper;
    if (raw === null || raw === '') {
      wallpaper = null;
    } else if (raw != null) {
      const data = String(raw || '');
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(data)) {
        res.status(400).json({ ok: false, error: 'imagem inválida' });
        return;
      }
      if (data.length > 450000) {
        res.status(400).json({ ok: false, error: 'imagem grande demais · escolhe outra mais leve' });
        return;
      }
      wallpaper = data;
    } else if (room.visual?.wallpaper) {
      wallpaper = room.visual.wallpaper;
    }

    room.visual = {
      by: peer.id,
      name: peer.name,
      at: Date.now(),
      theme: pickVisualTheme(req.body?.theme, room.visual?.theme || 'paper'),
      bubbleMe: pickVisualBubble(req.body?.bubbleMe, room.visual?.bubbleMe || 'classic'),
      bubbleThem: pickVisualBubble(req.body?.bubbleThem, room.visual?.bubbleThem || 'classic'),
      wallpaper,
      wallX: clampVisual(req.body?.wallX, 0, 100, room.visual?.wallX ?? 50),
      wallY: clampVisual(req.body?.wallY, 0, 100, room.visual?.wallY ?? 50),
      wallZoom: clampVisual(req.body?.wallZoom, 1, 2.5, room.visual?.wallZoom ?? 1),
    };
    /* papel / rosa: sem wallpaper · balões coerentes com o tema */
    if (isWallLockedTheme(room.visual.theme)) {
      room.visual.wallpaper = null;
      room.visual.wallX = 50;
      room.visual.wallY = 50;
      room.visual.wallZoom = 1;
      wallpaper = null;
    }
    const coerced = coerceBubblesForTheme(
      room.visual.theme,
      room.visual.bubbleMe,
      room.visual.bubbleThem
    );
    room.visual.bubbleMe = coerced.bubbleMe;
    room.visual.bubbleThem = coerced.bubbleThem;
    /* espelha no campo antigo pra clientes velhos ainda verem o fundo */
    room.wallpaper = wallpaper
      ? {
          data: wallpaper,
          by: peer.id,
          name: peer.name,
          at: room.visual.at,
          wallX: room.visual.wallX,
          wallY: room.visual.wallY,
          wallZoom: room.visual.wallZoom,
        }
      : null;
    room.updated = Date.now();
    const admPreset = !!(req.body?.adm || req.body?.preset === 'adm');
    pushSys(
      room,
      admPreset
        ? `${peer.name} aplicou o visual do adm`
        : `${peer.name} aplicou o visual pra todo o canal`
    );
    const fullVisual = {
      by: room.visual.by,
      name: room.visual.name,
      at: room.visual.at,
      theme: room.visual.theme,
      bubbleMe: room.visual.bubbleMe,
      bubbleThem: room.visual.bubbleThem,
      wallX: room.visual.wallX,
      wallY: room.visual.wallY,
      wallZoom: room.visual.wallZoom,
      hasWall: !!room.visual.wallpaper,
      wallpaper: room.visual.wallpaper,
    };
    res.json({
      ok: true,
      ...publicRoom(room),
      /* por cima do publicRoom — precisa incluir o wallpaper pra quem aplicou */
      visual: fullVisual,
    });
  });

  /** Foto de perfil do peer (fora do poll pra não inflar presence) */
  app.get('/api/deck/comms/:code/avatar/:peerId', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peerId = String(req.params.peerId || '');
    const peer = findPeer(room, peerId);
    const url = peerAvatarUrl(peer);
    if (url) {
      res.json({
        ok: true,
        avatar: null,
        avatarUrl: url,
        avatarAt: Number(peer.avatarAt) || 0,
      });
      return;
    }
    if (!peer?.avatar) {
      res.json({ ok: true, avatar: null, avatarUrl: null, avatarAt: 0 });
      return;
    }
    res.json({
      ok: true,
      avatar: peer.avatar,
      avatarUrl: null,
      avatarAt: Number(peer.avatarAt) || 0,
    });
  });

  /** Papel de parede compartilhado do canal (compat + GET da imagem) */
  app.get('/api/deck/comms/:code/wallpaper', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const wall = room.visual?.wallpaper || room.wallpaper?.data;
    if (!wall) {
      res.json({ ok: true, wallpaper: null });
      return;
    }
    const meta = room.visual || room.wallpaper || {};
    res.json({
      ok: true,
      wallpaper: {
        data: wall,
        by: meta.by || '',
        name: meta.name || '',
        at: meta.at || 0,
        wallX: meta.wallX ?? 50,
        wallY: meta.wallY ?? 50,
        wallZoom: meta.wallZoom ?? 1,
      },
    });
  });

  app.post('/api/deck/comms/:code/wallpaper', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
      res.status(404).json({ ok: false, error: 'Canal offline.' });
      return;
    }
    const peer = findPeer(room, req.body?.peerId);
    if (!peer) {
      res.status(403).json({ ok: false, error: 'Peer inválido.', rejoin: true });
      return;
    }
    const raw = req.body?.wallpaper;
    const nextTheme = pickVisualTheme(req.body?.theme, room.visual?.theme || 'paper');
    if (isWallLockedTheme(nextTheme) && raw !== null && raw !== '') {
      res.status(400).json({
        ok: false,
        error:
          nextTheme === 'rose'
            ? 'tema rosa · wallpaper bloqueado · só balões fofos'
            : 'tema papel · wallpaper bloqueado · só balão clássico',
      });
      return;
    }
    if (raw === null || raw === '') {
      if (room.visual) {
        room.visual = {
          ...room.visual,
          wallpaper: null,
          at: Date.now(),
          by: peer.id,
          name: peer.name,
        };
      }
      room.wallpaper = null;
      room.updated = Date.now();
      pushSys(room, `${peer.name} tirou o papel de parede do canal`);
      res.json({ ok: true, wallpaper: null, ...publicRoom(room) });
      return;
    }
    const data = String(raw || '');
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(data)) {
      res.status(400).json({ ok: false, error: 'imagem inválida' });
      return;
    }
    if (data.length > 450000) {
      res.status(400).json({ ok: false, error: 'imagem grande demais · escolhe outra mais leve' });
      return;
    }
    const wallX = clampVisual(req.body?.wallX, 0, 100, 50);
    const wallY = clampVisual(req.body?.wallY, 0, 100, 50);
    const wallZoom = clampVisual(req.body?.wallZoom, 1, 2.5, 1);
    const at = Date.now();
    room.wallpaper = {
      data,
      by: peer.id,
      name: peer.name,
      at,
      wallX,
      wallY,
      wallZoom,
    };
    room.visual = {
      by: peer.id,
      name: peer.name,
      at,
      theme: pickVisualTheme(req.body?.theme, room.visual?.theme || 'paper'),
      bubbleMe: pickVisualBubble(req.body?.bubbleMe, room.visual?.bubbleMe || 'classic'),
      bubbleThem: pickVisualBubble(req.body?.bubbleThem, room.visual?.bubbleThem || 'classic'),
      wallpaper: data,
      wallX,
      wallY,
      wallZoom,
    };
    room.updated = Date.now();
    pushSys(room, `${peer.name} mudou o papel de parede do canal`);
    res.json({
      ok: true,
      wallpaper: {
        data: room.wallpaper.data,
        by: room.wallpaper.by,
        name: room.wallpaper.name,
        at: room.wallpaper.at,
        wallX: room.wallpaper.wallX,
        wallY: room.wallpaper.wallY,
        wallZoom: room.wallpaper.wallZoom,
      },
      ...publicRoom(room),
    });
  });
}

module.exports = {
  mountCommsRoutes,
  getRoom,
  findPeer,
  pushSys,
  scheduleSaveRooms,
};
