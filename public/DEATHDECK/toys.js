(() => {
  const XP_KEY = 'voidwire-xp';
  let xp = Number(localStorage.getItem(XP_KEY) || 0) || 0;

  function bumpXp(n = 1) {
    xp += n;
    localStorage.setItem(XP_KEY, String(xp));
    const chip = document.getElementById('xpChip');
    if (chip) chip.textContent = `XP ${xp}`;
  }

  function syncXp() {
    const chip = document.getElementById('xpChip');
    if (chip) chip.textContent = `XP ${xp}`;
  }

  /* homeField canvas removido — não anima mais no HOME */

  /* —— Scope particles —— */
  const Scope = (() => {
    let canvas, ctx, raf, running = false;
    let particles = [];
    let gravity = 0.04;
    let pointer = { x: 0, y: 0, down: false };

    function spawn(x, y, n = 18) {
      for (let i = 0; i < n; i++) {
        particles.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 6,
          vy: (Math.random() - 0.5) * 6,
          life: 1,
          hue: Math.random() > 0.5 ? '#c6f000' : '#e8a35a',
        });
      }
      bumpXp(1);
    }

    function loop() {
      if (!running) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = 'rgba(5,4,3,0.28)';
      ctx.fillRect(0, 0, w, h);
      if (pointer.down) spawn(pointer.x, pointer.y, 4);
      for (const p of particles) {
        p.vy += gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.008;
        const dx = pointer.x - p.x;
        const dy = pointer.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        p.vx += (dx / d) * 0.08;
        p.vy += (dy / d) * 0.08;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.hue;
        ctx.fillRect(p.x, p.y, 2, 2);
      }
      ctx.globalAlpha = 1;
      particles = particles.filter((p) => p.life > 0 && p.y < h + 40);
      const info = document.getElementById('scopeInfo');
      if (info) info.textContent = `${particles.length} particles · g ${gravity.toFixed(2)}`;
      raf = requestAnimationFrame(loop);
    }

    function pos(e) {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width;
      const sy = canvas.height / rect.height;
      const cx = e.clientX ?? e.touches?.[0]?.clientX;
      const cy = e.clientY ?? e.touches?.[0]?.clientY;
      pointer.x = (cx - rect.left) * sx;
      pointer.y = (cy - rect.top) * sy;
    }

    return {
      start() {
        canvas = document.getElementById('scopeCanvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        running = true;
        canvas.onpointerdown = (e) => {
          pointer.down = true;
          pos(e);
          spawn(pointer.x, pointer.y, 30);
          canvas.setPointerCapture(e.pointerId);
        };
        canvas.onpointermove = (e) => pos(e);
        canvas.onpointerup = () => {
          pointer.down = false;
        };
        canvas.onwheel = (e) => {
          e.preventDefault();
          gravity = Math.max(-0.2, Math.min(0.25, gravity + e.deltaY * 0.0004));
        };
        const burst = document.getElementById('scopeBurst');
        if (burst) {
          burst.onclick = () => spawn(canvas.width / 2, canvas.height / 2, 80);
        }
        const clearBtn = document.getElementById('scopeClear');
        if (clearBtn) {
          clearBtn.onclick = () => {
            particles = [];
          };
        }
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(loop);
      },
      stop() {
        running = false;
        cancelAnimationFrame(raf);
      },
    };
  })();

  /* —— Ink pixel pad —— */
  const Ink = (() => {
    const GRID = 24;
    let canvas, ctx;
    let cells;
    let color = '#c6f000';
    let mode = 'pen';
    let drawing = false;

    function idx(x, y) {
      return y * GRID + x;
    }

    function paint(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor(((cx - rect.left) / rect.width) * GRID);
      const y = Math.floor(((cy - rect.top) / rect.height) * GRID);
      if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
      cells[idx(x, y)] = mode === 'erase' ? null : color;
      draw();
      if (Math.random() < 0.08) bumpXp(1);
    }

    function draw() {
      const s = canvas.width / GRID;
      ctx.fillStyle = '#0a0908';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          const c = cells[idx(x, y)];
          if (c) {
            ctx.fillStyle = c;
            ctx.fillRect(x * s, y * s, s, s);
          }
          ctx.strokeStyle = 'rgba(196,122,58,0.15)';
          ctx.strokeRect(x * s, y * s, s, s);
        }
      }
    }

    return {
      start() {
        canvas = document.getElementById('inkCanvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        if (!cells) cells = Array(GRID * GRID).fill(null);
        color = document.getElementById('inkColor')?.value || color;
        draw();
        canvas.onpointerdown = (e) => {
          drawing = true;
          paint(e.clientX, e.clientY);
          canvas.setPointerCapture(e.pointerId);
        };
        canvas.onpointermove = (e) => {
          if (drawing) paint(e.clientX, e.clientY);
        };
        canvas.onpointerup = () => {
          drawing = false;
        };
        const inkColor = document.getElementById('inkColor');
        if (inkColor) {
          inkColor.oninput = (e) => {
            color = e.target.value;
          };
        }
        document.querySelectorAll('[data-ink]').forEach((b) => {
          b.onclick = () => {
            mode = b.dataset.ink;
          };
        });
        const inkClear = document.getElementById('inkClear');
        if (inkClear) {
          inkClear.onclick = () => {
            cells = Array(GRID * GRID).fill(null);
            draw();
          };
        }
        const inkSave = document.getElementById('inkSave');
        if (inkSave) {
          inkSave.onclick = () => {
            const a = document.createElement('a');
            a.download = `rig-sprite-${Date.now()}.png`;
            a.href = canvas.toDataURL('image/png');
            a.click();
            bumpXp(5);
          };
        }
      },
      stop() {},
    };
  })();

  /* —— Radar —— */
  const Radar = (() => {
    let canvas, ctx, raf, running = false;
    let angle = 0;
    let ping = 0;
    let blips = [];
    let locked = null;

    function spawn() {
      const a = Math.random() * Math.PI * 2;
      const r = 40 + Math.random() * 140;
      blips.push({
        a,
        r,
        id: `B${Math.floor(Math.random() * 900 + 100)}`,
        speed: (Math.random() - 0.5) * 0.01,
      });
      bumpXp(1);
      updateInfo();
    }

    function updateInfo() {
      const el = document.getElementById('radarInfo');
      if (el) el.textContent = `${blips.length} contacts${locked ? ` · LOCK ${locked.id}` : ''}`;
    }

    function loop() {
      if (!running) return;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      ctx.fillStyle = '#050403';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(198,240,0,0.25)';
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, i * 40, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, h);
      ctx.moveTo(0, cy);
      ctx.lineTo(w, cy);
      ctx.stroke();

      angle += 0.025;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, 170, angle - 0.4, angle);
      ctx.closePath();
      ctx.fillStyle = 'rgba(198,240,0,0.12)';
      ctx.fill();

      if (ping > 0) {
        ping -= 0.02;
        ctx.beginPath();
        ctx.arc(cx, cy, (1 - ping) * 170, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(232,163,90,${ping})`;
        ctx.stroke();
      }

      for (const b of blips) {
        b.a += b.speed;
        const sweepDiff = Math.abs(((b.a - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const visible = ping > 0.2 || sweepDiff < 0.55 || b === locked;
        if (!visible) continue;
        const x = cx + Math.cos(b.a) * b.r;
        const y = cy + Math.sin(b.a) * b.r;
        ctx.fillStyle = b === locked ? '#e4572e' : '#c6f000';
        ctx.beginPath();
        ctx.arc(x, y, b === locked ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#f3ebe1';
        ctx.font = '10px IBM Plex Mono';
        ctx.fillText(b.id, x + 6, y + 3);
      }
      raf = requestAnimationFrame(loop);
    }

    return {
      start() {
        canvas = document.getElementById('radarCanvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        running = true;
        if (!blips.length) {
          for (let i = 0; i < 5; i++) spawn();
        }
        const radarPing = document.getElementById('radarPing');
        if (radarPing) {
          radarPing.onclick = () => {
            ping = 1;
            bumpXp(2);
          };
        }
        const radarSpawn = document.getElementById('radarSpawn');
        if (radarSpawn) radarSpawn.onclick = spawn;
        canvas.onclick = (e) => {
          const rect = canvas.getBoundingClientRect();
          const sx = canvas.width / rect.width;
          const sy = canvas.height / rect.height;
          const x = (e.clientX - rect.left) * sx;
          const y = (e.clientY - rect.top) * sy;
          const cx = canvas.width / 2;
          const cy = canvas.height / 2;
          locked = null;
          for (const b of blips) {
            const bx = cx + Math.cos(b.a) * b.r;
            const by = cy + Math.sin(b.a) * b.r;
            if (Math.hypot(bx - x, by - y) < 14) {
              locked = b;
              bumpXp(3);
              break;
            }
          }
          updateInfo();
        };
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(loop);
      },
      stop() {
        running = false;
        cancelAnimationFrame(raf);
      },
    };
  })();

  /* —— FX + extras —— */
  function wireExtras() {
    const FX = {
      rot: 1400,
      skip: 600,
      scan: 1600,
      bleach: 900,
      shake: 550,
      static: 900,
      melt: 1200,
    };
    let clearTimer = 0;
    const layer = () => document.getElementById('fxLayer');

    function clearFx() {
      [...document.body.classList]
        .filter((c) => c.startsWith('fx-'))
        .forEach((c) => document.body.classList.remove(c));
      document.querySelectorAll('.fx-btn.on').forEach((b) => b.classList.remove('on'));
      layer()?.classList.remove('on');
    }

    function playFx(name) {
      if (!FX[name]) return;
      clearTimeout(clearTimer);
      clearFx();
      document.body.classList.add(`fx-${name}`);
      layer()?.classList.add('on');
      const btn = document.querySelector(`.fx-btn[data-fx="${name}"]`);
      btn?.classList.add('on');
      bumpXp(2);
      // micro glitch no chassis junto
      const rig = document.getElementById('rig');
      rig?.classList.add('glitching');
      setTimeout(() => rig?.classList.remove('glitching'), 280);
      clearTimer = setTimeout(clearFx, FX[name]);
    }

    document.getElementById('fxActions')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-fx]');
      if (!btn) return;
      playFx(btn.dataset.fx);
    });

    // fallback se ainda existir botão antigo
    document.getElementById('glitchBtn')?.addEventListener('click', () => playFx('rot'));

    const pad = document.getElementById('nesPad');
    if (pad) {
      const fire = (code, type) => {
        window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
      };
      pad.querySelectorAll('[data-key]').forEach((btn) => {
        const code = btn.dataset.key;
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          fire(code, 'keydown');
          btn.classList.add('on');
        });
        btn.addEventListener('pointerup', () => {
          fire(code, 'keyup');
          btn.classList.remove('on');
        });
        btn.addEventListener('pointerleave', () => {
          fire(code, 'keyup');
          btn.classList.remove('on');
        });
      });
    }

    document.getElementById('quickChips')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-prompt]');
      if (!b) return;
      const input = document.getElementById('aiInput');
      if (input) {
        input.value = b.dataset.prompt;
        input.focus();
      }
      bumpXp(1);
    });


  }

  const TOYS = { scope: Scope, ink: Ink, radar: Radar };

  window.DeckToys = {
    bumpXp,
    syncXp,
    wireExtras,
    activate(tab) {
      Object.entries(TOYS).forEach(([id, mod]) => {
        if (id !== tab) mod.stop();
      });
      requestAnimationFrame(() => {
        if (tab && TOYS[tab]) TOYS[tab].start();
      });
    },
    stopAll() {
      Object.values(TOYS).forEach((m) => m.stop());
    },
  };
})();
