const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { askRig, loadGeminiConfig } = require('../gemini');
const { mountCommsRoutes } = require('./comms');
const { mountDeathmetalRoutes } = require('./deathmetal');
const { mountLyricsRoutes } = require('./lyrics');
const { mountSpotifyRoutes } = require('./spotify');

const ROOT = __dirname;
const INTEL_PY = path.join(ROOT, 'intel.py');
const VAULT_FILE = path.join(ROOT, 'vault.json');

function runIntel(payload) {
  return new Promise((resolve) => {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(py, [INTEL_PY], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: 'Timeout no módulo Python.' });
    }, 12000);

    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      err += c.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: `Python indisponível (${e.message}). Instale Python e tente de novo.`,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        resolve({ ok: false, error: err.trim() || `Python saiu com código ${code}` });
        return;
      }
      try {
        resolve(JSON.parse(out.trim() || '{}'));
      } catch {
        resolve({ ok: false, error: 'Resposta Python inválida.', raw: out.slice(0, 400) });
      }
    });

    child.stdin.write(JSON.stringify(payload || {}));
    child.stdin.end();
  });
}

function loadVault() {
  try {
    if (!fs.existsSync(VAULT_FILE)) {
      const seed = {
        notes: [
          {
            id: 'n1',
            title: 'BOOT LOG',
            body: 'Deck online. Operador: adri16bit.\nMódulos carregados. Black ICE em standby.',
            at: Date.now(),
          },
          {
            id: 'n2',
            title: 'CONTRACT-07',
            body: 'Alvo: NEON-GATE\nObjetivo: extrair fingerprint e confirmar rota GRID.\nPagamento: 3.2k eddies.',
            at: Date.now() - 86400000,
          },
        ],
      };
      fs.writeFileSync(VAULT_FILE, JSON.stringify(seed, null, 2), 'utf8');
      return seed;
    }
    return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  } catch {
    return { notes: [] };
  }
}

function saveVault(data) {
  fs.writeFileSync(VAULT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function mountCyberdeckRoutes(app) {
  app.get('/api/deck/status', async (_req, res) => {
    const boot = await runIntel({ op: 'boot' });
    res.json({
      ok: true,
      runtime: 'node+python',
      python: boot.ok,
      boot: boot.ok ? boot.data : null,
      error: boot.ok ? null : boot.error,
    });
  });

  app.post('/api/deck/intel', async (req, res) => {
    try {
      const result = await runIntel(req.body || {});
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || 'Erro interno' });
    }
  });

  app.get('/api/deck/vault', (_req, res) => {
    res.json({ ok: true, ...loadVault() });
  });

  app.post('/api/deck/vault', (req, res) => {
    try {
      const vault = loadVault();
      const title = String(req.body?.title || 'NOTE').slice(0, 80);
      const body = String(req.body?.body || '').slice(0, 4000);
      const note = {
        id: `n${Date.now()}`,
        title,
        body,
        at: Date.now(),
      };
      vault.notes = [note, ...(vault.notes || [])].slice(0, 40);
      saveVault(vault);
      res.json({ ok: true, note, notes: vault.notes });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || 'Erro ao salvar' });
    }
  });

  app.delete('/api/deck/vault/:id', (req, res) => {
    const vault = loadVault();
    vault.notes = (vault.notes || []).filter((n) => n.id !== req.params.id);
    saveVault(vault);
    res.json({ ok: true, notes: vault.notes });
  });

  app.get('/api/deck/ai/status', (_req, res) => {
    const cfg = loadGeminiConfig();
    res.json({
      ok: true,
      ready: !!cfg.apiKey,
      model: cfg.model,
      name: 'CD-R',
      deck: 'PANCHIKO / D>E>A>T>H>D>E>C>K',
    });
  });

  app.post('/api/deck/ai/chat', async (req, res) => {
    try {
      const message = String(req.body?.message || '').trim();
      const history = Array.isArray(req.body?.history) ? req.body.history : [];
      if (!message) {
        res.status(400).json({ ok: false, error: 'Mensagem vazia.' });
        return;
      }
      if (message.length > 4000) {
        res.status(400).json({ ok: false, error: 'Mensagem longa demais.' });
        return;
      }
      const result = await askRig(message, history);
      if (!result.ok) {
        res.status(502).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || 'Erro interno' });
    }
  });

  mountCommsRoutes(app);
  mountDeathmetalRoutes(app);
  mountLyricsRoutes(app);
  mountSpotifyRoutes(app);
}

module.exports = { mountCyberdeckRoutes, runIntel };
