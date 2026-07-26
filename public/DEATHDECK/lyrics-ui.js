/**
 * Painel de letras (COMMS).
 * Sync LRC quando houver; plain/synced + botão → viz wave.
 */
(() => {
  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function createPanel(rootId) {
    const root = document.getElementById(rootId);
    if (!root) {
      return {
        load: async () => {},
        clear: () => {},
        tick: () => {},
        stop: () => {},
      };
    }
    const body = root.querySelector('.lyrics-body') || document.getElementById(`${rootId}Body`);
    const unsyncBtn =
      root.querySelector('.lyrics-unsync-btn') || document.getElementById(`${rootId}UnsyncBtn`);

    let synced = [];
    let plain = '';
    let mode = 'idle';
    let view = 'lyrics'; /* lyrics | viz */
    let activeIdx = -1;
    let timer = 0;
    let getPos = null;
    let isPlayingFn = null;
    let getWaveformFn = null;
    let lyricsLead = 0.2; /* adiantar highlight vs áudio (s) */
    let loadToken = 0;
    let vizRaf = 0;
    let lastPos = -1;
    let lastPosAt = 0;
    let playingGuess = false;
    let smoothEnergy = 0.35;

    function bindClock(clock) {
      if (typeof clock === 'function') {
        getPos = clock;
        isPlayingFn = null;
        getWaveformFn = null;
        lyricsLead = 0.2;
        return;
      }
      if (clock && typeof clock === 'object') {
        getPos = typeof clock.getPos === 'function' ? clock.getPos : null;
        isPlayingFn = typeof clock.isPlaying === 'function' ? clock.isPlaying : null;
        getWaveformFn =
          typeof clock.getWaveform === 'function'
            ? clock.getWaveform
            : typeof clock.getSpectrum === 'function'
              ? clock.getSpectrum
              : null;
        const lead = Number(clock.lead ?? clock.leadSec);
        lyricsLead = Number.isFinite(lead) ? Math.max(0, Math.min(2.5, lead)) : 0.2;
        return;
      }
      getPos = null;
      isPlayingFn = null;
      getWaveformFn = null;
      lyricsLead = 0.2;
    }

    function setUnsyncBtn(visible) {
      if (!unsyncBtn) return;
      unsyncBtn.hidden = !visible;
      if (!visible) {
        view = 'lyrics';
        unsyncBtn.textContent = 'letras não sincronizadas?';
        unsyncBtn.classList.remove('on');
        root.classList.remove('lyrics-viz-on');
      }
    }

    function show(msg, cls = '') {
      root.hidden = false;
      setUnsyncBtn(false);
      stopViz();
      if (body) body.innerHTML = `<p class="lyrics-status ${cls}">${escapeHtml(msg)}</p>`;
    }

    function clear() {
      loadToken += 1;
      stop();
      stopViz();
      synced = [];
      plain = '';
      mode = 'idle';
      view = 'lyrics';
      activeIdx = -1;
      bindClock(null);
      setUnsyncBtn(false);
      root.hidden = true;
      if (body) body.innerHTML = '';
    }

    function stop() {
      if (timer) {
        clearInterval(timer);
        timer = 0;
      }
    }

    function stopViz() {
      if (vizRaf) {
        cancelAnimationFrame(vizRaf);
        vizRaf = 0;
      }
    }

    function cleanLine(s) {
      return String(s || '')
        .replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
        .replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    function markLyricsView() {
      view = 'lyrics';
      stopViz();
      root.classList.remove('lyrics-viz-on');
      if (unsyncBtn) {
        unsyncBtn.textContent = 'letras não sincronizadas?';
        unsyncBtn.classList.remove('on');
      }
      setUnsyncBtn(true);
    }

    function renderPlain() {
      mode = 'plain';
      markLyricsView();
      if (!body) return;
      const lines = String(plain || '')
        .split('\n')
        .map((l) => cleanLine(l))
        .filter(Boolean);
      body.innerHTML = lines.map((l) => `<p class="lyrics-line">${escapeHtml(l)}</p>`).join('');
    }

    function renderSyncedShell() {
      mode = 'synced';
      markLyricsView();
      activeIdx = -1;
      if (!body) return;
      body.innerHTML = synced
        .map((l, i) => {
          const text = cleanLine(l.text);
          if (!text) return '';
          return `<p class="lyrics-line" data-i="${i}" data-t="${l.t}">${escapeHtml(text)}</p>`;
        })
        .filter(Boolean)
        .join('');
    }

    function restoreLyrics() {
      if (mode === 'synced' && synced.length >= 2) {
        renderSyncedShell();
        if (typeof getPos === 'function') {
          tick();
          if (!timer) timer = setInterval(tick, 120);
        }
        return;
      }
      if (plain) {
        renderPlain();
        return;
      }
      setUnsyncBtn(false);
    }

    function drawIdle(ctx, w, h) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(244,241,234,0.12)';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.5);
      ctx.lineTo(w, h * 0.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(244,241,234,0.28)';
      ctx.font = '11px Courier New, monospace';
      const label = 'viz idle · dá play';
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, Math.max(10, (w - tw) / 2), h * 0.5 + 4);
    }

    /* YT / fallback: onda amarrada ao tempo da faixa */
    function musicWave(pos, energy, n) {
      const out = new Uint8Array(n);
      const e = Math.max(0.15, Math.min(1.2, energy));
      for (let i = 0; i < n; i++) {
        const x = i / n;
        const y =
          Math.sin(pos * 6.2 + x * 14) * 38 * e +
          Math.sin(pos * 13.1 + x * 31) * 18 * e +
          Math.sin(pos * 2.4 + x * 5.5) * 12;
        out[i] = Math.max(0, Math.min(255, 128 + y));
      }
      return out;
    }

    function drawWave(ctx, w, h, data) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, w, h);
      if (!data || !data.length) return;
      ctx.beginPath();
      const mid = h * 0.5;
      const len = data.length;
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * w;
        const y = mid + ((data[i] - 128) / 128) * (h * 0.42);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#f4f1ea';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    function readPos() {
      if (typeof getPos !== 'function') return 0;
      try {
        return Number(getPos()) || 0;
      } catch {
        return 0;
      }
    }

    function updatePlayingGuess() {
      const now = performance.now();
      const pos = readPos();

      if (typeof isPlayingFn === 'function') {
        try {
          playingGuess = !!isPlayingFn();
        } catch {
          playingGuess = false;
        }
        if (playingGuess) {
          const dt = Math.max(0.001, (now - lastPosAt) / 1000);
          const vel = lastPos >= 0 ? Math.abs(pos - lastPos) / dt : 1;
          const punch = Math.max(0.2, Math.min(1.35, vel));
          smoothEnergy += (punch - smoothEnergy) * 0.2;
          lastPosAt = now;
        } else {
          smoothEnergy += (0.08 - smoothEnergy) * 0.15;
        }
        lastPos = pos;
        return pos;
      }

      if (typeof getPos !== 'function') {
        playingGuess = false;
        return pos;
      }
      if (lastPos < 0) {
        lastPos = pos;
        lastPosAt = now;
        return pos;
      }
      const advanced = pos > lastPos + 0.002;
      const seeked = Math.abs(pos - lastPos) > 1.2;
      if (advanced || seeked) {
        playingGuess = true;
        const dt = Math.max(0.001, (now - lastPosAt) / 1000);
        const vel = Math.abs(pos - lastPos) / dt;
        smoothEnergy += (Math.max(0.25, Math.min(1.3, vel)) - smoothEnergy) * 0.25;
        lastPosAt = now;
      } else if (now - lastPosAt > 750) {
        playingGuess = false;
        smoothEnergy += (0.08 - smoothEnergy) * 0.2;
      }
      lastPos = pos;
      return pos;
    }

    function resizeVizCanvas(canvas) {
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || 320;
      const h = canvas.clientHeight || 96;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function tickViz() {
      if (view !== 'viz') {
        vizRaf = 0;
        return;
      }
      const canvas = body?.querySelector('#commsLyricsViz');
      if (!canvas) {
        vizRaf = 0;
        return;
      }
      const ctx = canvas.getContext('2d');
      const w = canvas.clientWidth || 320;
      const h = canvas.clientHeight || 96;
      const pos = updatePlayingGuess();
      if (!playingGuess) {
        drawIdle(ctx, w, h);
      } else {
        let data = null;
        if (typeof getWaveformFn === 'function') {
          try {
            data = getWaveformFn();
          } catch {
            data = null;
          }
        }
        if (data && data.length) {
          drawWave(ctx, w, h, data);
        } else {
          drawWave(ctx, w, h, musicWave(pos, smoothEnergy, 128));
        }
      }
      vizRaf = requestAnimationFrame(tickViz);
    }

    function startViz() {
      stopViz();
      const canvas = body?.querySelector('#commsLyricsViz');
      resizeVizCanvas(canvas);
      lastPos = -1;
      lastPosAt = 0;
      playingGuess = false;
      smoothEnergy = 0.4;
      requestAnimationFrame(() => {
        resizeVizCanvas(body?.querySelector('#commsLyricsViz'));
        if (!vizRaf && view === 'viz') {
          vizRaf = requestAnimationFrame(tickViz);
        }
      });
      vizRaf = requestAnimationFrame(tickViz);
    }

    function renderVizShell() {
      if (!body) return;
      if (mode !== 'synced' && mode !== 'plain') return;
      view = 'viz';
      root.classList.add('lyrics-viz-on');
      if (unsyncBtn) {
        unsyncBtn.textContent = 'ver letras';
        unsyncBtn.classList.add('on');
        unsyncBtn.hidden = false;
      }
      body.innerHTML = `
        <div class="lyrics-viz-wrap">
          <canvas id="commsLyricsViz" class="lyrics-viz-canvas" aria-hidden="true"></canvas>
        </div>`;
      startViz();
    }

    function highlight(idx) {
      if (!body || mode !== 'synced' || view !== 'lyrics') return;
      if (idx === activeIdx) return;
      const prev = body.querySelector('.lyrics-line.on');
      if (prev) prev.classList.remove('on');
      const el = body.querySelector(`.lyrics-line[data-i="${idx}"]`);
      if (el) {
        el.classList.add('on');
        try {
          el.scrollIntoView({ block: 'center', behavior: 'auto' });
        } catch {
          /* ignore */
        }
      }
      activeIdx = idx;
    }

    function tick() {
      if (mode !== 'synced' || !synced.length || typeof getPos !== 'function') return;
      let pos = 0;
      try {
        pos = Number(getPos()) || 0;
      } catch {
        return;
      }
      /* lead: legendas acompanham o ouvido (Spotify/stream atrasam o clock) */
      pos += lyricsLead;
      let idx = 0;
      for (let i = 0; i < synced.length; i++) {
        if (synced[i].t <= pos + 0.05) idx = i;
        else break;
      }
      highlight(idx);
    }

    function startSync(clock) {
      stop();
      bindClock(clock);
      if (mode !== 'synced' || !synced.length) return;
      tick();
      timer = setInterval(tick, 120);
    }

    async function load(query, clock) {
      const token = ++loadToken;
      const track = String(query?.track || '').trim();
      if (!track) {
        clear();
        return;
      }
      root.hidden = false;
      bindClock(clock);
      show('buscando letra…', 'loading');

      const params = new URLSearchParams();
      params.set('track', track.slice(0, 120));
      if (query.artist) params.set('artist', String(query.artist).slice(0, 120));
      if (query.album) params.set('album', String(query.album).slice(0, 120));
      if (query.duration) params.set('duration', String(Math.round(Number(query.duration) || 0)));

      let data = null;
      try {
        const res = await fetch(`/api/deck/lyrics?${params}`);
        data = await res.json();
      } catch {
        if (token !== loadToken) return;
        show('falha ao buscar letra');
        return;
      }
      if (token !== loadToken) return;

      if (!data?.ok) {
        show(data?.error || 'letra não encontrada');
        return;
      }
      if (data.instrumental) {
        show('instrumental · sem letra');
        return;
      }

      synced = Array.isArray(data.synced) ? data.synced : [];
      plain = String(data.plain || '');
      bindClock(clock);

      if (synced.length >= 2) {
        renderSyncedShell();
        startSync(clock);
      } else if (plain) {
        renderPlain();
      } else {
        show('letra não encontrada');
      }
    }

    if (unsyncBtn && !unsyncBtn.dataset.bound) {
      unsyncBtn.dataset.bound = '1';
      unsyncBtn.addEventListener('click', () => {
        if (mode !== 'synced' && mode !== 'plain') return;
        if (view === 'viz') restoreLyrics();
        else renderVizShell();
      });
    }

    window.addEventListener('resize', () => {
      if (view === 'viz') resizeVizCanvas(body?.querySelector('#commsLyricsViz'));
    });

    try {
      const mo = new MutationObserver(() => {
        if (view !== 'viz') return;
        requestAnimationFrame(() => {
          resizeVizCanvas(body?.querySelector('#commsLyricsViz'));
        });
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch {
      /* ignore */
    }

    return { load, clear, tick, stop, startSync };
  }

  window.DeckLyrics = {
    createPanel,
    parseTitle(raw) {
      let s = String(raw || '').trim();
      if (!s) return { track: '', artist: '' };

      s = s
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(
          /\b(official\s*(music\s*)?video|official\s*audio|lyrics?\s*video|lyric\s*video|audio\s*oficial|clipe\s*oficial|mv|hd|4k|8k|remaster(?:ed)?|topic|visualizer|live|ao\s*vivo|dvd|full\s*album|hour\s*version)\b/gi,
          ' '
        )
        .replace(/\s*[|/·•]\s*/g, ' - ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      const parts = s.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        return { artist: parts[0], track: parts[1] };
      }
      return { track: s, artist: '' };
    },
  };
})();
